import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, processReaper, waitGone } from "../src/work/testkit.ts";

// C-376, #126: scripts/test.sh gives the tests a TMPDIR of their own. bun reads the listing of every directory above a
// process's cwd, so a shared TMPDIR with hundreds of thousands of leftover test directories made every canon process a
// test started take 1.7 s instead of 0.1 s. A `bun` that only records what it was given stands in for the real one.

const SCRIPT = join(import.meta.dir, "test.sh");

function fixture(bunBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "canon-test-sh-"));
  const bin = join(dir, "bin");
  const root = join(dir, "root");
  const shared = join(dir, "shared-tmp");
  for (const d of [bin, root, shared]) mkdirSync(d);
  writeFileSync(join(bin, "bun"), `#!/bin/sh\n${bunBody}\n`);
  chmodSync(join(bin, "bun"), 0o755);
  const seen = join(dir, "seen");
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["sh", SCRIPT, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, TMPDIR: shared, CANON_TEST_TMP_ROOT: root, SEEN: seen },
    });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  return { dir, root, shared, seen, run };
}

describe("scripts/test.sh temporary directory", () => {
  test("the tests run with a TMPDIR under the run root, not the shared one, and it is gone when the run ends", () => {
    const f = fixture('echo "$TMPDIR" > "$SEEN"\necho "$*" >> "$SEEN"\ntest -d "$TMPDIR/git" && test -f "$GIT_CONFIG_GLOBAL"');
    const r = f.run("src/a.test.ts", "-t", "x y");
    expect(r.code).toBe(0);
    const [tmp, args] = readFileSync(f.seen, "utf8").trim().split("\n");
    expect(tmp!.startsWith(`${f.root}/canon-test.`)).toBe(true);
    expect(tmp!.startsWith(f.shared)).toBe(false);
    expect(args).toBe("test --timeout 30000 src/a.test.ts -t x y");
    expect(existsSync(tmp!)).toBe(false);
  });

  test("the exit code of bun is the exit code of the script, and the directory is removed after a failure too", () => {
    const f = fixture('echo "$TMPDIR" > "$SEEN"\nexit 3');
    expect(f.run("src/a.test.ts").code).toBe(3);
    expect(existsSync(readFileSync(f.seen, "utf8").trim())).toBe(false);
  });

  test("a directory left by a run whose runner is gone is removed; one whose runner is alive and ones not named like a run stay", () => {
    const f = fixture("exit 0");
    const gone = join(f.root, "canon-test.999999999.abcdef");
    const alive = join(f.root, `canon-test.${process.pid}.abcdef`);
    const odd = join(f.root, "canon-test.notapid.abcdef");
    for (const d of [gone, alive, odd]) mkdirSync(d);
    expect(f.run().code).toBe(0);
    expect([existsSync(gone), existsSync(alive), existsSync(odd)]).toEqual([false, true, true]);
  });

  test("a run root that cannot hold the directory fails loudly instead of testing in the shared TMPDIR", () => {
    const f = fixture("exit 0");
    const r = Bun.spawnSync(["sh", SCRIPT], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${join(f.dir, "bin")}:${process.env["PATH"]}`, TMPDIR: f.shared, CANON_TEST_TMP_ROOT: join(f.dir, "no-such-root") } });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(f.shared, "git"))).toBe(false);
  });
});

// C-429: processes a test run leaves running are named and killed, and fail the run. They are found by their working
// directory inside the run's directory, because a detached process has its own group and pid 1 as its parent.
const REAP = join(import.meta.dir, "reap-test-procs.sh");
const reaper = processReaper();
afterEach(() => reaper.killAll());

/** A process that lives until killed (at most 61 s), with its working directory at `cwd`. */
function sleeper(cwd: string, detached = true): number {
  const p = Bun.spawn(["sleep", "61"], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore", detached });
  return reaper.pid(p.pid);
}

function reap(args: string[], root?: string) {
  const r = Bun.spawnSync(["sh", REAP, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(root ? { CANON_TEST_TMP_ROOT: root } : {}) } });
  return { code: r.exitCode, err: r.stderr.toString() };
}

describe("scripts/test.sh processes left running", () => {
  const LEAK = 'mkdir -p "$TMPDIR/repo"\ncd "$TMPDIR/repo"\nsleep 61 </dev/null >/dev/null 2>&1 &\necho $! > "$SEEN"';

  test("a run whose tests all pass but leave a process running fails, names the process and kills it", async () => {
    const f = fixture(`${LEAK}\nexit 0`);
    const r = f.run();
    const pid = reaper.pid(Number(readFileSync(f.seen, "utf8").trim()));
    expect(r.code).toBe(1);
    expect(r.err).toContain("test run left processes behind");
    expect(r.err).toContain(`${pid} sleep 61`);
    await waitGone(pid, "leftover of a passing run");
  });

  test("a failing run that leaves a process keeps bun's exit code and kills the process", async () => {
    const f = fixture(`${LEAK}\nexit 3`);
    expect(f.run().code).toBe(3);
    await waitGone(reaper.pid(Number(readFileSync(f.seen, "utf8").trim())), "leftover of a failing run");
  });

  test("a run that leaves nothing passes and says nothing about processes", () => {
    const f = fixture("exit 0");
    const r = f.run();
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("process");
  });

  test("a new run kills what an ended run left in its directory, and not what a run still going has in its own", async () => {
    const f = fixture("exit 0");
    const ended = join(f.root, "canon-test.999999999.abcdef");
    const going = join(f.root, `canon-test.${process.pid}.abcdef`);
    for (const d of [ended, going]) mkdirSync(join(d, "repo"), { recursive: true });
    const old = sleeper(join(ended, "repo"));
    const live = sleeper(join(going, "repo"));
    expect(f.run().code).toBe(0);
    await waitGone(old, "leftover of an ended run");
    expect(existsSync(ended)).toBe(false);
    expect(alive(live)).toBe(true);
  });
});

describe("scripts/reap-test-procs.sh", () => {
  test("--run kills only the processes inside the directory, not others in the same process group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canon-reap-"));
    const outside = mkdtempSync(join(tmpdir(), "canon-reap-out-"));
    const inside = sleeper(dir, false);
    const sameGroup = sleeper(outside, false);
    const r = reap(["--run", dir]);
    expect(r.code).toBe(1);
    await waitGone(inside, "process inside the run directory");
    expect(alive(sameGroup)).toBe(true);
    expect(reap(["--run", dir]).code).toBe(0);
  });

  test("run by hand it lists what ended runs left without killing it, kills it with --kill, and leaves runs still going alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "canon-reap-root-"));
    const ended = join(root, "canon-test.999999999.abcdef");
    const going = join(root, `canon-test.${process.pid}.abcdef`);
    for (const d of [ended, going]) mkdirSync(d);
    const old = sleeper(ended);
    const live = sleeper(going);
    const listed = reap([], root);
    expect(listed.code).toBe(1);
    expect(listed.err).toContain(`${old} sleep 61`);
    expect(listed.err).not.toContain(`${live} sleep 61`);
    expect(listed.err).toContain("--kill");
    expect(alive(old)).toBe(true);
    expect(reap(["--kill"], root).code).toBe(1);
    await waitGone(old, "leftover killed with --kill");
    expect(alive(live)).toBe(true);
    expect(reap([], root).code).toBe(0);
  });

  test("a symlink named like an ended run is not followed: what runs in its target is neither listed, killed nor removed (#163)", async () => {
    const root = mkdtempSync(join(tmpdir(), "canon-reap-root-"));
    const victim = mkdtempSync(join(tmpdir(), "canon-reap-victim-"));
    const link = join(root, "canon-test.999999999.abcdef");
    symlinkSync(victim, link);
    const bystander = sleeper(victim);
    const listed = reap([], root);
    expect(listed.code).toBe(0);
    expect(listed.err).not.toContain(`${bystander}`);
    expect(reap(["--kill"], root).code).toBe(0);
    expect(reap(["--run", link]).code).toBe(0);
    const f = fixture("exit 0");
    symlinkSync(victim, join(f.root, "canon-test.999999998.abcdef"));
    expect(f.run().code).toBe(0);
    expect(alive(bystander)).toBe(true);
    expect(existsSync(victim)).toBe(true);
  });

  test("an unknown argument is a usage error", () => {
    expect(reap(["--nope"]).code).toBe(2);
  });
});
