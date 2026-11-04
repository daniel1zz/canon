import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { commandFor, selectTests } from "./verify.ts";

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const rule = ["BR", 7].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const ruleText = (title: string) => `---\nid: ${rule}\ntitle: ${title}\nstatus: active\n---\n\n## 规则\n\nx\n\n## 例子\n\n- a → b\n`;

/**
 * A project whose "tests" are files run by run.sh: it appends each path to runs.log and fails when the file holds FAILME.
 * a.ts ← b.ts; b.test.ts imports a directly, c.test.ts through b, d.test.ts nothing, e.test.ts names the rule, f.test.ts
 * names it only in a skipped test.
 */
function fixture(testCommand = "sh run.sh {file}") {
  const root = project();
  write(root, {
    "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "${testCommand}"\n`,
    "run.sh": 'echo "$1" >> runs.log\nif grep -q FAILME "$1"; then echo "boom in $1"; exit 1; fi\n',
    ".gitignore": "runs.log\n",
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
    "src/b.test.ts": 'import { a } from "./a.ts";\n',
    "src/c.test.ts": 'import { b } from "./b.ts";\n',
    "src/d.test.ts": "export {};\n",
    "src/e.test.ts": `it("${rule}: names the rule", () => {});\n`,
    "src/f.test.ts": `it.skip("${rule}: skipped", () => {});\n`,
    "README.md": "readme\n",
    // reason: canon work test ends with canon check (BR-2227), so the rule the tests name must exist
    "canon/rules/core/README.md": "---\ncode: [src]\n---\n# core\n\n## 术语\n\n- **x**：y\n",
    [`canon/rules/core/${rule}.md`]: ruleText("x"),
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  const wt = startNew(root, "work test").worktree;
  return { root, wt };
}

const reasons = (wt: string) => {
  const r = selectTests(ws(wt), false);
  if (!r.ok) throw new Error(r.error.message);
  return Object.fromEntries(r.value.selected.map((s) => [s.file, s.reasons.join("; ")]));
};

const runs = (wt: string) => (existsSync(join(wt, "runs.log")) ? readFileSync(join(wt, "runs.log"), "utf8").trim().split("\n") : []);

describe("canon work test selection", () => {
  test("BR-2157: a changed source file selects the tests importing it directly or through other files", () => {
    const { wt } = fixture();
    write(wt, { "src/a.ts": "export const a = 2;\n" }); // uncommitted counts too
    expect(reasons(wt)).toEqual({ "src/b.test.ts": "imports src/a.ts", "src/c.test.ts": "imports src/a.ts (through src/b.ts)" });
  });

  test("BR-2157: a deleted file still selects the tests whose import names it without an extension or as .js", () => {
    const { wt } = fixture();
    write(wt, { "src/g.test.ts": 'import "./a";\n', "src/h.test.ts": 'import { a } from "./a.js";\n' });
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "tests importing a without its extension");
    sh(wt, "rm", "-q", "src/a.ts");
    expect(reasons(wt)).toEqual({
      "src/b.test.ts": "imports src/a.ts",
      "src/c.test.ts": "imports src/a.ts (through src/b.ts)",
      "src/g.test.ts": "changed; imports src/a.ts",
      "src/h.test.ts": "changed; imports src/a.ts",
    });
  });

  test("BR-2157: a changed test file is selected as changed, an untracked one too", () => {
    const { wt } = fixture();
    write(wt, { "src/d.test.ts": "export const d = 1;\n" });
    sh(wt, "commit", "-qam", "edit d");
    write(wt, { "src/g.test.ts": "export {};\n" });
    expect(reasons(wt)).toEqual({ "src/d.test.ts": "changed", "src/g.test.ts": "changed" });
  });

  test("BR-2157: a changed rule file selects the tests whose running titles name it, not skipped ones", () => {
    const { wt } = fixture();
    write(wt, { [`canon/rules/core/${rule}.md`]: ruleText("y") });
    expect(reasons(wt)).toEqual({ "src/e.test.ts": `names ${rule}` });
  });

  test("BR-2157: a change file's rules count as touched rules", () => {
    const { wt } = fixture();
    const dir = join(wt, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".md"))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("rules: []", `rules:\n  - ${rule}`));
    expect(reasons(wt)).toEqual({ "src/e.test.ts": `names ${rule}` });
  });

  test("BR-2157: a change no test imports and no rule names selects nothing, and the CLI says why", () => {
    const { wt } = fixture();
    write(wt, { "README.md": "changed\n" });
    expect(reasons(wt)).toEqual({});
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 test file(s) related to this change");
    expect(r.out).toContain("Not selected:");
    expect(r.out).toContain("nothing to run");
    expect(runs(wt)).toEqual([]);
  });

  test("BR-2157: the CLI lists each selected file with its reason before running", () => {
    const { wt } = fixture();
    write(wt, { "src/a.ts": "export const a = 2;\n" });
    const r = canon(wt, "work", "test");
    expect(r.out).toMatch(/src\/c\.test\.ts\s+imports src\/a\.ts \(through src\/b\.ts\)/);
    expect(r.out.indexOf("imports src/a.ts")).toBeLessThan(r.out.indexOf("pass "));
  });
});

describe("canon work test runs", () => {
  test("BR-2158: each selected file runs in its own test_command, and all passing exits 0 with a summary", () => {
    const { wt } = fixture();
    write(wt, { "src/a.ts": "export const a = 2;\n" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(runs(wt)).toEqual(["src/b.test.ts", "src/c.test.ts"]);
    expect(r.out).toMatch(/pass\s+\d+\.\ds\s+src\/b\.test\.ts/);
    expect(r.out).toMatch(/2 file\(s\): 2 passed, 0 failed, \d+\.\ds/);
  });

  test("BR-2158: a failing file is marked with its exit code and output, listed again, and the command exits 1", () => {
    const { wt } = fixture();
    write(wt, { "src/a.ts": "export const a = 2;\n", "src/c.test.ts": 'import { b } from "./b.ts";\n// FAILME\n' });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL\s+\d+\.\ds\s+src\/c\.test\.ts \(exit 1\)/);
    expect(r.out).toContain("boom in src/c.test.ts");
    expect(r.out).toContain("1 passed, 1 failed");
    expect(r.out).toContain("failed: src/c.test.ts");
    const ev = ws(wt).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'work.test' ORDER BY id").all();
    expect(JSON.parse(ev.at(-1)!.detail)).toMatchObject({ all: false, files: 2, failed: 1 });
  });

  test("BR-2158: a failing file shows only the last 40 lines of its output, and the summary counts files, passes, failures and time", () => {
    const { wt } = fixture("sh lines.sh {file}");
    write(wt, { "lines.sh": 'case "$1" in *c.test.ts) seq 1 50; exit 3;; esac\n', "src/a.ts": "export const a = 2;\n" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL\s+\d+\.\ds\s+src\/c\.test\.ts \(exit 3\)/);
    const shown = r.out.split("\n").filter((l) => /^ {4}\d+$/.test(l)).map((l) => Number(l.trim()));
    expect(shown).toEqual(Array.from({ length: 40 }, (_, i) => i + 11));
    expect(r.out).toMatch(/\n2 file\(s\): 1 passed, 1 failed, \d+\.\ds\nfailed: src\/c\.test\.ts\n/);
  });

  test("BR-2158: a run that selects nothing runs no command and still records one work.test event", () => {
    const { wt } = fixture();
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to run");
    expect(runs(wt)).toEqual([]);
    const ev = ws(wt).db.db.query<{ subject: string | null; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'work.test' ORDER BY id").all();
    expect(ev.length).toBe(1);
    expect(JSON.parse(ev[0]!.detail)).toMatchObject({ all: false, files: 0, failed: 0, typecheck: null, check: 0 });
    expect(ev[0]!.subject).toBe("C-1");
  });

  test("BR-2158: the path is quoted for the shell", () => {
    expect(commandFor("bun test {file}", "src/it's.test.ts")).toBe(`bun test 'src/it'\\''s.test.ts'`);
  });

  test("BR-2159: --all runs every test file even when nothing is related", () => {
    const { wt } = fixture();
    const r = canon(wt, "work", "test", "--all");
    expect(r.code).toBe(0);
    expect(r.out).toContain("every test file, 5");
    expect(runs(wt)).toEqual(["src/b.test.ts", "src/c.test.ts", "src/d.test.ts", "src/e.test.ts", "src/f.test.ts"]);
  });

  test("BR-2159: of 3 test files, a change to a file one of them imports runs 1 without --all and 3 with it", () => {
    const root = project();
    write(root, {
      "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\n',
      "run.sh": 'echo "$1" >> runs.log\n',
      ".gitignore": "runs.log\n",
      "src/a.ts": "export const a = 1;\n",
      "src/one.test.ts": 'import { a } from "./a.ts";\n',
      "src/two.test.ts": "export {};\n",
      "src/three.test.ts": "export {};\n",
    });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "three tests");
    const wt = startNew(root, "three").worktree;
    write(wt, { "src/a.ts": "export const a = 2;\n" });
    expect(canon(wt, "work", "test").code).toBe(0);
    expect(runs(wt)).toEqual(["src/one.test.ts"]);
    writeFileSync(join(wt, "runs.log"), "");
    const all = canon(wt, "work", "test", "--all");
    expect(all.code).toBe(0);
    expect(all.out.split("\n")[0]).toContain("every test file, 3");
    expect(runs(wt).sort()).toEqual(["src/one.test.ts", "src/three.test.ts", "src/two.test.ts"]);
  });

  test("BR-2160: without test_command canon work test exits 2 and says what to write", () => {
    const { wt } = fixture();
    write(wt, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\n' });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(2);
    expect(r.err).toContain('test_command: "bun test {file}"');
    expect(canon(wt, "check").code).not.toBe(2);
  });
});

/** The fixture with `typecheck_command: "sh tc.sh"`; tc.sh logs its run and fails with exit 2 while TYPEFAIL exists. */
function typecheckFixture() {
  const f = fixture();
  write(f.wt, {
    "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\ntypecheck_command: "sh tc.sh"\n',
    "tc.sh": 'echo typecheck >> runs.log\nif [ -e TYPEFAIL ]; then echo "type error in src/a.ts"; exit 2; fi\n',
  });
  sh(f.wt, "add", "-A");
  sh(f.wt, "commit", "-qm", "typecheck");
  return f;
}

const lastEvent = (wt: string) => {
  const ev = ws(wt).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'work.test' ORDER BY id").all();
  return JSON.parse(ev.at(-1)!.detail) as Record<string, unknown>;
};

describe("canon work test type check and canon check", () => {
  test("BR-2226: typecheck_command runs once before the selected tests, and passing it exits 0", () => {
    const { wt } = typecheckFixture();
    write(wt, { "src/a.ts": "export const a = 2;\n" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(runs(wt)).toEqual(["typecheck", "src/b.test.ts", "src/c.test.ts"]);
    expect(r.out).toMatch(/pass\s+\d+\.\ds\s+typecheck\n/);
    expect(lastEvent(wt)).toMatchObject({ typecheck: 0, failed: 0, check: 0 });
  });

  test("BR-2226: a failing type check still runs the tests, shows its output and exits 1", () => {
    const { wt } = typecheckFixture();
    write(wt, { "src/a.ts": "export const a = 2;\n", TYPEFAIL: "" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL\s+\d+\.\ds\s+typecheck \(exit 2\)/);
    expect(r.out).toContain("    type error in src/a.ts");
    expect(runs(wt)).toEqual(["typecheck", "src/b.test.ts", "src/c.test.ts"]);
    expect(r.out).toContain("2 file(s): 2 passed, 0 failed");
    expect(r.out).toContain("typecheck failed (exit 2)");
    expect(lastEvent(wt)).toMatchObject({ files: 2, failed: 0, typecheck: 2 });
  });

  test("BR-2226: the type check runs when nothing is selected and with --all, and its failure still exits 1", () => {
    const { wt } = typecheckFixture();
    write(wt, { TYPEFAIL: "" });
    const r = canon(wt, "work", "test");
    expect(r.out).toContain("nothing to run");
    expect(runs(wt)).toEqual(["typecheck"]);
    expect(r.code).toBe(1);
    writeFileSync(join(wt, "runs.log"), "");
    expect(canon(wt, "work", "test", "--all").code).toBe(1);
    expect(runs(wt)[0]).toBe("typecheck");
  });

  test("BR-2226: without typecheck_command no type check runs or is printed; a non-string value is a config error", () => {
    const { wt } = fixture();
    write(wt, { "src/a.ts": "export const a = 2;\n" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("typecheck");
    expect(lastEvent(wt)).toMatchObject({ typecheck: null });
    write(wt, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\ntypecheck_command: 3\n' });
    const bad = canon(wt, "work", "test");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("typecheck_command");
  });

  test("BR-2227: canon check findings are listed after passing tests and exit 1; none prints ok", () => {
    const { wt } = fixture();
    write(wt, { "src/a.ts": "export const a = 2;\n" });
    const clean = canon(wt, "work", "test");
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("canon check: ok");
    write(wt, { [`canon/rules/core/${rule}.md`]: ruleText("x").replace("- a → b", "- a → b, see BR-999") });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(1);
    expect(r.out).toContain("3 file(s): 3 passed, 0 failed");
    expect(r.out).toMatch(/ref-dangling\s+canon\/rules\/core\/BR-7\.md: names BR-999, which does not exist/);
    expect(r.out).toContain("canon check: 1 finding(s)");
    expect(r.out.indexOf("canon check: 1 finding(s)")).toBeGreaterThan(r.out.lastIndexOf("pass "));
    expect(lastEvent(wt)).toMatchObject({ failed: 0, check: 1 });
  });

  test("BR-2227: canon check runs when nothing is selected, and failing tests and findings are both reported", () => {
    const { wt } = fixture();
    write(wt, { "canon/notes/N-1.md": "---\nid: N-1\ntitle: n\n---\n\nBR-999\n" });
    const none = canon(wt, "work", "test");
    expect(none.out).toContain("nothing to run");
    expect(none.out).toContain("canon check: 1 finding(s)");
    expect(none.code).toBe(1);
    expect(lastEvent(wt)).toMatchObject({ files: 0, check: 1 });

    write(wt, { "src/a.ts": "export const a = 2;\n", "src/c.test.ts": 'import { b } from "./b.ts";\n// FAILME\n' });
    const both = canon(wt, "work", "test");
    expect(both.code).toBe(1);
    expect(both.out).toContain("failed: src/c.test.ts");
    expect(both.out).toContain("canon check: 1 finding(s)");
  });
});

describe("canon work test review notes", () => {
  const decision = ["D", 1].join("-");
  const other = ["BR", 8].join("-");
  const decisionText = `---\nid: ${decision}\ntitle: d\nstatus: proposed\n---\n\n## 背景\n\nx\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA\n\n## 后果\n\nx\n`;
  /** Records the notes a landing's review left on the given documents, as land.ok stores them (BR-2145). */
  const leaveNotes = (root: string, reviewed: string[], notes: string[]) => ws(root).db.event("agent:x", "land.ok", ["C", 90].join("-"), { reviewed, notes });
  const noteLines = (out: string) => out.split("\n").filter((l) => l.startsWith("Open review note on "));

  test("BR-2249: notes on a changed rule and on a changed decision are listed after canon check, and the run still exits 0", () => {
    const { root, wt } = fixture();
    leaveNotes(root, [rule, decision], [`${rule}: 例子缺少边界另一侧`, `${decision}: 方案缺少来源`]);
    write(wt, { [`canon/rules/core/${rule}.md`]: ruleText("y"), [`canon/decisions/${decision}.md`]: decisionText });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(noteLines(r.out)).toEqual([`Open review note on ${rule}: ${rule}: 例子缺少边界另一侧 (C-90, ${today})`, `Open review note on ${decision}: ${decision}: 方案缺少来源 (C-90, ${today})`]);
    expect(r.out.indexOf("Open review note on")).toBeGreaterThan(r.out.indexOf("canon check: ok"));
    expect(r.out).toContain("a hint, not a failure");
  });

  test("BR-2249: a rule only listed in the change's rules: counts; a rule the change does not touch is not listed", () => {
    const { root, wt } = fixture();
    leaveNotes(root, [rule, other], [`${rule}: 例子缺少边界另一侧`, `${other}: 标题太长`]);
    const changes = join(wt, "canon/changes");
    const file = join(changes, readdirSync(changes)[0]!);
    writeFileSync(file, readFileSync(file, "utf8").replace("rules: []", `rules:\n  - ${rule}`));
    const r = canon(wt, "work", "test");
    expect(noteLines(r.out).map((l) => l.split(":")[0])).toEqual([`Open review note on ${rule}`]);
  });

  test("BR-2249: no open note on what the change touches prints nothing; a failing test still exits 1 with the notes listed", () => {
    const { root, wt } = fixture();
    write(wt, { "src/a.ts": "export const a = 2;\n" });
    const quiet = canon(wt, "work", "test");
    expect(quiet.code).toBe(0);
    expect(quiet.out).not.toContain("Open review note");
    leaveNotes(root, [rule], [`${rule}: 例子缺少边界另一侧`]);
    write(wt, { [`canon/rules/core/${rule}.md`]: ruleText("y"), "src/e.test.ts": `it("${rule}: names the rule", () => {});\n// FAILME\n` });
    const failing = canon(wt, "work", "test");
    expect(failing.code).toBe(1);
    expect(noteLines(failing.out)).toHaveLength(1);
  });
});

describe("canon work test session text budget", () => {
  const hint = (err: string) => err.split("\n").filter((l) => l.startsWith("hint session-text:"));

  test("BR-2257: canon work test prints the over-budget hint on stderr and exits as it would without it", () => {
    const { wt } = fixture();
    const quiet = canon(wt, "work", "test");
    expect([quiet.code, hint(quiet.err)]).toEqual([0, []]);
    write(wt, { "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\nsession_text_budget: 1\n` });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(hint(r.err)).toHaveLength(1);
    expect(hint(r.err)[0]).toContain("over session_text_budget 1 ");
  });
});

/** The fixture with `always_tests` set to `globs` (a YAML value), committed in the change's worktree. */
function alwaysFixture(globs: string, extra: Record<string, string> = {}) {
  const f = fixture();
  write(f.wt, { "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\nalways_tests: ${globs}\n`, ...extra });
  sh(f.wt, "add", "-A");
  sh(f.wt, "commit", "-qm", "always_tests");
  return f;
}

describe("canon work test always_tests", () => {
  test("BR-2297: an always_tests file is selected and run when the change touches nothing related, reason always", () => {
    const { wt } = alwaysFixture('["src/d.test.ts"]');
    write(wt, { "README.md": "changed\n" });
    expect(reasons(wt)).toEqual({ "src/d.test.ts": "always" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/src\/d\.test\.ts\s+always/);
    expect(runs(wt)).toEqual(["src/d.test.ts"]);
  });

  test("BR-2297: without always_tests the same change selects nothing", () => {
    const { wt } = fixture();
    write(wt, { "README.md": "changed\n" });
    expect(reasons(wt)).toEqual({});
  });

  test("BR-2297: a changed always_tests file lists always after changed; a glob selects every file it matches", () => {
    const { wt } = alwaysFixture('["src/**/scan-*.test.ts"]', { "src/x/scan-a.test.ts": "export {};\n", "src/y/scan-b.test.ts": "export {};\n" });
    expect(reasons(wt)).toEqual({ "src/x/scan-a.test.ts": "changed; always", "src/y/scan-b.test.ts": "changed; always" });
  });

  test("BR-2297: a glob that matches no test file, missing or outside tests, is printed and exits 1 while the rest still runs", () => {
    const { wt } = alwaysFixture('["src/d.test.ts", "src/gone.test.ts", "tools/x.test.ts"]', { "tools/x.test.ts": "export {};\n" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(1);
    expect(r.out).toContain('always_tests: "src/gone.test.ts" matches no test file');
    expect(r.out).toContain('always_tests: "tools/x.test.ts" matches no test file');
    expect(r.out).not.toContain('always_tests: "src/d.test.ts"');
    expect(runs(wt)).toEqual(["src/d.test.ts"]);
    expect(lastEvent(wt)).toMatchObject({ unmatched: 2 });
  });

  test("BR-2297: with --all every test file still runs, the unmatched glob is still printed and exits 1", () => {
    const { wt } = alwaysFixture('["src/gone.test.ts"]');
    const r = canon(wt, "work", "test", "--all");
    expect(r.code).toBe(1);
    expect(r.out).toContain('always_tests: "src/gone.test.ts" matches no test file');
    expect(runs(wt)).toEqual(["src/b.test.ts", "src/c.test.ts", "src/d.test.ts", "src/e.test.ts", "src/f.test.ts"]);
  });

  test("BR-2297: always_tests that is not a list of non-empty strings fails every command with exit 2", () => {
    const { wt } = fixture();
    for (const bad of ['"src/d.test.ts"', "[3]", '[""]']) {
      write(wt, { "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\nalways_tests: ${bad}\n` });
      const r = canon(wt, "check");
      expect(r.code).toBe(2);
      expect(r.err).toContain("always_tests");
    }
    write(wt, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\nalways_tests: null\n' });
    expect(canon(wt, "check").code).not.toBe(2);
  });
});
