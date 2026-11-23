import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { land } from "../land/land.ts";
import { dueItems } from "../reminders/agenda.ts";
import { start, startChore } from "../session/session.ts";
import { project, quiet, sh, startNew, ws } from "../testkit.ts";
import { redMain, startFixMain } from "./redmain.ts";
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

/** floor without `{report}`: every test file, only an exit code, so canon cannot tell which file failed. */
const PLAIN_FLOOR = `rc=0; for f in t/*.test.sh; do sh "$f" >/dev/null 2>&1 || rc=1; done; exit $rc
`;
const CONFIG = 'floor: sh floor.sh {report}\ntest_command: sh run.sh {file} {report}\ntests: ["t/*.test.sh"]\nfloor_timing: after\nfloor_quiet_minutes: 600\nfloor_max_untested: 100\nfloor_max_age_minutes: 600\nreview: none\n';

// reason: each landing starts a background watcher; with these thresholds it only waits, so the test drives every run itself with --now (BR-2311)
/** A project in after mode with one test file that passes while value.txt says good; main's first commit is green. */
async function repo(test = "grep -q good value.txt\n", config = CONFIG, floor = FLOOR) {
  const root = project();
  roots.push(root);
  writeFileSync(join(root, "canon/config.yaml"), config);
  writeFileSync(join(root, "run.sh"), RUN);
  writeFileSync(join(root, "floor.sh"), floor);
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
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(s.worktree, p, ".."), { recursive: true });
    writeFileSync(join(s.worktree, p), text);
  }
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

  test("BR-2534 BR-2535 BR-2536: a real failure is located to the landing that caused it, reverted on main with its change reopened, its work replayed on its branch, a land.revert event written and a reverted:C-n agenda item until it lands again", async () => {
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

  test("BR-2535 BR-2536: a floor without {report} is probed with the whole floor, not typecheck_command, so the landing that broke it is found and reverted", async () => {
    // typecheck_command passes on every commit: probing with it would clear every landing
    const config = CONFIG.replace("floor: sh floor.sh {report}", "floor: sh floor.sh").concat("typecheck_command: \"true\"\n");
    const root = await repo(undefined, config, PLAIN_FLOOR);
    await landing(root, "Add notes", { "notes.txt": "n\n" });
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    await watch(ws(root), quiet, { now: true });
    expect([events(root, "revert.skip").map((e) => e.detail.reason), sh(root, "log", "-1", "--format=%s", "main")]).toEqual([[], `canon: revert ${bad} (the background floor failed on ${events(root, "floor.fail")[0]!.detail.sha.slice(0, 9)})`]);
    expect(sh(root, "show", "main:value.txt")).toBe("good");
    expect(sh(root, "show", "main:notes.txt")).toBe("n");
  });

  test("BR-2535: when the probe passes on the last landing too it says it cannot tell landings apart, not that no landing is to blame", async () => {
    const config = CONFIG.concat("typecheck_command: \"true\"\n");
    // the floor fails without naming a test file: its report is never written
    const root = await repo(undefined, config, FLOOR.replace('printf', 'grep -q good value.txt || exit 1; printf'));
    await landing(root, "Break the value", { "value.txt": "bad\n" });
    await watch(ws(root), quiet, { now: true });
    expect(events(root, "revert.skip").map((e) => e.detail.reason)).toEqual([expect.stringMatching(/does not reproduce the failure and cannot tell landings apart$/)]);
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

describe("when the background floor does not locate or revert", () => {
  const skips = (root: string) => events(root, "revert.skip").map((e) => e.detail.reason as string);
  const mainSubject = (root: string) => sh(root, "log", "-1", "--format=%s", "main");
  /** Commits `files` straight onto main in the primary checkout, as no landing. */
  const commitOnMain = (root: string, files: Record<string, string>) => {
    for (const [p, text] of Object.entries(files)) writeFileSync(join(root, p), text);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "direct commit");
  };

  test("BR-2535: a commit that is no landing is never a candidate; with no landing between green and the failure nothing is located", async () => {
    const root = await repo();
    commitOnMain(root, { "value.txt": "bad\n" });
    const before = sh(root, "rev-parse", "main");
    await watch(ws(root), quiet, { now: true });
    expect(skips(root)).toEqual([expect.stringMatching(/^no landing between [0-9a-f]{9} and [0-9a-f]{9} recorded its base$/)]);
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(redMain(ws(root).db)?.sha).toBe(before);
  });

  test("BR-2535: setup runs before each probe, and a failing test file a landing added counts as passing where it does not exist, so that landing is found and reverted", async () => {
    // the test file passes only where setup ran in that worktree
    const config = CONFIG.concat('setup: "touch .setup-ran"\n');
    const root = await repo("test -e .setup-ran\n", config);
    writeFileSync(join(root, ".gitignore"), ".setup-ran\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "ignore the setup mark");
    await watch(ws(root), quiet, { now: true });
    await landing(root, "Add notes", { "notes.txt": "n\n" });
    // reason: the landing runs a test file it adds (BR-2542), so this one passes in a change's worktree and fails anywhere else
    const bad = await landing(root, "Add a failing test", { "t/b.test.sh": 'case "$PWD" in *.worktrees/C-*) exit 0;; esac; exit 1\n' });
    await watch(ws(root), quiet, { now: true });
    expect([skips(root), mainSubject(root)]).toEqual([[], `canon: revert ${bad} (the background floor failed on ${events(root, "floor.fail")[0]!.detail.sha.slice(0, 9)})`]);
    expect(events(root, "land.revert")[0]!.detail.files).toEqual(["t/b.test.sh"]);
    expect(sh(root, "ls-tree", "--name-only", "main", "t/")).toBe("t/a.test.sh");
  });

  test("BR-2536 BR-2535: a chore found as the cause is not reverted; once a fix change holds the failure, a later failure is not located", async () => {
    // reason: a landing after the fix change started is what this case checks; the pause (BR-2644) would refuse it. Setting
    // policies makes the after-mode landing ask the canon on PATH for its schema (BR-2224), so a stand-in that accepts any
    // config goes first on PATH, and the case does not depend on which canon this machine has installed.
    const bin = mkdtempSync(join(tmpdir(), "canon-fake-bin-"));
    roots.push(bin);
    writeFileSync(join(bin, "canon"), "#!/bin/sh\necho '{}'\n");
    chmodSync(join(bin, "canon"), 0o755);
    const realPath = process.env["PATH"];
    process.env["PATH"] = `${bin}:${realPath}`;
    try {
      const root = await repo(undefined, CONFIG.concat("policies:\n  landing:\n    pause_on_red_main: false\n"));
      const c = startChore(ws(root), { title: "break the value" }, quiet);
      if (!c.ok) throw new Error(c.error.message);
      writeFileSync(join(c.value.worktree, "value.txt"), "bad\n");
      sh(c.value.worktree, "commit", "-qam", "break");
      expect((await land(ws(c.value.worktree), { finish: true, timeoutMs: 60_000 }, quiet)).kind).toBe("landed");
      await watch(ws(root), quiet, { now: true });
      expect(skips(root)).toEqual([expect.stringMatching(/^the landing [0-9a-f]{9} is a chore, with no change to send back$/)]);
      expect(startFixMain(ws(root, "agent:fixer"), quiet).ok).toBe(true);
      await landing(root, "Add notes", { "notes.txt": "n\n" });
      await watch(ws(root), quiet, { now: true });
      expect(skips(root)[1]).toMatch(/^C-\d+ is already fixing main$/);
      expect(events(root, "land.revert")).toEqual([]);
    } finally {
      process.env["PATH"] = realPath;
    }
  });

  test("BR-2535: after one automatic revert, main failing again under the same record reverts nothing more", async () => {
    const flag = join(mkdtempSync(join(tmpdir(), "canon-env-")), "flag");
    roots.push(flag);
    // checking the reverted tree raises the flag, and the floor fails while it is up, outside every test file
    const config = CONFIG.concat(`typecheck_command: 'case "$PWD" in *revert-*) touch ${flag};; esac'\n`);
    const root = await repo(undefined, config, FLOOR.replace("exit $rc", `test -e ${flag} && rc=1; exit $rc`));
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    await watch(ws(root), quiet, { now: true });
    expect(events(root, "land.revert").map((e) => e.subject)).toEqual([bad]);
    expect(skips(root)).toEqual(["a landing was already reverted since main began failing"]);
    expect(redMain(ws(root).db)?.sha).toBe(sh(root, "rev-parse", "main"));
  });

  test("BR-2536: a landing that touched a design_signals path is not reverted", async () => {
    const root = await repo(undefined, CONFIG.concat('design_signals: {persistent: ["value.txt"]}\n'));
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    const before = sh(root, "rev-parse", "main");
    await watch(ws(root), quiet, { now: true });
    expect(skips(root)).toEqual([`${bad} touched persistent (design_signals), which a revert of its code cannot undo`]);
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2536: the reverted tree is checked: a typecheck_command that fails there, failing test files that still fail, or canon check failing there each leave main as it is", async () => {
    // a later landing needs a file the bad landing added
    const tc = await repo(undefined, CONFIG.concat("typecheck_command: \"test ! -e needs.txt || test -e base.txt\"\n"));
    await landing(tc, "Break the value", { "value.txt": "bad\n", "base.txt": "b\n" });
    await landing(tc, "Need the base", { "needs.txt": "n\n" });
    await watch(ws(tc), quiet, { now: true });
    expect(skips(tc)).toEqual(["typecheck_command fails on the reverted tree"]);

    // two failures from two landings: reverting the first still leaves the second failing
    const two = await repo();
    writeFileSync(join(two, "other.txt"), "good\n");
    writeFileSync(join(two, "t/b.test.sh"), "grep -q good other.txt\n");
    sh(two, "add", "-A");
    sh(two, "commit", "-qm", "second test");
    await watch(ws(two), quiet, { now: true });
    await landing(two, "Break the value", { "value.txt": "bad\n" });
    await landing(two, "Break the other", { "other.txt": "bad\n" });
    await watch(ws(two), quiet, { now: true });
    expect(skips(two)).toEqual(["the failing test files still fail on the reverted tree"]);

    // a later landing's change file names a rule the bad landing added: without it canon check fails
    const refs = await repo();
    const rules = "canon/rules/billing";
    const bad = await landing(refs, "Break the value with a rule", {
      "value.txt": "bad\n",
      "src/billing/refund.txt": "r\n",
      [`${rules}/README.md`]: "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **退款**：钱怎么退回去\n",
      [`${rules}/BR-90.md`]: "---\nid: BR-90\ntitle: 退款\nstatus: active\nuntested: fixture\nbusiness: 退款\n---\n\n## 规则\n\n退款三十天内通过。\n\n## 例子\n\n- 第 30 天 → 通过\n",
    });
    const s = startNew(refs, "Follow BR-90");
    const file = join(s.worktree, "canon/changes", readdirSync(join(s.worktree, "canon/changes")).find((f) => f.startsWith(s.change))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("## 为什么\n", "## 为什么\n\n按 BR-90 补说明。\n"));
    sh(s.worktree, "commit", "-qam", "names BR-90");
    expect((await land(ws(s.worktree), { finish: true, timeoutMs: 60_000 }, quiet)).kind).toBe("landed");
    await watch(ws(refs), quiet, { now: true });
    expect(skips(refs)).toEqual(["canon check fails on the reverted tree"]);
    expect(changeFile(refs, "main", bad)).toMatch(/^status: done$/m);
  });

  test("BR-2536 BR-2535: when main keeps moving while the revert is checked it is tried 3 times and left; such tries are no revert, so the next failure is still located and reverted", async () => {
    const root = await repo();
    const count = join(mkdtempSync(join(tmpdir(), "canon-count-")), "n");
    roots.push(count);
    // checking a reverted tree moves main with an empty commit, the first 3 times only
    const bump = `case "$PWD" in *revert-*) n=$(cat ${count} 2>/dev/null || echo 0); if [ "$n" -lt 3 ]; then echo $((n + 1)) > ${count}; git -C ${root} commit -q --allow-empty -m bump; fi;; esac`;
    writeFileSync(join(root, "canon/config.yaml"), CONFIG.concat(`typecheck_command: '${bump}'\n`));
    sh(root, "commit", "-qam", "moving typecheck");
    await watch(ws(root), quiet, { now: true });
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    await watch(ws(root), quiet, { now: true });
    expect(skips(root)).toEqual([`main kept moving while the revert of ${bad} was checked`]);
    expect(events(root, "revert.start")).toHaveLength(4);
    expect(events(root, "land.revert").map((e) => e.subject)).toEqual([bad]);
    expect(sh(root, "show", "main:value.txt")).toBe("good");
  });

  test("BR-2536: a change branch that already exists is not replaced; land.revert says so", async () => {
    const root = await repo();
    const green = sh(root, "rev-parse", "main");
    const bad = await landing(root, "Break the value", { "value.txt": "bad\n" });
    sh(root, "branch", "-f", `change/${bad}`, green);
    await watch(ws(root), quiet, { now: true });
    expect(sh(root, "show", "main:value.txt")).toBe("good");
    expect(sh(root, "rev-parse", `change/${bad}`)).toBe(green);
    expect(events(root, "land.revert")).toEqual([{ subject: bad, detail: expect.objectContaining({ branch: `change/${bad} already existed; not replaced` }) }]);
  });
});
