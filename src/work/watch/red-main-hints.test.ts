import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { selfProcess } from "../claims/liveness.ts";
import { project, quiet, sh, startNew, ws } from "../testkit.ts";
import { redMain } from "./redmain.ts";
import { watch } from "./watch.ts";

// reason: these cases run real background floors and spawn the CLI, which takes seconds under load
setDefaultTimeout(120_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const OWNER = "agent:a";
const WORKER = "agent:a:w1";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function canon(cwd: string, actor: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const briefAfterGuide = (cwd: string, actor = OWNER) => {
  const r = canon(cwd, actor, "brief");
  expect(r.code).toBe(0);
  return r.out.slice(r.out.indexOf(WORKFLOW_GUIDE) + WORKFLOW_GUIDE.length);
};

/** test_command: runs one test file and writes a one-case JUnit report naming it. */
const RUN = `f="$1"; r="$2"
if sh "$f" >/dev/null 2>&1; then x=""; else x='<failure message="x"/>'; fi
printf '<testsuites><testsuite name="s"><testcase classname="c" name="%s" file="%s">%s</testcase></testsuite></testsuites>' "$f" "$f" "$x" > "$r"
[ -z "$x" ]
`;
/** floor with `{report}`: every test file, one report; FAIL_EARLY in the tree fails it before the tests, with an empty report. */
const FLOOR = `r="$1"
if [ -e FAIL_EARLY ]; then printf '<testsuites></testsuites>' > "$r"; exit 1; fi
out='<testsuites><testsuite name="s">'; rc=0
for f in t/*.test.sh; do if sh "$f" >/dev/null 2>&1; then x=""; else x='<failure message="x"/>'; rc=1; fi; out="$out<testcase classname=\\"c\\" name=\\"$f\\" file=\\"$f\\">$x</testcase>"; done
printf '%s</testsuite></testsuites>' "$out" > "$r"; exit $rc
`;
/** floor without `{report}`: only an exit code. */
const PLAIN_FLOOR = `rc=0; for f in t/*.test.sh; do sh "$f" >/dev/null 2>&1 || rc=1; done; exit $rc
`;

/** A project in after mode whose test files live under t/; `reported` picks the floor with `{report}`. */
function repo(reported = true): string {
  const root = project();
  roots.push(root);
  const floor = reported ? "sh floor.sh {report}" : "sh floor.sh";
  writeFileSync(join(root, "canon/config.yaml"), `floor: ${floor}\ntest_command: sh run.sh {file} {report}\ntests: ["t/*.test.sh"]\nfloor_timing: after\nfloor_quiet_minutes: 600\nfloor_max_untested: 100\nfloor_max_age_minutes: 600\nreview: none\n`);
  writeFileSync(join(root, "run.sh"), RUN);
  writeFileSync(join(root, "floor.sh"), reported ? FLOOR : PLAIN_FLOOR);
  mkdirSync(join(root, "t"), { recursive: true });
  writeFileSync(join(root, "t/ok.test.sh"), "exit 0\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "setup");
  return root;
}

/** Commits `files` on main (null removes one) and runs the background floor on it now. */
async function commitAndWatch(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [p, text] of Object.entries(files)) {
    if (text === null) sh(root, "rm", "-q", p);
    else {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), text);
      sh(root, "add", p);
    }
  }
  sh(root, "commit", "-qm", "next");
  expect((await watch(ws(root), quiet, { now: true })).ok).toBe(true);
}

/** A failing-main record written directly, with `files` named and no fix change, as a background failure leaves it. */
function record(root: string, files: readonly string[], change: string | null = null): void {
  const at = new Date().toISOString();
  ws(root).db.db
    .query("INSERT INTO red_main(id, sha, first_sha, log, tail, since, green, change, updated_at, files, files_unknown) VALUES (1, ?1, ?1, 'floor.log', 'boom', ?2, NULL, ?3, ?2, ?4, ?5)")
    .run("abcdef1234567890abcdef1234567890abcdef12", at, change, JSON.stringify(files), files.length > 0 ? null : "no-report");
}

/** This test process as the live `canon floor watch`: the automatic revert is still going (BR-2535). */
function liveWatcher(root: string): void {
  const self = selfProcess()!;
  ws(root).db.db.query("INSERT OR REPLACE INTO watcher(id, pid, pid_start, sha, started_at) VALUES (1, ?, ?, NULL, ?)").run(self.pid, self.start, new Date().toISOString());
}

const event = (root: string, kind: string, detail: Record<string, unknown>) => ws(root).db.event(OWNER, kind, null, detail);

describe("the failing test files on the failing-main record", () => {
  test("BR-2599: the record names the failing test files sorted by path, canon brief lists them, and a later failure replaces them", async () => {
    const root = repo();
    await commitAndWatch(root, { "t/b.test.sh": "exit 1\n", "t/a.test.sh": "exit 1\n" });
    const r = redMain(ws(root).db)!;
    expect([r.files, r.filesUnknown]).toEqual([["t/a.test.sh", "t/b.test.sh"], null]);
    expect(briefAfterGuide(root)).toContain("  failing test files (2): t/a.test.sh, t/b.test.sh\n");
    await commitAndWatch(root, { "t/a.test.sh": null, "t/b.test.sh": null, "t/c.test.sh": "exit 1\n" });
    expect(redMain(ws(root).db)!.files).toEqual(["t/c.test.sh"]);
  });

  test("BR-2599: of 12 failing test files canon brief lists the first 10 and says how many more", async () => {
    const root = repo();
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t/f${String(i + 1).padStart(2, "0")}.test.sh`, "exit 1\n"]));
    await commitAndWatch(root, files);
    const names = Object.keys(files).sort();
    expect(redMain(ws(root).db)!.files).toEqual(names);
    expect(briefAfterGuide(root)).toContain(`  failing test files (12): ${names.slice(0, 10).join(", ")} … and 2 more\n`);
  });

  test("BR-2599: a floor with {report} that fails before the tests records no files and says so", async () => {
    const root = repo();
    await commitAndWatch(root, { FAIL_EARLY: "x\n" });
    const r = redMain(ws(root).db)!;
    expect([r.files, r.filesUnknown]).toEqual([[], "before-tests"]);
    expect(briefAfterGuide(root)).toContain("failing test files: none, it failed before the tests");
  });

  test("BR-2599: a floor without {report} records no files and canon brief says which ones is not known", async () => {
    const root = repo(false);
    await commitAndWatch(root, { "t/a.test.sh": "exit 1\n" });
    const r = redMain(ws(root).db)!;
    expect([r.files, r.filesUnknown]).toEqual([[], "no-report"]);
    expect(briefAfterGuide(root)).toContain("failing test files: not known, the floor writes no report");
  });
});

describe("who is told to fix a failing main", () => {
  test("BR-2598: once the automatic revert has its result, a main session holding a claimed change is told to open the fix change, and in its worktree that the failures are not its change's", async () => {
    const root = repo();
    const s = startNew(root, "Held work");
    // no refs/canon/green, so the automatic revert records revert.skip at once (BR-2535)
    await commitAndWatch(root, { "t/a.test.sh": "exit 1\n" });
    const text = briefAfterGuide(s.worktree);
    expect(text).toContain("`canon work start --fix-main`, even one holding a claimed change: stop that change first (canon work stop) or delegate it");
    expect(text).not.toContain("has no claimed change");
    expect(text).toContain(`These failures are not caused by ${s.change}: do not fix them in ${s.change}`);
  });

  test("BR-2598: while the automatic revert has no result the hint says it is reverting and names no --fix-main", () => {
    const root = repo();
    const s = startNew(root, "Held work");
    record(root, ["t/a.test.sh"]);
    liveWatcher(root);
    const text = briefAfterGuide(s.worktree);
    expect(text).toContain("the automatic revert is still locating or reverting the landing that broke it: do not open a fix change yet");
    expect(text).not.toContain("--fix-main");
  });

  test("BR-2598: a worker is told to tell the main session that delegated it, never to open the fix change", () => {
    const root = repo();
    const s = startNew(root, "Worker's change", WORKER);
    record(root, ["t/a.test.sh"]);
    const text = briefAfterGuide(s.worktree, WORKER);
    expect(text).toContain("nobody is fixing it yet: tell the main session that delegated your change");
    expect(text).not.toContain("--fix-main");
  });
});

describe("canon work test while main is failing", () => {
  /** A change whose worktree changes t/a.test.sh and t/b.test.sh, so both are selected; `fail` makes them fail. */
  function changed(root: string, fail: boolean, actor = OWNER) {
    const s = startNew(root, "Tested on red", actor);
    writeFileSync(join(s.worktree, "t/a.test.sh"), fail ? "exit 1\n" : "exit 0\n");
    writeFileSync(join(s.worktree, "t/b.test.sh"), fail ? "exit 1\n" : "exit 0\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "tests");
    return s;
  }
  const count = (text: string, part: string) => text.split(part).length - 1;

  test("BR-2600: the hint comes before the run and again after it, failing files main fails too get their own line, and the exit code stays", () => {
    const root = repo();
    const s = changed(root, true);
    record(root, ["t/a.test.sh"]);
    const r = canon(s.worktree, OWNER, "work", "test");
    expect(r.code).toBe(1);
    expect(count(r.err, "nobody is fixing it yet: whichever session sees this opens the fix change")).toBe(2);
    const between = r.err.indexOf("failing on main too: t/a.test.sh (");
    expect(between).toBeGreaterThan(r.err.indexOf("main is failing floor since"));
    expect(between).toBeLessThan(r.err.lastIndexOf("main is failing floor since"));
    expect(r.err).not.toContain("failing on main too: t/a.test.sh, t/b.test.sh");
  });

  test("BR-2600: a passing run still has the hint before and after, exit 0; a record without files only repeats it", () => {
    const root = repo();
    const s = changed(root, false);
    record(root, ["t/a.test.sh"]);
    const pass = canon(s.worktree, OWNER, "work", "test");
    expect(pass.code).toBe(0);
    expect(count(pass.err, "main is failing floor since")).toBe(2);
    expect(pass.err).not.toContain("failing on main too");
    ws(root).db.db.query("UPDATE red_main SET files = '[]', files_unknown = 'no-report'").run();
    writeFileSync(join(s.worktree, "t/a.test.sh"), "exit 1\n");
    sh(s.worktree, "commit", "-qam", "fails");
    const fail = canon(s.worktree, OWNER, "work", "test");
    expect(fail.code).toBe(1);
    expect(count(fail.err, "main is failing floor since")).toBe(2);
    expect(fail.err).not.toContain("failing on main too");
  });

  test("BR-2600: with a fix change each of the two places is one line naming it; a passing main adds nothing", () => {
    const root = repo();
    const s = changed(root, true);
    const plain = canon(s.worktree, OWNER, "work", "test");
    expect(plain.err).not.toContain("main is failing");
    record(root, ["t/a.test.sh"], "C-9");
    const r = canon(s.worktree, OWNER, "work", "test");
    expect(r.code).toBe(1);
    expect(r.err.split("\n").filter((l) => l.includes("main is failing") || l.includes("C-9"))).toEqual([
      expect.stringMatching(/^main is failing floor since abcdef123.*: being fixed in C-9$/),
      expect.stringMatching(/^main is failing floor since abcdef123.*: being fixed in C-9$/),
    ]);
    expect(r.err).not.toContain("failing on main too");
  });

  test("BR-2600: a worker's canon work test is worded for a worker", () => {
    const root = repo();
    const s = changed(root, true, WORKER);
    record(root, ["t/a.test.sh"]);
    const r = canon(s.worktree, WORKER, "work", "test");
    expect(r.code).toBe(1);
    expect(count(r.err, "tell the main session that delegated your change")).toBe(2);
    expect(r.err).not.toContain("--fix-main");
    expect(r.err).toContain("failing on main too: t/a.test.sh (");
  });
});

describe("the red-main agenda item", () => {
  const dueKeys = (root: string) => {
    const r = canon(root, OWNER, "work", "due", "--json");
    expect(r.code).toBe(0);
    const a = JSON.parse(r.out) as { judge: { key: string }[] };
    return a.judge.map((it) => it.key);
  };

  test("BR-2601: red-main is not on the agenda while the automatic revert has no result, and appears after a revert.skip", () => {
    const root = repo();
    record(root, ["t/a.test.sh"]);
    liveWatcher(root);
    expect(dueKeys(root)).not.toContain("red-main");
    event(root, "revert.skip", { failed_on: "abcdef1234567890abcdef1234567890abcdef12", reason: "no green", log: "floor.log" });
    expect(dueKeys(root)).toContain("red-main");
  });

  test("BR-2601: after a revert, red-main appears once the background floor fails again", () => {
    const root = repo();
    record(root, ["t/a.test.sh"]);
    liveWatcher(root);
    event(root, "land.revert", { landing: "x", revert: "y", files: [], log: "floor.log" });
    expect(dueKeys(root)).not.toContain("red-main");
    event(root, "floor.fail", { sha: "abcdef1234567890abcdef1234567890abcdef12", log: "floor.log", exit: 1, why: "floor exited 1" });
    expect(dueKeys(root)).toContain("red-main");
  });

  test("BR-2601: canon work handled red-main --defer or --not-doing is refused with exit 1 and a reminder.handled.refuse for red-main; --to records as usual", () => {
    const root = repo();
    const s = startNew(root, "The fix");
    record(root, ["t/a.test.sh"]);
    const refusals = () => ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'reminder.handled.refuse' ORDER BY id").all().map((r) => (JSON.parse(r.detail) as { reason: string }).reason);
    const handled = () => ws(root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'reminder.handled'").get()!.n;
    const defer = canon(root, OWNER, "work", "handled", "red-main", "--defer", "later", "--for", "1h");
    expect(defer.code).toBe(1);
    expect(defer.err).toContain("main failing cannot wait, it can only be fixed");
    const drop = canon(root, OWNER, "work", "handled", "red-main", "--not-doing", "not mine");
    expect(drop.code).toBe(1);
    expect(refusals()).toEqual(["red-main", "red-main"]);
    expect(handled()).toBe(0);
    const to = canon(root, OWNER, "work", "handled", "red-main", "--to", s.change);
    expect(to.code).toBe(0);
    expect(to.out).toContain(`handled red-main: handed to ${s.change}`);
    expect(handled()).toBe(1);
  });
});
