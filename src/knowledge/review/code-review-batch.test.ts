import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../kernel/git.ts";
import { processOf } from "../../work/claims/liveness.ts";
import { hang, ws } from "../../work/testkit.ts";

setDefaultTimeout(60_000);

const SCRIPT = join(import.meta.dir, "../../../scripts/code-review.ts");
const MAIN = join(import.meta.dir, "../../invocation/main.ts");

const sh = (cwd: string, ...args: string[]) => {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

/**
 * A project whose landings are commits with a land.ok event each, plus stand-ins for the AI (it saves the prompt, counts
 * its calls and prints `answer.json`, or exits 1 while `ai-fails` exists) and for gh (it logs each call).
 */
function setup(config = "", answer: unknown = { findings: [] }) {
  const root = mkdtempSync(join(tmpdir(), "canon-batch-review-"));
  const tools = mkdtempSync(join(tmpdir(), "canon-batch-review-tools-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  mkdirSync(join(root, "canon"), { recursive: true });
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: none\n${config}`);
  writeFileSync(join(root, "app.txt"), "one\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "init");
  writeFileSync(join(tools, "answer.json"), JSON.stringify(answer));
  writeFileSync(join(tools, "ai.sh"), `echo x >> ${tools}/ai-calls\ncat > ${tools}/prompt.txt\n[ -e ${tools}/ai-fails ] && exit 1\ncat ${tools}/answer.json\n`);
  writeFileSync(
    join(tools, "gh.ts"),
    `import { appendFileSync } from "node:fs";\nconst a = process.argv.slice(2);\nappendFileSync(${JSON.stringify(join(tools, "gh.log"))}, JSON.stringify(a) + "\\n");\nif (a[0] === "issue" && a[1] === "list") console.log("[]");\nif (a[0] === "issue" && a[1] === "create") console.log("https://github.com/o/r/issues/77");\n`,
  );
  const aiCalls = () => (existsSync(join(tools, "ai-calls")) ? readFileSync(join(tools, "ai-calls"), "utf8").trim().split("\n").length : 0);
  const issues = () => (existsSync(join(tools, "gh.log")) ? readFileSync(join(tools, "gh.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((a) => a[1] === "create") : []);
  return { root, tools, aiCalls, issues };
}

type Repo = ReturnType<typeof setup>;
let counter = 0;

/** Commits `path` as a landing C-n and records its land.ok event; returns the commit, its base and the change. */
function land(r: Repo, path: string, text = "x\n") {
  const base = sh(r.root, "rev-parse", "HEAD");
  mkdirSync(join(r.root, path, ".."), { recursive: true });
  writeFileSync(join(r.root, path), text);
  sh(r.root, "add", path);
  sh(r.root, "commit", "-qm", path);
  const head = sh(r.root, "rev-parse", "HEAD");
  const change = `C-${++counter}`;
  ws(r.root).db.event("agent:a", "land.ok", change, { sha: head, base, branch: `change/${change}` });
  return { base, head, change };
}

/** `bun scripts/code-review.ts` as after_land runs it for a landing. */
function review(r: Repo, l: { base: string; head: string; change: string }, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", SCRIPT], {
    cwd: r.root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CANON_ACTOR: "agent:a", CANON_BASE: l.base, CANON_HEAD: l.head, CANON_CHANGE: l.change, CANON_CODE_REVIEW_AI: `sh ${r.tools}/ai.sh`, CANON_GH: `bun ${r.tools}/gh.ts`, ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const reviewed = (r: Repo) => {
  const x = git(r.root, "rev-parse", "--verify", "--quiet", "refs/canon/code-reviewed");
  return x.ok && x.value !== "" ? x.value : null;
};
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe("code review in batches", () => {
  it("BR-2314: 9 unreviewed landings print the deferred line, the 10th reviews all ten and moves the ref", () => {
    const r = setup();
    const first = land(r, "f0.ts");
    let last = review(r, first);
    for (let i = 1; i < 9; i++) last = review(r, land(r, `f${i}.ts`));
    expect(last.code).toBe(0);
    expect(last.out.trim()).toBe("code-review: deferred — 9 landing(s) not reviewed yet (reviewed in a batch at 10 or after 60 min)");
    expect(r.aiCalls()).toBe(0);
    expect(reviewed(r)).toBe(first.base);
    const tenth = land(r, "f9.ts");
    const done = review(r, tenth);
    expect(done.code).toBe(0);
    expect(done.out).toContain("reviewed 10 landing(s) in one batch");
    expect(r.aiCalls()).toBe(1);
    expect(reviewed(r)).toBe(tenth.head);
    expect(readFileSync(join(r.tools, "prompt.txt"), "utf8")).toContain("f0.ts");
  });

  it("BR-2314: the oldest landing 59 minutes old is deferred, 61 minutes old is reviewed", () => {
    const r = setup();
    const l = land(r, "a.ts");
    const early = review(r, l, { CANON_NOW: minutesFromNow(59) });
    expect(early.out).toContain("deferred — 1 landing(s) not reviewed yet");
    expect(r.aiCalls()).toBe(0);
    const late = review(r, l, { CANON_NOW: minutesFromNow(61) });
    expect(late.out).toContain("reviewed 1 landing(s) in one batch");
    expect(r.aiCalls()).toBe(1);
    expect(reviewed(r)).toBe(l.head);
  });

  it("BR-2314: the thresholds come from review_max_unreviewed and review_max_age_minutes", () => {
    const r = setup("review_max_unreviewed: 2\n");
    review(r, land(r, "a.ts"));
    expect(r.aiCalls()).toBe(0);
    const second = land(r, "b.ts");
    expect(review(r, second).out).toContain("reviewed 2 landing(s)");
  });

  it("BR-2314: CANON_CODE_REVIEW_FORCE=1 reviews what waits without CANON_BASE and CANON_HEAD", () => {
    const r = setup();
    const l = land(r, "a.ts");
    review(r, l);
    expect(r.aiCalls()).toBe(0);
    const p = Bun.spawnSync(["bun", SCRIPT], { cwd: r.root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a", CANON_CODE_REVIEW_FORCE: "1", CANON_CODE_REVIEW_AI: `sh ${r.tools}/ai.sh`, CANON_GH: `bun ${r.tools}/gh.ts` } });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("reviewed 1 landing(s)");
    expect(reviewed(r)).toBe(l.head);
  });

  it("BR-2315: a review that fails leaves the ref where it was, and the next run reviews the same range", () => {
    const r = setup("review_max_unreviewed: 1\n");
    writeFileSync(join(r.tools, "ai-fails"), "");
    const l = land(r, "a.ts");
    const failed = review(r, l);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("code-review:");
    expect(reviewed(r)).toBe(l.base);
    rmSyncIf(join(r.tools, "ai-fails"));
    const again = review(r, l);
    expect(again.code).toBe(0);
    expect(reviewed(r)).toBe(l.head);
    expect(r.aiCalls()).toBe(2);
  });

  it("BR-2315: with no ref the first run starts at the landing's base, so old history is not reviewed", () => {
    const r = setup();
    land(r, "old.ts");
    const l = land(r, "a.ts");
    expect(reviewed(r)).toBeNull();
    review(r, l);
    expect(reviewed(r)).toBe(l.base);
    review(r, l, { CANON_NOW: minutesFromNow(61) });
    expect(readFileSync(join(r.tools, "prompt.txt"), "utf8")).not.toContain("old.ts\n");
  });

  it("BR-2315: a range that changes only canon/ moves the ref without calling the AI", () => {
    const r = setup();
    const l = land(r, "canon/rules/x.md", "rule\n");
    const out = review(r, l);
    expect(out.out).toContain("code-review: no code changed; nothing to review");
    expect(r.aiCalls()).toBe(0);
    expect(reviewed(r)).toBe(l.head);
  });

  it("BR-2210: the issue names the range and the landings in it, each finding its change, and a diff command per file", () => {
    const r = setup("review_max_unreviewed: 2\n", {
      findings: [
        { kind: "concurrency", title: "race", root_cause: "no lock", file: "b.ts", line: 1, scenario: "two sessions at once", existing: null },
        { kind: "concurrency", title: "race", root_cause: "no lock", file: "app.txt", line: 1, scenario: "old line", existing: null },
      ],
    });
    const a = land(r, "a.ts");
    review(r, a);
    const b = land(r, "b.ts");
    const done = review(r, b);
    expect(done.code).toBe(0);
    const created = r.issues();
    expect(created).toHaveLength(1);
    const text = created[0]![created[0]!.indexOf("--body") + 1]!;
    const range = `${a.base.slice(0, 9)}..${b.head.slice(0, 9)}`;
    expect(text.split("\n")[0]).toBe(`**concurrency**, found by the post-land code review of ${a.change}, ${b.change} (\`${range}\`).`);
    expect(text).toContain(`- \`b.ts:1\` (${b.change}): two sessions at once`);
    expect(text).toContain("- `app.txt:1` (in range): old line");
    expect(text).toContain(`Reproduce from: \`git diff ${a.base.slice(0, 9)} ${b.head.slice(0, 9)} -- b.ts\``);
    expect(text).toContain(`Reproduce from: \`git diff ${a.base.slice(0, 9)} ${b.head.slice(0, 9)} -- app.txt\``);
  });
});

function rmSyncIf(path: string) {
  Bun.spawnSync(["rm", "-f", path]);
}

describe("canon work status and canon brief about unreviewed landings", () => {
  const canon = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    return p.stdout.toString();
  };

  it("BR-2316: unreviewed landings are counted in status and brief, and a due trailing batch is started by brief in the background", async () => {
    const r = setup();
    const started = join(r.tools, "started");
    // the stand-in for the review command; it names scripts/code-review.ts so that brief takes it for the review hook
    writeFileSync(join(r.root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: none\nreview_max_unreviewed: 3\nhooks:\n  after_land:\n    - "echo $CANON_HEAD > ${started}  # scripts/code-review.ts"\n`);
    sh(r.root, "commit", "-qam", "hook");
    const first = land(r, "a.ts");
    review(r, first); // sets the ref at its base
    land(r, "b.ts");
    expect(canon(r.root, "work", "status")).toContain("main: 2 landing(s) not code-reviewed yet (reviewed in a batch at 3 or after 60 min)");
    expect(canon(r.root, "brief")).not.toContain("reviewing them in the background");
    expect(existsSync(started)).toBe(false);
    const third = land(r, "c.ts");
    const out = canon(r.root, "brief");
    expect(out).toContain("main: 3 landing(s) not code-reviewed yet");
    expect(out).toContain("3 landing(s) not reviewed and none left to trigger it; reviewing them in the background");
    const end = Date.now() + 20_000;
    while (!existsSync(started) || readFileSync(started, "utf8").trim() === "") {
      if (Date.now() > end) throw new Error("the review command was not started");
      await Bun.sleep(50);
    }
    expect(readFileSync(started, "utf8").trim()).toBe(third.head);
  });

  it("BR-2316: with nothing waiting neither command mentions code review", () => {
    const r = setup();
    review(r, land(r, "a.ts"), { CANON_NOW: minutesFromNow(61) });
    expect(canon(r.root, "work", "status")).not.toContain("code-reviewed");
    expect(canon(r.root, "brief")).not.toContain("code-reviewed");
  });
});

describe("one code review at a time, through the coordination database", () => {
  const FINDING = { findings: [{ kind: "concurrency", title: "race", root_cause: "no lock", file: "a.ts", line: 1, scenario: "two at once", existing: null }] };
  const spawnReview = (r: Repo, l: { base: string; head: string; change: string }, env: Record<string, string> = {}) =>
    Bun.spawn(["bun", SCRIPT], {
      cwd: r.root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, CANON_ACTOR: "agent:a", CANON_BASE: l.base, CANON_HEAD: l.head, CANON_CHANGE: l.change, CANON_CODE_REVIEW_AI: `sh ${r.tools}/ai.sh`, CANON_GH: `bun ${r.tools}/gh.ts`, ...env },
    });
  const finish = async (p: ReturnType<typeof spawnReview>) => ({ code: await p.exited, out: await new Response(p.stdout).text() });
  /** A review whose AI takes a while, so that a second one started with it overlaps. */
  const slowAi = (r: Repo) => writeFileSync(join(r.tools, "ai.sh"), `echo x >> ${r.tools}/ai-calls\ncat > ${r.tools}/prompt.txt\nsleep 3\ncat ${r.tools}/answer.json\n`);
  const holders = (r: Repo) => ws(r.root).db.db.query<{ pid: number; pid_start: string }, []>("SELECT pid, pid_start FROM code_reviewer").all();
  const hold = (r: Repo, pid: number, start: string) => ws(r.root).db.db.query("INSERT OR REPLACE INTO code_reviewer(id, pid, pid_start, started_at) VALUES (1, ?, ?, ?)").run(pid, start, new Date().toISOString());

  it("BR-2314: three reviews started together run the AI once and file one issue; the others wait and find nothing left", async () => {
    const r = setup("review_max_unreviewed: 1\n", FINDING);
    slowAi(r);
    const l = land(r, "a.ts");
    const runs = [spawnReview(r, l), spawnReview(r, l), spawnReview(r, l)];
    const results = await Promise.all(runs.map(finish));
    console.log(`concurrency: AI invoked ${r.aiCalls()} time(s), gh issue create ${r.issues().length} time(s)`);
    expect(results.map((x) => x.code)).toEqual([0, 0, 0]);
    expect(r.aiCalls()).toBe(1);
    expect(r.issues()).toHaveLength(1);
    expect(results.filter((x) => x.out.includes("reviewed 1 landing(s) in one batch"))).toHaveLength(1);
    expect(results.filter((x) => x.out.includes("already reviewed in a batch; nothing to review"))).toHaveLength(2);
    expect(reviewed(r)).toBe(l.head);
    expect(holders(r)).toEqual([]);
  });

  it("BR-2314: with a live holder, a review with CANON_CODE_REVIEW_NOWAIT=1 reports it is busy and does not call the AI", async () => {
    const r = setup("review_max_unreviewed: 1\n", FINDING);
    const l = land(r, "a.ts");
    const holder = hang();
    try {
      const me = processOf(holder.pid)!;
      hold(r, me.pid, me.start);
      const done = await finish(spawnReview(r, l, { CANON_CODE_REVIEW_NOWAIT: "1" }));
      expect(done.code).toBe(0);
      expect(done.out).toContain("another code review is running; it covers this range");
      expect(r.aiCalls()).toBe(0);
      expect(holders(r)).toEqual([{ pid: me.pid, pid_start: me.start }]);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("BR-2314: a holder killed with SIGKILL is taken over by the next review, which reviews and clears the row", async () => {
    const r = setup("review_max_unreviewed: 1\n", FINDING);
    const l = land(r, "a.ts");
    const holder = hang();
    const me = processOf(holder.pid)!;
    hold(r, me.pid, me.start);
    holder.kill("SIGKILL");
    await holder.exited;
    const done = await finish(spawnReview(r, l, { CANON_CODE_REVIEW_NOWAIT: "1" }));
    expect(done.code).toBe(0);
    expect(done.out).toContain("reviewed 1 landing(s) in one batch");
    expect(r.aiCalls()).toBe(1);
    expect(holders(r)).toEqual([]);
  });

  it("BR-2314: a live holder is not taken over when the process table cannot be read", async () => {
    const r = setup("review_max_unreviewed: 1\n", FINDING);
    const l = land(r, "a.ts");
    const holder = hang();
    try {
      const me = processOf(holder.pid)!;
      // a stale start: with a readable table this holder would be provably gone
      hold(r, me.pid, "Thu Jan  1 00:00:00 1970");
      const bin = mkdtempSync(join(tmpdir(), "canon-batch-review-bin-"));
      symlinkSync(process.execPath, join(bin, "bun"));
      symlinkSync(Bun.which("git")!, join(bin, "git"));
      const done = await finish(spawnReview(r, l, { CANON_CODE_REVIEW_NOWAIT: "1", PATH: bin }));
      expect(done.out).toContain("another code review is running; it covers this range");
      expect(r.aiCalls()).toBe(0);
      expect(holders(r)).toEqual([{ pid: me.pid, pid_start: "Thu Jan  1 00:00:00 1970" }]);
      // with a readable table the same row is provably gone and is taken over
      const again = await finish(spawnReview(r, l, { CANON_CODE_REVIEW_NOWAIT: "1" }));
      expect(again.out).toContain("reviewed 1 landing(s) in one batch");
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("BR-2314: a review whose row was taken over meanwhile does not delete the new holder's row", async () => {
    const r = setup("review_max_unreviewed: 1\n", FINDING);
    const l = land(r, "a.ts");
    const other = hang();
    try {
      const me = processOf(other.pid)!;
      writeFileSync(
        join(r.tools, "steal.ts"),
        `import { Database } from "bun:sqlite";\nnew Database(${JSON.stringify(ws(r.root).db.db.filename)}).query("UPDATE code_reviewer SET pid = ?, pid_start = ?").run(${me.pid}, ${JSON.stringify(me.start)});\n`,
      );
      writeFileSync(join(r.tools, "ai.sh"), `echo x >> ${r.tools}/ai-calls\ncat > ${r.tools}/prompt.txt\nbun ${r.tools}/steal.ts\ncat ${r.tools}/answer.json\n`);
      const done = await finish(spawnReview(r, l));
      expect(done.code).toBe(0);
      expect(holders(r)).toEqual([{ pid: me.pid, pid_start: me.start }]);
    } finally {
      other.kill("SIGKILL");
    }
  });
});
