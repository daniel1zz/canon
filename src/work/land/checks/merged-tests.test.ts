import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../../testkit.ts";

// reason: these tests land changes through the spawned CLI, which waits out queue polls (C-111).
const TIMED = 60_000;
const CLI = join(import.meta.dir, "../../../invocation/main.ts");

async function canonIn(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

// A test file is a shell script: it writes a one-case JUnit report to $1 and fails only when both changes' marks are in it.
const TEST_FILE = [
  "#!/bin/sh",
  `printf '<testsuites><testsuite name="s"><testcase name="x works" classname="" /></testsuite></testsuites>' > "$1"`,
  "if [ -e fail-when-merged ] && grep -q '^# mark a' \"$0\" && grep -q '^# mark b' \"$0\"; then exit 1; fi",
  "if grep -q '^# broken' \"$0\"; then echo 'x works: expected 1, got 2'; exit 1; fi",
  "exit 0",
  "",
].join("\n");

function fixture(failWhenMerged: boolean) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: ["t/*.sh"]\ntest_command: "sh {file} {report}"\nreview: none\n`);
  mkdirSync(join(root, "t"), { recursive: true });
  writeFileSync(join(root, "t/x.sh"), TEST_FILE);
  if (failWhenMerged) writeFileSync(join(root, "fail-when-merged"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

/** Starts a change that puts `line` into t/x.sh (at the top or the end), commits it, and optionally runs canon work test. */
async function edit(root: string, title: string, line: string, where: "top" | "end", tested: boolean) {
  const s = startNew(root, title);
  const path = join(s.worktree, "t/x.sh");
  const text = readFileSync(path, "utf8");
  const [first, ...rest] = text.split("\n");
  writeFileSync(path, where === "top" ? [first, line, ...rest].join("\n") : `${text}${line}\n`);
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  if (tested) expect((await canonIn(s.worktree, "work", "test")).code).toBe(0);
  return s;
}

const rowsFor = (root: string, path: string) => ws(root).db.db.query<{ blob: string; source: string }, [string]>("SELECT blob, source FROM test_reports WHERE path = ?").all(path);

describe("a rebase that merges main's edits into a tested test file (#152)", () => {
  test("BR-2381: the landing tests the merged file on the tree being landed, records its report and lands", async () => {
    const root = fixture(false);
    const a = await edit(root, "A", "# mark a", "end", true);
    const b = await edit(root, "B", "# mark b", "top", true);
    expect((await canonIn(b.worktree, "work", "land")).code).toBe(0);
    const r = await canonIn(a.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("tested t/x.sh after the rebase, as its content there had no report: pass");
    const merged = sh(root, "rev-parse", "main:t/x.sh").trim();
    expect(rowsFor(root, "t/x.sh").some((x) => x.blob === merged && x.source === "test_command")).toBe(true);
  }, TIMED);

  test("BR-2381: a merged file that fails refuses the landing with reason check, naming the file and its output", async () => {
    const root = fixture(true);
    const a = await edit(root, "A", "# mark a", "end", true);
    const b = await edit(root, "B", "# mark b", "top", true);
    expect((await canonIn(b.worktree, "work", "land")).code).toBe(0);
    const before = sh(root, "rev-parse", "main").trim();
    const r = await canonIn(a.worktree, "work", "land");
    expect(r.code).toBe(1);
    expect(r.err).toContain("t/x.sh fails on the tree being landed, after the rebase");
    expect(sh(root, "rev-parse", "main").trim()).toBe(before);
  }, TIMED);

  test("BR-2381 BR-2542: a change that never tested its own version of the file has it run before queueing, and the merged version after the rebase; it lands with no test-report-missing", async () => {
    const root = fixture(false);
    const a = await edit(root, "A", "# mark a", "end", false);
    const b = await edit(root, "B", "# mark b", "top", true);
    expect((await canonIn(b.worktree, "work", "land")).code).toBe(0);
    const r = await canonIn(a.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("tested t/x.sh before landing, as it had no report of its content: pass");
    expect(r.out + r.err).toContain("tested t/x.sh after the rebase, as its content there had no report: pass");
    expect(r.out + r.err).not.toContain("test-report-missing");
  }, TIMED);

  test("BR-2381: with nothing merged into the file (main did not touch it) the landing runs no test of its own", async () => {
    const root = fixture(false);
    const a = await edit(root, "A", "# mark a", "end", true);
    const r = await canonIn(a.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain("after the rebase");
    expect(r.out + r.err).not.toContain("before landing");
  }, TIMED);
});

describe("the landing runs the related test files that have no report (BR-2542, D-141)", () => {
  test("BR-2542: a changed test file canon work test never ran is run before the landing queues; its report is recorded and the change lands", async () => {
    const root = fixture(false);
    const a = await edit(root, "A", "# mark a", "end", false);
    const blob = sh(a.worktree, "rev-parse", "HEAD:t/x.sh").trim();
    const r = await canonIn(a.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("tested t/x.sh before landing, as it had no report of its content: pass");
    expect(rowsFor(root, "t/x.sh").some((x) => x.blob === blob && x.source === "test_command")).toBe(true);
  }, TIMED);

  test("BR-2542: a related test file that fails before landing refuses with reason tests, its output in the message, nothing queued", async () => {
    const root = fixture(false);
    const a = await edit(root, "A", "# broken", "end", false);
    const before = sh(root, "rev-parse", "main").trim();
    const r = await canonIn(a.worktree, "work", "land");
    expect(r.code).toBe(1);
    expect(r.err).toContain("t/x.sh fails (BR-2542)");
    expect(r.err).toContain("x works: expected 1, got 2");
    expect(sh(root, "rev-parse", "main").trim()).toBe(before);
    const refused = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse' ORDER BY id DESC LIMIT 1").get()!;
    expect(JSON.parse(refused.detail).reason).toBe("tests");
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM queue").get()!.n).toBe(0);
  }, TIMED);

  test("BR-2542: a file canon work test already ran at its content is not run again by the landing", async () => {
    const root = fixture(false);
    const a = await edit(root, "A", "# mark a", "end", true);
    const r = await canonIn(a.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain("before landing");
  }, TIMED);
});
