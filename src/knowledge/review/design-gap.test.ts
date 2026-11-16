import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegate } from "../../work/delegation/delegate.ts";
import { snapshotDetail, type DelegationSnapshot } from "../../work/land/checks/delegation.ts";
import { land as canonLand } from "../../work/land/land.ts";
import { start } from "../../work/session/session.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";

setDefaultTimeout(120_000);

const SCRIPT = join(import.meta.dir, "../../../scripts/code-review.ts");
const OWNER = "agent:s1";
const W1 = "agent:s7:w1";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
    rmSync(`${r}.worktrees`, { recursive: true, force: true });
  }
});

function put(dir: string, path: string, text: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}
function commit(dir: string, message = "edit") {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", message);
}

/**
 * Stand-ins in their own directory: the AI saves its prompt, counts its calls and prints `answer.json`; gh logs each
 * call, lists no open issues and answers a create with an issue URL.
 */
function tools(answer: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "canon-design-gap-tools-"));
  roots.push(dir);
  writeFileSync(join(dir, "answer.json"), JSON.stringify(answer));
  writeFileSync(join(dir, "ai.sh"), `echo x >> ${dir}/ai-calls\ncat > ${dir}/prompt.txt\ncat ${dir}/answer.json\n`);
  writeFileSync(
    join(dir, "gh.ts"),
    `import { appendFileSync } from "node:fs";\nconst a = process.argv.slice(2);\nappendFileSync(${JSON.stringify(join(dir, "gh.log"))}, JSON.stringify(a) + "\\n");\nif (a[0] === "issue" && a[1] === "list") { if (!a.includes("canon-design-gap")) { console.log("[]"); process.exit(0); } const f = ${JSON.stringify(join(dir, "open.json"))}; console.log(require("node:fs").existsSync(f) ? require("node:fs").readFileSync(f, "utf8") : "[]"); }\nif (a[0] === "issue" && a[1] === "create") console.log("https://github.com/o/r/issues/77");\n`,
  );
  return {
    dir,
    answer: (a: unknown) => writeFileSync(join(dir, "answer.json"), JSON.stringify(a)),
    prompt: () => readFileSync(join(dir, "prompt.txt"), "utf8"),
    aiCalls: () => (existsSync(join(dir, "ai-calls")) ? readFileSync(join(dir, "ai-calls"), "utf8").trim().split("\n").length : 0),
    open: (issues: unknown) => writeFileSync(join(dir, "open.json"), JSON.stringify(issues)),
    comments: () => (existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((c) => c[1] === "comment") : []),
    creates: () => (existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((c) => c[1] === "create") : []),
  };
}
type Tools = ReturnType<typeof tools>;

/** `bun scripts/code-review.ts` reviewing everything from `base` to main's tip now. */
function review(root: string, t: Tools, base: string) {
  const p = Bun.spawnSync(["bun", SCRIPT], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CANON_ACTOR: OWNER, CANON_CODE_REVIEW_FORCE: "1", CANON_BASE: base, CANON_HEAD: sh(root, "rev-parse", "main"), CANON_CODE_REVIEW_AI: `sh ${t.dir}/ai.sh`, CANON_GH: `bun ${t.dir}/gh.ts`, CANON_CODE_REVIEW_WAITER: "0" },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const body = (c: string[]) => c[c.indexOf("--body") + 1]!;
const label = (c: string[]) => c[c.indexOf("--label") + 1]!;
const gap = (over: Record<string, unknown> = {}) => ({
  kind: "design-gap",
  title: "Lost target returns to patrol after 2 seconds",
  root_cause: "the contract rule says nothing about losing the target",
  file: "src/enemy.ts",
  line: 1,
  scenario: "the enemy loses its target → after 2 seconds it goes back to patrol",
  ...over,
});

/**
 * A project whose landings are commits recorded by land.ok events, as the land code records them: a worker landing
 * carries the delegation snapshot (BR-2501). The contract rule and design file are on main at the start.
 */
function synthetic(answer: unknown = { findings: [] }) {
  const root = mkdtempSync(join(tmpdir(), "canon-design-gap-"));
  roots.push(root);
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  put(root, "canon/config.yaml", "floor: \"true\"\ntests: []\nreview: none\n");
  put(root, "canon/product.md", "# Product\n\nPRODUCT-TEXT\n");
  put(root, "canon/rules/ai/BR-50.md", "---\nid: BR-50\n---\n\n## 规则\n\nCONTRACT-RULE: the enemy chases a target it sees.\n");
  put(root, "src/enemy.ts", "export const chase = true;\n");
  commit(root, "init");
  const start0 = sh(root, "rev-parse", "HEAD");
  const contract = [
    { path: "canon/rules/ai/BR-50.md", id: "BR-50", hash: "h" },
    { path: "canon/product.md", hash: "h" },
  ];
  const snapshot = (over: Partial<DelegationSnapshot> = {}): DelegationSnapshot => ({ lander: W1, epoch: 1, owner: OWNER, revision: start0, contract, ...over });
  /** Lands `files` as `change` and records its land.ok; returns its event id, base and commit. */
  const land = (change: string, files: Record<string, string>, s?: DelegationSnapshot) => {
    const base = sh(root, "rev-parse", "HEAD");
    for (const [p, text] of Object.entries(files)) put(root, p, text);
    commit(root, change);
    const head = sh(root, "rev-parse", "HEAD");
    const w = ws(root, s?.lander ?? OWNER);
    try {
      const id = w.db.event(s?.lander ?? OWNER, "land.ok", change, { sha: head, base, branch: `change/${change}`, ...snapshotDetail(s) });
      return { id: Number(id), base, head };
    } finally {
      w.db.close();
    }
  };
  return { root, start: start0, t: tools(answer), snapshot, land };
}

describe("post-land code review: design gaps of worker landings", () => {
  it("BR-2503: a real worker landing gives the reviewer its land.ok id, commit, the contract's full text at the design revision and its own diff; a design-gap opens a canon-design-gap issue for the design owner", async () => {
    const root = project();
    roots.push(root);
    put(root, "canon/config.yaml", "floor: test ! -e FAIL\ntests: []\nreview: none\ndesign_paths: [docs/DESIGN.md]\n");
    put(root, "canon/product.md", "# Product\n\nShared work.\n");
    put(root, "canon/rules/task/README.md", "---\ncode: [src]\n---\n# task\n\nTasks.\n\n## 业务\n\n- **dispatch**：派发\n\n## 术语\n\n- **任务**：要做的事\n");
    put(root, "canon/rules/task/BR-50.md", "---\nid: BR-50\ntitle: BR-50\nstatus: planned\nbusiness: dispatch\nuntested: fixture\n---\n\n## 规则\n\nOLD-RULE-TEXT the enemy chases a target it sees.\n\n## 例子\n\n- Works.\n");
    put(root, "docs/DESIGN.md", "# Design\n\nDESIGN-FILE-TEXT\n");
    commit(root, "design");
    const s = startNew(root, "Worker task", OWNER);
    const file = `canon/changes/${readdirSync(join(s.worktree, "canon/changes")).find((p) => p.startsWith(s.change))!}`;
    put(s.worktree, file, readFileSync(join(s.worktree, file), "utf8").replace(/rules: \[\]/, "rules: [BR-50]"));
    commit(s.worktree, "rules");
    const d = delegate(ws(root, OWNER), s.change, "w1", [], quiet);
    if (!d.ok) throw new Error(d.error.message);
    const revision = sh(root, "rev-parse", "main");
    const claimed = start(ws(root, W1), { change: s.change }, quiet);
    if (!claimed.ok) throw new Error(claimed.error.message);
    put(s.worktree, "src/enemy.ts", "export const LOST_TARGET_PATROL_MS = 2000;\n");
    commit(s.worktree, "code");
    const before = sh(root, "rev-parse", "main");
    expect((await canonLand(ws(s.worktree, W1), FAST, quiet)).kind).toBe("landed");
    const w = ws(root, OWNER);
    const event = w.db.db.query<{ id: number; sha: string }, [string]>("SELECT id, json_extract(detail, '$.sha') AS sha FROM events WHERE kind = 'land.ok' AND subject = ?").get(s.change)!;
    w.db.close();

    // The design owner writes the lost target into the rule after the delegation and before the review.
    const fix = startNew(root, "Owner amends", OWNER);
    put(fix.worktree, "canon/rules/task/BR-50.md", readFileSync(join(fix.worktree, "canon/rules/task/BR-50.md"), "utf8").replace("OLD-RULE-TEXT", "NEW-RULE-TEXT lost target: patrol after 2 s;"));
    commit(fix.worktree, "amend");
    expect((await canonLand(ws(fix.worktree, OWNER), FAST, quiet)).kind).toBe("landed");

    const t = tools({ findings: [gap({ landing: event.id })] });
    const r = review(root, t, before);
    expect(r.code).toBe(0);
    const p = t.prompt();
    expect(p).toContain(`land.ok ${event.id}, commit ${event.sha.slice(0, 9)}, change ${s.change}, landed by ${W1} (design owner ${OWNER}`);
    expect(p).toContain(`### Contract item BR-50 (canon/rules/task/BR-50.md) at design revision ${revision.slice(0, 9)}`);
    expect(p).toContain("OLD-RULE-TEXT"); // the snapshot's design revision, not main now
    expect(p).not.toContain("NEW-RULE-TEXT");
    expect(p).toContain("### Contract item docs/DESIGN.md (docs/DESIGN.md)");
    expect(p).toContain("DESIGN-FILE-TEXT"); // a contract item outside the rules is given in full too
    expect(p).toContain("+export const LOST_TARGET_PATROL_MS = 2000;");
    const [issue, ...more] = t.creates();
    expect(more).toEqual([]);
    expect(label(issue!)).toBe("canon-design-gap");
    const text = body(issue!);
    expect(text).toContain(`Change: ${s.change}, landed by ${W1} (land.ok ${event.id}`);
    expect(text).toContain(`Design owner: ${OWNER}`);
    expect(text).toContain("- `src/enemy.ts:1`");
    expect(text).toContain("Unstated choice: the enemy loses its target → after 2 seconds it goes back to patrol");
    expect(r.out).toContain(`(design owner ${OWNER})`);
  });

  it("BR-2503 BR-2070: the prompt asks for design gaps as business choices no contract item states, and says naming and function splitting are not ones", () => {
    const s = synthetic();
    const l = s.land("C-9", { "src/enemy.ts": "export const patrolAfterMs = 2000;\n" }, s.snapshot());
    expect(review(s.root, s.t, s.start).code).toBe(0);
    const p = s.t.prompt();
    expect(p).toContain("Look ONLY for security problems and concurrency problems");
    expect(p).toContain("and the design gaps of worker landings");
    expect(p).toContain("a result users can see, what happens on an error, the format of stored data, or an external interface");
    expect(p).toContain("that none of the landing's contract items states");
    expect(p).toContain("Internal naming and how functions are split are NOT business choices");
    expect(p).toContain('"kind":"design-gap","landing":<land.ok event id>');
    expect(p).toContain(`land.ok ${l.id}, commit ${l.head.slice(0, 9)}, change C-9`);
    expect(p).toContain("CONTRACT-RULE: the enemy chases a target it sees.");
    expect(p).toContain("PRODUCT-TEXT");
    expect(p).toContain(`### Diff of this landing (${l.base.slice(0, 9)}..${l.head.slice(0, 9)})`);
  });

  it("BR-2503 BR-2070: a range with only the main session's landings has no design-gap request in the prompt", () => {
    const s = synthetic();
    s.land("C-1", { "src/enemy.ts": "export const chase = false;\n" });
    expect(review(s.root, s.t, s.start).code).toBe(0);
    expect(s.t.aiCalls()).toBe(1);
    expect(s.t.prompt()).not.toContain("design-gap");
    expect(s.t.prompt()).not.toContain("Design gaps");
  });

  it("BR-2503 BR-2070: a worker landing that changed only canon/ calls no reviewer alone, and gets no design-gap section beside a code landing", () => {
    const alone = synthetic({ findings: [gap({ landing: 1 })] });
    alone.land("C-9", { "canon/changes/C-9.md": "notes\n" }, alone.snapshot());
    const r = review(alone.root, alone.t, alone.start);
    expect(r.out).toContain("code-review: no code changed; nothing to review");
    expect(alone.t.aiCalls()).toBe(0);
    expect(alone.t.creates()).toEqual([]);

    const mixed = synthetic();
    mixed.land("C-9", { "canon/changes/C-9.md": "notes\n" }, mixed.snapshot());
    mixed.land("C-1", { "src/enemy.ts": "export const chase = false;\n" });
    expect(review(mixed.root, mixed.t, mixed.start).code).toBe(0);
    expect(mixed.t.aiCalls()).toBe(1);
    expect(mixed.t.prompt()).not.toContain("Design gaps");
  });

  it("BR-2503 BR-2071: a design-gap without a land.ok id, or naming one that is not a worker landing of the range, is dropped and files nothing", () => {
    const s = synthetic();
    const main = s.land("C-1", { "src/a.ts": "export const a = 1;\n" });
    const worker = s.land("C-9", { "src/enemy.ts": "export const patrolAfterMs = 2000;\n" }, s.snapshot());
    s.t.answer({ findings: [gap(), gap({ landing: main.id }), gap({ landing: worker.id + 100 }), gap({ landing: worker.id, file: "" })] });
    const r = review(s.root, s.t, s.start);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter((l) => l.startsWith("code-review: dropped")).length).toBe(4);
    expect(r.out).toContain("code-review: dropped a design-gap finding that names no land.ok id of a worker landing in this range");
    expect(r.out).toContain("code-review: no findings");
    expect(s.t.creates()).toEqual([]);
  });

  it("BR-2503: the reviewer returning no design-gap opens no canon-design-gap issue", () => {
    const s = synthetic({ findings: [] });
    s.land("C-9", { "src/enemy.ts": "export const patrolAfterMs = 2000;\n" }, s.snapshot());
    const r = review(s.root, s.t, s.start);
    expect(r.out).toContain("code-review: no findings");
    expect(s.t.creates()).toEqual([]);
  });

  it("BR-2503 BR-2071: a design-gap is accepted next to security and concurrency findings, each filed under its own label", () => {
    const s = synthetic();
    const l = s.land("C-9", { "src/enemy.ts": "export const patrolAfterMs = 2000;\n" }, s.snapshot());
    s.t.answer({ findings: [gap({ landing: String(l.id) }), { kind: "concurrency", title: "race", root_cause: "no lock", file: "src/enemy.ts", line: 1, scenario: "two sessions at once", existing: null }] });
    expect(review(s.root, s.t, s.start).code).toBe(0);
    expect(s.t.creates().map(label).sort()).toEqual(["canon-design-gap", "canon-review"]);
  });

  it("BR-2503 BR-2072: a design-gap whose title matches an open canon-design-gap issue comments on it instead of opening another", () => {
    const s = synthetic();
    const l = s.land("C-9", { "src/enemy.ts": "export const patrolAfterMs = 2000;\n" }, s.snapshot());
    s.t.open([{ number: 41, title: "lost target returns to patrol after 2 seconds" }]);
    s.t.answer({ findings: [gap({ landing: String(l.id) })] });
    const r = review(s.root, s.t, s.start);
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(s.t.creates()).toEqual([]);
    const [c] = s.t.comments();
    expect(c!.slice(0, 3)).toEqual(["issue", "comment", "41"]);
    expect(r.out).toContain("commented on #41");
  });

  it("BR-2503: the same change landed at two epochs; a design-gap naming the second land.ok carries the second snapshot's design owner and landing", () => {
    const s = synthetic();
    s.land("C-9", { "src/enemy.ts": "export const patrolAfterMs = 1000;\n" }, s.snapshot());
    const second = s.land("C-9", { "src/enemy.ts": "export const patrolAfterMs = 2000;\n" }, s.snapshot({ epoch: 2, owner: "agent:s2", lander: "agent:s8:w1" }));
    s.t.answer({ findings: [gap({ landing: second.id })] });
    expect(review(s.root, s.t, s.start).code).toBe(0);
    const [issue] = s.t.creates();
    const text = body(issue!);
    expect(text).toContain(`Change: C-9, landed by agent:s8:w1 (land.ok ${second.id}, commit ${second.head.slice(0, 9)}, epoch 2)`);
    expect(text).toContain("Design owner: agent:s2");
    expect(text).not.toContain(OWNER);
    expect(text).toContain(`Reproduce from: \`git diff ${second.base.slice(0, 9)} ${second.head.slice(0, 9)} -- src/enemy.ts\``);
  });
});
