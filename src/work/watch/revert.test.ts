import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { land } from "../land/land.ts";
import { dueItems } from "../reminders/agenda.ts";
import { start } from "../session/session.ts";
import { project, quiet, sh, startNew, ws } from "../testkit.ts";
import { redMain } from "./redmain.ts";
import { GREEN_REF, watch } from "./watch.ts";

// reason: each case lands real changes and runs real background floors and probes in worktrees (BR-2534 to BR-2536)
setDefaultTimeout(240_000);

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** test_command: runs one test file and writes a one-case JUnit report naming it. */
const RUN = `f="$1"; r="$2"
if sh "$f" >/dev/null 2>&1; then x=""; else x='<failure message="x"/>'; fi
printf '<testsuites><testsuite name="s"><testcase classname="c" name="%s" file="%s">%s</testcase></testsuite></testsuites>' "$f" "$f" "$x" > "$r"
[ -z "$x" ]
`;
/** floor: every test file, one report. */
const FLOOR = `r="$1"; out='<testsuites><testsuite name="s">'; rc=0
for f in t/*.test.sh; do if sh "$f" >/dev/null 2>&1; then x=""; else x='<failure message="x"/>'; rc=1; fi; out="$out<testcase classname=\\"c\\" name=\\"$f\\" file=\\"$f\\">$x</testcase>"; done
printf '%s</testsuite></testsuites>' "$out" > "$r"; exit $rc
`;

// reason: each landing starts a background watcher; with these thresholds it only waits, so the test drives every run itself with --now (BR-2311)
/** A project in after mode with one test file that passes while value.txt says good; main's first commit is green. */
async function repo(test = "grep -q good value.txt\n") {
  const root = project();
  roots.push(root);
  writeFileSync(join(root, "canon/config.yaml"), 'floor: sh floor.sh {report}\ntest_command: sh run.sh {file} {report}\ntests: ["t/*.test.sh"]\nfloor_timing: after\nfloor_quiet_minutes: 600\nfloor_max_untested: 100\nfloor_max_age_minutes: 600\nreview: none\n');
  writeFileSync(join(root, "run.sh"), RUN);
  writeFileSync(join(root, "floor.sh"), FLOOR);
  writeFileSync(join(root, "value.txt"), "good\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "setup");
  const mk = join(root, "t");
  mkdirSync(mk, { recursive: true });
  writeFileSync(join(mk, "a.test.sh"), test);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "test");
  await watch(ws(root), quiet, { now: true });
  return root;
}

/** Starts a change, writes `files` in its worktree, commits and lands it with --finish. */
async function landing(root: string, title: string, files: Record<string, string>) {
  const s = startNew(root, title);
  for (const [p, text] of Object.entries(files)) writeFileSync(join(s.worktree, p), text);
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  const out = await land(ws(s.worktree), { finish: true, timeoutMs: 60_000 }, quiet);
  expect(out.kind === "landed" ? "landed" : JSON.stringify(out).slice(0, 600)).toBe("landed");
  return s.change;
}

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => ({ subject: r.subject, detail: JSON.parse(r.detail) }));
const changeFile = (root: string, ref: string, change: string) => {
  const path = sh(root, "grep", "-l", `^id: ${change}$`, ref, "--", "canon/changes").split("\n")[0]!.replace(/^[^:]+:/, "");
  return sh(root, "show", `${ref}:${path}`);
};

describe("the background floor after a failure", () => {
  test("BR-2534 BR-2220: a failing test file that passes when run again unchanged is flaky: the commit counts as passed, main is not recorded as failing, and canon work due lists it", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "canon-flaky-")), "n");
    roots.push(counter);
    // fails on its first run only
    const root = await repo(`if [ -e ${counter} ]; then exit 0; fi; touch ${counter}; exit 1\n`);
    const tip = sh(root, "rev-parse", "main");
    expect(sh(root, "rev-parse", GREEN_REF)).toBe(tip);
    expect(events(root, "floor.flaky")).toEqual([{ subject: null, detail: expect.objectContaining({ sha: tip, files: ["t/a.test.sh"] }) }]);
    expect(redMain(ws(root).db)).toBeUndefined();
    const due = dueItems(ws(root));
    expect(due.ok && due.value.map((d) => d.key)).toContain("flaky:t/a.test.sh");
  });

  test("BR-2534 BR-2535 BR-2536: a real failure is located to the landing that caused it, reverted on main with its change reopened, and its work replayed on its branch", async () => {
    const root = await repo();
    const green = sh(root, "rev-parse", GREEN_REF);
    await landing(root, "Add notes", { "notes.txt": "n\n" });
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    await landing(root, "Add more notes", { "more.txt": "m\n" });
    expect(sh(root, "rev-parse", GREEN_REF)).toBe(green);
    await watch(ws(root), quiet, { now: true });
    const main = sh(root, "rev-parse", "main");
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe(`canon: revert ${bad} (the background floor failed on ${events(root, "floor.fail")[0]!.detail.sha.slice(0, 9)})`);
    expect(sh(root, "log", "-1", "--format=%B", "main")).toMatch(new RegExp(`^Canon-Reverts: ${bad} [0-9a-f]{40}$`, "m"));
    expect(sh(root, "show", "main:value.txt")).toBe("good");
    expect(sh(root, "show", "main:notes.txt")).toBe("n");
    expect(sh(root, "show", "main:more.txt")).toBe("m");
    expect(changeFile(root, "main", bad)).toMatch(/^status: open$/m);
    // the reverted main is tested again and passes
    expect(sh(root, "rev-parse", GREEN_REF)).toBe(main);
    expect(redMain(ws(root).db)).toBeUndefined();
    expect(sh(root, "show", `change/${bad}:value.txt`)).toBe("bad");
    expect(changeFile(root, `change/${bad}`, bad)).toMatch(/^status: open$/m);
    expect(events(root, "land.revert")).toEqual([{ subject: bad, detail: expect.objectContaining({ revert: main, branch: `change/${bad}`, files: ["t/a.test.sh"] }) }]);
    const due = dueItems(ws(root));
    expect(due.ok && due.value.find((d) => d.key === `reverted:${bad}`)?.next).toBe(`canon work start ${bad}, fix the failure, land again`);
    // the change is picked up again from its branch, with its work
    const again = start(ws(root, "agent:b"), { change: bad }, quiet);
    expect(again.ok).toBe(true);
    if (again.ok) expect(readFileSync(join(again.value.worktree, "value.txt"), "utf8")).toBe("bad\n");
  });

  test("BR-2536: a revert on main whose branch and land.revert were never written (the watcher was killed) is finished before the next test", async () => {
    const root = await repo();
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    await watch(ws(root), quiet, { now: true });
    const revert = sh(root, "rev-parse", "main");
    // as if killed after moving main: no branch, no land.revert
    expect([sh(root, "log", "-1", "--format=%s", "main"), events(root, "revert.skip").map((e) => e.detail.reason)]).toEqual([expect.stringContaining("revert"), []]);
    sh(root, "branch", "-D", `change/${bad}`);
    ws(root).db.db.query("DELETE FROM events WHERE kind = 'land.revert'").run();
    await watch(ws(root), quiet, { now: true });
    expect(events(root, "land.revert")).toEqual([{ subject: bad, detail: expect.objectContaining({ revert, branch: `change/${bad}`, files: ["t/a.test.sh"] }) }]);
    expect(sh(root, "show", `change/${bad}:value.txt`)).toBe("bad");
  });

  test("BR-2535: when the probe fails on the last green commit too it locates nothing, reverts nothing and leaves main for a fix change", async () => {
    const flag = join(mkdtempSync(join(tmpdir(), "canon-env-")), "broken");
    roots.push(flag);
    const root = await repo(`test ! -e ${flag}\n`);
    await landing(root, "Add notes", { "notes.txt": "n\n" });
    writeFileSync(flag, "x\n");
    const before = sh(root, "rev-parse", "main");
    await watch(ws(root), quiet, { now: true });
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(events(root, "revert.skip").map((e) => e.detail.reason)).toEqual([expect.stringContaining("fails on the last green commit")]);
    expect(redMain(ws(root).db)?.sha).toBe(before);
  });

  test("BR-2536: a revert that conflicts with a later landing is not made; main is left for a fix change", async () => {
    const root = await repo();
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    await landing(root, "Build on the value", { "value.txt": "bad but more\n" });
    const before = sh(root, "rev-parse", "main");
    await watch(ws(root), quiet, { now: true });
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(events(root, "revert.skip").map((e) => e.detail.reason)).toEqual([expect.stringContaining(`reverting ${bad} conflicts`)]);
    expect(events(root, "land.revert")).toEqual([]);
  });
});
