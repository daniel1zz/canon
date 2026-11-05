import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
