import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importedPaths } from "../../knowledge/query/query.ts";
import { project, sh, startNew, ws } from "../testkit.ts";
import { EventEmitter } from "node:events";
import { cliReader, commandFor, machineDeps, selectTests, workTest, type WorkTestDeps, type WorkTestResult } from "./verify.ts";
import type { CpuSample } from "./pool.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
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
function fixture(testCommand = "sh run.sh {file}", extra: Record<string, string> = {}) {
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
    ...extra,
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

/**
 * The fixture plus a CLI: src/invocation/main.ts imports the command table src/invocation/tree.ts, which imports two command modules.
 * src/a/commands.ts registers `work one` and imports src/a/a.ts; src/b/commands.ts registers `two`. Tests that spawn
 * it: src/a/a.test.ts names `work one`, src/a/spaced.test.ts names it in one literal, src/b/b.test.ts names `two`,
 * src/c/c.test.ts names no command. src/d/d.test.ts has a "two" literal but never builds the CLI's path.
 */
function cliFixture(extra: Record<string, string> = {}) {
  const spawn = (dir: string, words: string) => `const MAIN = join(import.meta.dir, "..", "invocation", "main.ts");\nBun.spawnSync(["bun", MAIN, ${words}]);\n`;
  return fixture("sh run.sh {file}", {
    "src/invocation/main.ts": 'import "./tree.ts";\nimport "./strict.ts";\n',
    "src/invocation/strict.ts": "export const strict = 1;\n",
    "src/invocation/tree.ts": 'import "../a/commands.ts";\nimport "../b/commands.ts";\n',
    "src/a/commands.ts": 'import "./a.ts";\nexport const aCommands = { commands: [entry("one", 10, one, "work")] };\n',
    "src/a/a.ts": "export const one = 1;\n",
    "src/b/commands.ts": '// entry("one", 1, x, "work") in a comment registers nothing\nexport const bCommands = { commands: [entry("two", 20, two)] };\n',
    "src/a/a.test.ts": spawn("a", '"work", "one", "--json"'),
    "src/a/spaced.test.ts": spawn("a", '..."work one --json".split(" ")'),
    "src/b/b.test.ts": spawn("b", '"two"'),
    "src/c/c.test.ts": spawn("c", '...process.argv'),
    "src/d/d.test.ts": 'const args = ["two"];\n',
    ...extra,
  });
}

describe("canon work test selection: tests that spawn the CLI", () => {
  test("BR-2157: a changed command module selects the tests that name its command, with the command in the reason", () => {
    const { wt } = cliFixture();
    write(wt, { "src/a/commands.ts": 'import "./a.ts";\nexport const aCommands = { commands: [entry("one", 10, one, "work")] }; // changed\n' });
    expect(reasons(wt)).toEqual({
      "src/a/a.test.ts": "drives canon work one (src/a/commands.ts changed)",
      "src/a/spaced.test.ts": "drives canon work one (src/a/commands.ts changed)",
    });
  });

  test("BR-2157: a file a command module imports selects the tests that name the command, and the chain is shown", () => {
    const { wt } = cliFixture();
    write(wt, { "src/a/a.ts": "export const one = 2;\n" });
    expect(reasons(wt)).toEqual({
      "src/a/a.test.ts": "drives canon work one (src/a/a.ts changed, through src/a/commands.ts)",
      "src/a/spaced.test.ts": "drives canon work one (src/a/a.ts changed, through src/a/commands.ts)",
    });
  });

  test("BR-2157: a change to another command's module selects neither the tests of this command nor tests naming no command", () => {
    const { wt } = cliFixture();
    write(wt, { "src/b/commands.ts": "export const bCommands = { commands: [entry(\"two\", 20, two)] }; // changed\n" });
    expect(reasons(wt)).toEqual({ "src/b/b.test.ts": "drives canon two (src/b/commands.ts changed)" });
  });

  test("BR-2157: a change to the command table or to what the CLI's entry file imports selects every test that spawns the CLI", () => {
    const { wt } = cliFixture();
    write(wt, { "src/invocation/strict.ts": "export const strict = 2;\n" });
    const through = "runs the CLI (src/invocation/strict.ts changed, through src/invocation/main.ts)";
    expect(reasons(wt)).toEqual({ "src/a/a.test.ts": through, "src/a/spaced.test.ts": through, "src/b/b.test.ts": through, "src/c/c.test.ts": through });
    write(wt, { "src/invocation/strict.ts": "export const strict = 1;\n", "src/invocation/tree.ts": 'import "../a/commands.ts";\nimport "../b/commands.ts";\n// changed\n' });
    const table = "runs the CLI (src/invocation/tree.ts changed, through src/invocation/main.ts)";
    expect(reasons(wt)).toEqual({ "src/a/a.test.ts": table, "src/a/spaced.test.ts": table, "src/b/b.test.ts": table, "src/c/c.test.ts": table });
  });

  test("BR-2157: a test that names a command without spawning the CLI is not selected by that command's change", () => {
    const { wt } = cliFixture();
    write(wt, { "src/b/commands.ts": "export const bCommands = { commands: [entry(\"two\", 20, two)] }; // changed\n" });
    expect(reasons(wt)["src/d/d.test.ts"]).toBeUndefined();
  });

  test("BR-2157: the CLI lists a spawning test with the command it drives", () => {
    const { wt } = cliFixture();
    write(wt, { "src/b/commands.ts": "export const bCommands = { commands: [entry(\"two\", 20, two)] }; // changed\n" });
    const r = canon(wt, "work", "test");
    expect(r.out).toMatch(/src\/b\/b\.test\.ts\s+drives canon two \(src\/b\/commands\.ts changed\)/);
    expect(runs(wt)).toEqual(["src/b/b.test.ts"]);
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
    expect(r.out).toMatch(/\n2 file\(s\): 1 passed, 1 failed, \d+\.\ds, at most 1 at once\nfailed: src\/c\.test\.ts\n/);
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

  test("BR-2160: {file} and {report} are replaced, each quoted for the shell", () => {
    expect(commandFor("bun test {file} --reporter-outfile={report}", "src/a.test.ts", "/tmp/r x/report.xml")).toBe("bun test 'src/a.test.ts' --reporter-outfile='/tmp/r x/report.xml'");
    expect(commandFor("bun test {file} --reporter-outfile={report}", "src/a.test.ts")).toBe("bun test 'src/a.test.ts' --reporter-outfile={report}");
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
  test("BR-2297 BR-2157: an always_tests file is selected and run when the change touches nothing related, reason always", () => {
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

  test("BR-2297 BR-2158 BR-2227: a glob that matches no test file, missing or outside tests, is printed and exits 1 while the rest still runs", () => {
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

  test("BR-2297 BR-2045: always_tests that is not a list of non-empty strings fails every command with exit 2", () => {
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

/** A machine whose CPU counters show `idle` of 8 CPUs idle at every look. */
function fakeCpu(idleCpus: number) {
  let idle = 0;
  let total = 0;
  return (): CpuSample => {
    idle += idleCpus * 100;
    total += 800;
    return { idle, total, count: 8 };
  };
}

/** The fixture's worktree with `n` test files `src/t<i>.test.ts` that import the changed `src/a.ts`, run by `script`. */
function jobsFixture(n: number, script: string, testJobs: string) {
  const { wt } = fixture("sh run.sh {file}");
  const tests = Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/t${i + 1}.test.ts`, 'import "./a.ts";\n']));
  write(wt, { ...tests, "run.sh": script, "src/a.ts": "export const a = 2;\n", "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\ntest_jobs: ${testJobs}\n` });
  // b.test.ts and c.test.ts import a too; only the t files are meant to run here
  sh(wt, "rm", "-q", "src/b.test.ts", "src/c.test.ts");
  return wt;
}

/** The deps of an idle machine whose signals are an emitter; stopping is the real one, which only signals groups the run started. */
function fakeDeps(over: Partial<WorkTestDeps> = {}) {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const d: WorkTestDeps = {
    ...machineDeps,
    readCpu: fakeCpu(6),
    tickMs: 40,
    graceMs: 300,
    parallelism: () => 8,
    signals: { on: (s, f) => signals.on(s, f), off: (s, f) => signals.off(s, f) },
    exit: (c) => void exits.push(c),
    ...over,
  };
  return { d, signals, exits };
}

async function runWorkTest(wt: string, d: WorkTestDeps): Promise<{ lines: string[]; result: WorkTestResult }> {
  const lines: string[] = [];
  const r = await workTest(ws(wt), false, (l) => lines.push(l), d);
  if (!r.ok) throw new Error(r.error.message);
  return { lines, result: r.value };
}

/** Each file sleeps `$SLEEP`, so files started within one window overlap; files named *slow* sleep longer. */
const sleeper = 'echo "$1" >> runs.log\ncase "$1" in *t1*) sleep 0.6;; *) sleep 0.25;; esac\n';

/**
 * Like `sleeper`, but the order comes from marker files, not from how long each file sleeps (a loaded machine
 * stretches sleeps by more than any margin): t1 ends only after t2, t3 and t4 have ended; t2 and t3 end only
 * after t1, t2 and t3 have all started (so three really ran together); t4 ends at once. Each wait stops after 60 s.
 */
const ordered = [
  'echo "$1" >> runs.log',
  'n=$(basename "$1" .test.ts)',
  'touch "started.$n"',
  'wait_for() { i=0; for f in "$@"; do while [ ! -e "$f" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i + 1)); done; done; }',
  'case "$n" in',
  '  t1) wait_for ended.t2 ended.t3 ended.t4;;',
  '  t2|t3) wait_for started.t1 started.t2 started.t3;;',
  'esac',
  'touch "ended.$n"',
  "",
].join("\n");

describe("canon work test runs several files at once", () => {
  test("BR-2302 BR-2158: on an idle machine up to the cap run together, results print as files end, the summary says how many ran at once", async () => {
    const wt = jobsFixture(4, ordered, "3");
    const { lines, result } = await runWorkTest(wt, fakeDeps().d);
    expect(lines).toContain("test files: up to 3 at once (test_jobs 3, 8 CPUs), another one only while at least 1 CPU is idle");
    const ended = lines.filter((l) => /^pass /.test(l)).map((l) => l.trim().split(/\s+/).at(-1));
    expect(ended.at(-1)).toBe("src/t1.test.ts"); // t1 is the slow one, started first and printed last
    expect(ended).toHaveLength(4);
    expect(result).toMatchObject({ files: 4, failed: 0 });
    expect(lines.some((l) => /^4 file\(s\): 4 passed, 0 failed, \d+\.\ds, at most 3 at once$/.test(l))).toBe(true);
    expect(lastEvent(wt)).toMatchObject({ jobs: 3, peak: 3, cpu: "ok", rerun: 0, rerunFiles: [], passedAlone: 0, passedAloneFiles: [], rerunSkipped: 0, files: 4 });
  });

  test("BR-2302 BR-2158: a failing file's output stays under its own FAIL line when files run together", async () => {
    const wt = jobsFixture(3, 'echo "$1" >> runs.log\nsleep 0.2\ncase "$1" in *t2*) echo "boom in $1"; exit 1;; esac\n', "1");
    const { lines } = await runWorkTest(wt, fakeDeps().d);
    const i = lines.findIndex((l) => l.startsWith("FAIL") && l.includes("src/t2.test.ts"));
    expect(lines[i + 1]).toBe("    boom in src/t2.test.ts");
  });

  test("BR-2302: on a busy machine files run one at a time", async () => {
    const wt = jobsFixture(4, sleeper, "auto");
    const { result } = await runWorkTest(wt, fakeDeps({ readCpu: fakeCpu(0.01) }).d);
    expect(result.failed).toBe(0);
    expect(lastEvent(wt)).toMatchObject({ peak: 1, jobs: 4 });
  });

  test("BR-2302: test_jobs 1 runs one at a time, says so, and never reads the CPU", async () => {
    const wt = jobsFixture(3, sleeper, "1");
    let looks = 0;
    const { lines } = await runWorkTest(wt, fakeDeps({ readCpu: () => (looks++, undefined) }).d);
    expect(lines).toContain("test files: one at a time (test_jobs 1, 8 CPUs)");
    expect(looks).toBe(0);
    expect(lastEvent(wt)).toMatchObject({ jobs: 1, peak: 1 });
  });

  test("BR-2302: auto on 3 CPUs is one at a time", async () => {
    const wt = jobsFixture(2, sleeper, "auto");
    const { lines } = await runWorkTest(wt, fakeDeps({ parallelism: () => 3 }).d);
    expect(lines).toContain("test files: one at a time (test_jobs auto, 3 CPUs)");
  });

  test("BR-2302: CPU counters that cannot be read at the start mean one at a time, said in one line", async () => {
    const wt = jobsFixture(3, sleeper, "3");
    const { lines } = await runWorkTest(wt, fakeDeps({ readCpu: () => undefined }).d);
    expect(lines).toContain("test files: one at a time (CPU usage cannot be read)");
    expect(lastEvent(wt)).toMatchObject({ peak: 1, cpu: "unreadable" });
  });

  test("BR-2302: counters that stall mid-run print one line and record cpu stalled", async () => {
    const wt = jobsFixture(3, sleeper, "3");
    let n = 0;
    const live = fakeCpu(6);
    const frozen = { idle: 1, total: 1, count: 8 };
    const { lines } = await runWorkTest(wt, fakeDeps({ readCpu: () => (n++ < 1 ? live() : frozen) }).d);
    expect(lines.filter((l) => l.startsWith("CPU time counters did not advance"))).toHaveLength(1);
    expect(lastEvent(wt)).toMatchObject({ cpu: "stalled", peak: 1 });
    expect(Number(lastEvent(wt)["stalledWindows"])).toBeGreaterThan(0);
  });

  test("BR-2302: a run that selects nothing prints no test_jobs line", async () => {
    const wt = jobsFixture(0, sleeper, "3");
    write(wt, { "src/a.ts": "export const a = 1;\n" });
    sh(wt, "checkout", "--", "src/a.ts");
    const { lines } = await runWorkTest(wt, fakeDeps().d);
    expect(lines).toContain("nothing to run");
    expect(lines.some((l) => l.startsWith("test files:"))).toBe(false);
  });

  test("BR-2159: --all runs the same way", async () => {
    const wt = jobsFixture(3, sleeper, "3");
    const lines: string[] = [];
    const r = await workTest(ws(wt), true, (l) => lines.push(l), fakeDeps().d);
    expect(r.ok).toBe(true);
    expect(lines[0]).toContain("every test file");
    expect(lines).toContain("test files: up to 3 at once (test_jobs 3, 8 CPUs), another one only while at least 1 CPU is idle");
  });

  test("BR-2045 BR-2302: test_jobs other than a whole number of at least 1 or lower-case auto fails every command with exit 2", () => {
    const { wt } = fixture();
    for (const bad of ['"3"', "Auto", "0", "-1", "1.5", "many"]) {
      write(wt, { "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\ntest_jobs: ${bad}\n` });
      const r = canon(wt, "check");
      expect(r.code).toBe(2);
      expect(r.err).toContain("test_jobs");
    }
    for (const good of ["auto", "3", "null"]) {
      write(wt, { "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\ntest_jobs: ${good}\n` });
      expect(canon(wt, "check").code).not.toBe(2);
    }
  });
});

describe("canon work test reruns alone", () => {
  /** Fails when another file ran at the same time: every file marks itself, sleeps, and counts the marks. */
  const clash = 'touch "running.$$"\nsleep 0.4\nn=$(ls running.* | wc -l)\nsleep 0.2\nrm "running.$$"\necho "$1" >> runs.log\nif [ "$n" -gt 1 ]; then echo "clash in $1"; exit 1; fi\n';

  test("BR-2303 BR-2158: files that fail only while running together pass alone and count as passed, once each", async () => {
    const wt = jobsFixture(2, clash, "2");
    const { lines, result } = await runWorkTest(wt, fakeDeps().d);
    expect(lines.filter((l) => l.startsWith("FAIL")).length).toBe(2);
    expect(lines).toContain("rerunning alone 2 file(s) that failed while other files ran");
    expect(lines.filter((l) => /^pass .*\(alone\)$/.test(l)).map((l) => l.trim().split(/\s+/)[2])).toEqual(["src/t1.test.ts", "src/t2.test.ts"]);
    expect(lines).toContain("failed alongside other files, passed alone: src/t1.test.ts, src/t2.test.ts");
    expect(lines.some((l) => /^2 file\(s\): 2 passed, 0 failed, /.test(l))).toBe(true);
    expect(result).toMatchObject({ files: 2, failed: 0 });
    expect(lastEvent(wt)).toMatchObject({ files: 2, failed: 0, rerun: 2, rerunFiles: ["src/t1.test.ts", "src/t2.test.ts"], passedAlone: 2, passedAloneFiles: ["src/t1.test.ts", "src/t2.test.ts"], rerunSkipped: 0 });
  });

  test("BR-2303: a file that still fails alone is a failure, shown with (alone)", async () => {
    const wt = jobsFixture(2, 'sleep 0.3\ncase "$1" in *t2*) echo "real boom"; exit 1;; esac\n', "2");
    const { lines, result } = await runWorkTest(wt, fakeDeps().d);
    expect(lines.some((l) => /^FAIL .*src\/t2\.test\.ts \(alone\) \(exit 1\)$/.test(l))).toBe(true);
    expect(lines).toContain("failed: src/t2.test.ts");
    expect(lines.some((l) => l.startsWith("failed alongside"))).toBe(false);
    expect(result).toMatchObject({ files: 2, failed: 1 });
    expect(lastEvent(wt)).toMatchObject({ rerun: 1, passedAlone: 0, passedAloneFiles: [] });
  });

  test("BR-2303: more than 3 files failing together are not rerun, and all count as failed", async () => {
    const wt = jobsFixture(5, "sleep 0.4\nexit 1\n", "5");
    const { lines, result } = await runWorkTest(wt, fakeDeps().d);
    expect(lines).toContain("not rerunning alone: 5 files failed while other files ran (more than 3), so they count as failed");
    expect(lines.some((l) => l.startsWith("rerunning alone"))).toBe(false);
    expect(result).toMatchObject({ files: 5, failed: 5 });
    expect(lastEvent(wt)).toMatchObject({ rerun: 0, rerunFiles: [], rerunSkipped: 5 });
  });

  test("BR-2303: exactly 3 failing together are rerun", async () => {
    const wt = jobsFixture(3, clash, "3");
    const { lines, result } = await runWorkTest(wt, fakeDeps().d);
    expect(lines).toContain("rerunning alone 3 file(s) that failed while other files ran");
    expect(result).toMatchObject({ files: 3, failed: 0 });
    expect(lastEvent(wt)).toMatchObject({ rerun: 3, passedAlone: 3, rerunSkipped: 0 });
  });

  test("BR-2303: with test_jobs 1 a failing file is not rerun", async () => {
    const wt = jobsFixture(2, 'echo "$1" >> runs.log\ncase "$1" in *t2*) exit 1;; esac\n', "1");
    const { lines, result } = await runWorkTest(wt, fakeDeps().d);
    expect(lines.some((l) => l.startsWith("rerunning alone") || l.startsWith("not rerunning"))).toBe(false);
    expect(runs(wt).filter((r) => r.includes("t2"))).toEqual(["src/t2.test.ts"]);
    expect(result).toMatchObject({ files: 2, failed: 1 });
    expect(lastEvent(wt)).toMatchObject({ rerun: 0 });
  });

  test("BR-2303: a file that fails while it is the only one running is not rerun", async () => {
    const wt = jobsFixture(2, 'echo "$1" >> runs.log\ncase "$1" in *t1*) exit 1;; esac\n', "2");
    // t1 fails at once, before the first window ends and t2 starts
    const { lines } = await runWorkTest(wt, fakeDeps({ tickMs: 5000 }).d);
    expect(lines.some((l) => l.startsWith("rerunning alone"))).toBe(false);
    expect(runs(wt).filter((r) => r.includes("t1"))).toEqual(["src/t1.test.ts"]);
  });
});

describe("canon work test stops on a signal", () => {
  /** Waits until `file` exists in `dir`. */
  async function until(file: string) {
    for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(25);
    expect(existsSync(file)).toBe(true);
  }

  test("BR-2304: SIGTERM while files run stops them, counts running and not started, skips canon check and exits 143", async () => {
    const wt = jobsFixture(4, 'sleep 30 &\necho $! >> "kids.$$"\ntouch "started.$$"\nwait\n', "2");
    const { d, signals, exits } = fakeDeps();
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    // the script writes its kid pid before touching started.<pid>, so 2 started files mean 2 kid files
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 2) await Bun.sleep(25);
    signals.emit("SIGTERM", "SIGTERM");
    const r = await run;
    expect(exits).toEqual([143]);
    expect(lines).toContain("stopped by SIGTERM: 2 test file(s) were running, 2 not started");
    expect(lines.some((l) => l.startsWith("canon check"))).toBe(false);
    expect(r.ok && r.value.signal).toBe("SIGTERM");
    expect(lastEvent(wt)).toMatchObject({ signal: "SIGTERM", files: 0, failed: 0 });
    const kids = readdirSync(wt).filter((f) => f.startsWith("kids.")).map((f) => Number(readFileSync(join(wt, f), "utf8").trim()));
    expect(kids).toHaveLength(2);
    for (const pid of kids) expect(() => process.kill(pid, 0)).toThrow(); // the files' own children are gone too
  });

  test("BR-2304: SIGHUP is handled like SIGTERM and exits 129; SIGINT exits 130", async () => {
    for (const [sig, code] of [["SIGHUP", 129], ["SIGINT", 130]] as const) {
      const wt = jobsFixture(2, 'touch "started.$$"\nsleep 5\n', "1");
      const { d, signals, exits } = fakeDeps();
      const lines: string[] = [];
      const run = workTest(ws(wt), false, (l) => lines.push(l), d);
      while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 1) await Bun.sleep(25);
      signals.emit(sig, sig);
      await run;
      expect(exits).toEqual([code]);
      expect(lines).toContain(`stopped by ${sig}: 1 test file(s) were running, 1 not started`);
      }
  });

  test("BR-2304: a second signal while the stop waits turns the hurry flag on", async () => {
    const wt = jobsFixture(1, 'touch "started.$$"\nsleep 5\n', "1");
    let hurriedAtEnd = false;
    const { d, signals } = fakeDeps({
      stop: async (_groups, hurried) => {
        for (let i = 0; i < 100 && !hurried(); i++) await Bun.sleep(20);
        hurriedAtEnd = hurried();
        return undefined;
      },
    });
    const run = workTest(ws(wt), false, () => {}, d);
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 1) await Bun.sleep(25);
    signals.emit("SIGTERM", "SIGTERM");
    await Bun.sleep(60);
    signals.emit("SIGINT", "SIGINT");
    await run;
    expect(hurriedAtEnd).toBe(true);
  });

  test("BR-2304: a file that ends by a signal after canon was told to stop is no failure and no rerun", async () => {
    const wt = jobsFixture(2, 'touch "started.$$"\nsleep 0.3\nkill -INT $$\n', "2");
    const { d, signals } = fakeDeps();
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 1) await Bun.sleep(25);
    signals.emit("SIGINT", "SIGINT"); // the files are killed by their own INT a moment later
    await run;
    await Bun.sleep(600);
    expect(lines.some((l) => l.startsWith("FAIL") || l.startsWith("rerunning") || l.startsWith("not rerunning"))).toBe(false);
    expect(lastEvent(wt)).toMatchObject({ signal: "SIGINT", failed: 0, files: 0 });
  });

  test("BR-2304: a file that ends by a signal just before canon gets the stop signal is not a failure either", async () => {
    const wt = jobsFixture(1, 'touch "started.$$"\nkill -INT $$\n', "1");
    const { d, signals } = fakeDeps({ graceMs: 400 });
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 1) await Bun.sleep(25);
    await Bun.sleep(100);
    signals.emit("SIGINT", "SIGINT");
    await run;
    expect(lines.some((l) => l.startsWith("FAIL"))).toBe(false);
    expect(lastEvent(wt)).toMatchObject({ signal: "SIGINT", failed: 0, files: 0 });
  });

  test("BR-2304: a file killed by a signal while canon got none is an ordinary failure", async () => {
    const wt = jobsFixture(1, "kill -TERM $$\n", "1");
    const { lines, result } = await runWorkTest(wt, fakeDeps({ graceMs: 50 }).d);
    expect(lines.some((l) => /^FAIL .*\(exit 143\)$/.test(l))).toBe(true);
    expect(result).toMatchObject({ files: 1, failed: 1 });
  });

  test("BR-2304: a file that traps SIGTERM and exits 1 is no failure; the counts are those taken at the signal", async () => {
    const wt = jobsFixture(3, 'trap "exit 1" TERM\ntouch "started.$$"\nsleep 30 &\nwait\n', "2");
    const { d, signals, exits } = fakeDeps();
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 2) await Bun.sleep(25);
    signals.emit("SIGTERM", "SIGTERM");
    await run;
    expect(exits).toEqual([143]);
    expect(lines.some((l) => l.startsWith("FAIL"))).toBe(false);
    expect(lines).toContain("stopped by SIGTERM: 2 test file(s) were running, 1 not started");
    expect(lastEvent(wt)).toMatchObject({ signal: "SIGTERM", files: 0, failed: 0 });
  });

  test("BR-2304: a type check stopped by the signal records no typecheck result, prints no FAIL and starts nothing after it", async () => {
    const wt = jobsFixture(2, "exit 0\n", "1");
    write(wt, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\ntypecheck_command: "sh tc.sh"\n', "tc.sh": 'trap "exit 2" TERM\ntouch tc.started\nsleep 30 &\nwait\n' });
    const { d, signals } = fakeDeps();
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    await until(join(wt, "tc.started"));
    signals.emit("SIGTERM", "SIGTERM");
    await run;
    await Bun.sleep(200);
    expect(lastEvent(wt)).toMatchObject({ signal: "SIGTERM", typecheck: null });
    expect(lines.some((l) => l.startsWith("FAIL") || l.startsWith("test files:") || l.startsWith("pass"))).toBe(false);
  });

  test("BR-2304: when reporting the stop throws, canon still exits with the signal's code and says so on standard error", async () => {
    const wt = jobsFixture(1, 'touch "started.$$"\nsleep 30 &\nwait\n', "1");
    const { d, signals, exits } = fakeDeps();
    const errors: string[] = [];
    const real = console.error;
    console.error = (m: string) => void errors.push(String(m));
    try {
      const run = workTest(ws(wt), false, (l) => {
        if (l.startsWith("stopped by")) throw new Error("output closed");
      }, d);
      while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 1) await Bun.sleep(25);
      signals.emit("SIGINT", "SIGINT");
      await run;
    } finally {
      console.error = real;
    }
    expect(exits).toEqual([130]);
    expect(errors.some((e) => e.includes("stopping after SIGINT failed: output closed"))).toBe(true);
  });

  test("BR-2304: a background process left by a file that already ended is stopped with the running files", async () => {
    const wt = jobsFixture(2, 'case "$1" in *t1*) sleep 30 >/dev/null 2>&1 &\necho $! > bg.pid;;\n*) touch "started.$$"; sleep 30 & wait;;\nesac\n', "1");
    const { d, signals } = fakeDeps();
    const run = workTest(ws(wt), false, () => {}, d);
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 1) await Bun.sleep(25);
    const bg = Number(readFileSync(join(wt, "bg.pid"), "utf8").trim());
    expect(() => process.kill(bg, 0)).not.toThrow(); // still alive: t1 ended, its group did not
    signals.emit("SIGTERM", "SIGTERM");
    await run;
    await Bun.sleep(100);
    expect(() => process.kill(bg, 0)).toThrow();
  });

  test("BR-2304: after the files have ended and before canon check no stop listener is left, so a signal then kills canon as usual", async () => {
    const wt = jobsFixture(1, "exit 0\n", "1");
    const { d, signals } = fakeDeps();
    const seen: number[] = [];
    await workTest(ws(wt), false, (l) => {
      if (l.startsWith("canon check")) seen.push(signals.listenerCount("SIGTERM") + signals.listenerCount("SIGINT") + signals.listenerCount("SIGHUP"));
    }, d);
    expect(seen).toEqual([0]);
    expect(lastEvent(wt)["signal"]).toBeUndefined();
  });

  test("BR-2227 BR-2304: a run stopped by a signal runs no canon check, so a finding in the worktree is not reported", async () => {
    const wt = jobsFixture(1, 'touch "started.$$"\nsleep 30 &\nwait\n', "1");
    write(wt, { "canon/rules/core/BR-999.md": ruleText("dangling").replace("x\n\n## 例子", "refers to BR-998\n\n## 例子").replace(`id: ${rule}`, "id: BR-999") }); // a finding canon check would list
    const { d, signals } = fakeDeps();
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 1) await Bun.sleep(25);
    signals.emit("SIGTERM", "SIGTERM");
    await run;
    expect(lines.some((l) => l.startsWith("canon check") || l.includes("ref-dangling"))).toBe(false);
  });

  test("BR-2304: signals during a run that reached the pool are on; after the files finish canon check runs with them off", async () => {
    const wt = jobsFixture(1, "exit 0\n", "1");
    const { d, signals } = fakeDeps();
    await runWorkTest(wt, d);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGHUP")).toBe(0);
  });

  test("BR-2304: during the type check a signal stops it, with 0 files running and all of them not started", async () => {
    const wt = jobsFixture(2, "exit 0\n", "1");
    write(wt, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh run.sh {file}"\ntypecheck_command: "sh tc.sh"\n', "tc.sh": 'touch tc.started\nsleep 5\n' });
    const { d, signals, exits } = fakeDeps();
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    await until(join(wt, "tc.started"));
    signals.emit("SIGTERM", "SIGTERM");
    await run;
    expect(exits).toEqual([143]);
    expect(lines.some((l) => /^stopped by SIGTERM: 0 test file\(s\) were running, \d+ not started$/.test(l))).toBe(true);
  });

  test("BR-2304: during the rerun, files that failed together and are not rerun yet count as not started, not failed", async () => {
    const wt = jobsFixture(2, 'touch "started.$$"\nsleep 0.3\nif [ "$(ls started.* | wc -l)" -le 2 ]; then exit 1; fi\nsleep 5\n', "2");
    const { d, signals } = fakeDeps();
    const lines: string[] = [];
    const run = workTest(ws(wt), false, (l) => lines.push(l), d);
    for (let i = 0; i < 400 && !lines.some((l) => l.startsWith("rerunning alone")); i++) await Bun.sleep(25);
    expect(lines.some((l) => l.startsWith("rerunning alone"))).toBe(true);
    while (readdirSync(wt).filter((f) => f.startsWith("started.")).length < 3) await Bun.sleep(25);
    signals.emit("SIGTERM", "SIGTERM");
    await run;
    expect(lines).toContain("stopped by SIGTERM: 1 test file(s) were running, 1 not started");
    expect(lastEvent(wt)).toMatchObject({ signal: "SIGTERM", files: 0, failed: 0 });
  });
});

describe("canon work test stops its process tree on a real signal", () => {
  async function start(wt: string) {
    const proc = Bun.spawn(["bun", MAIN, "work", "test"], { cwd: wt, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    for (let i = 0; i < 400 && !existsSync(join(wt, "child.pid")); i++) await Bun.sleep(25);
    expect(existsSync(join(wt, "child.pid"))).toBe(true);
    return proc;
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("BR-2304: SIGTERM to canon alone ends the test file's whole process tree and exits 143", async () => {
    const wt = jobsFixture(2, 'sleep 30 &\necho $! > child.pid\nwait\n', "1");
    const proc = await start(wt);
    const pid = Number(readFileSync(join(wt, "child.pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(alive(pid)).toBe(false);
    const out = await new Response(proc.stdout).text();
    expect(out).toMatch(/stopped by SIGTERM: 1 test file\(s\) were running, 1 not started/);
    expect(out).not.toContain("canon check:");
  }, 30_000);

  test("BR-2304: a second signal ends the wait at once and sends SIGKILL to a file that ignores SIGTERM", async () => {
    const wt = jobsFixture(1, 'trap "" TERM INT\nsleep 30 &\necho $! > child.pid\nwhile true; do sleep 0.1; done\n', "1");
    const proc = await start(wt);
    const pid = Number(readFileSync(join(wt, "child.pid"), "utf8"));
    const t0 = performance.now();
    proc.kill("SIGTERM");
    await Bun.sleep(700);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(143);
    expect(performance.now() - t0).toBeLessThan(8000); // not the 10 s grace period
    expect(alive(pid)).toBe(false);
  }, 30_000);
});

const spawnWords = (words: string, extra = "") => `const MAIN = join(import.meta.dir, "..", "invocation", "main.ts");\n${extra}Bun.spawnSync(["bun", MAIN, ${words}]);\n`;

describe("canon work test selection: command modules, strings and a CLI that cannot be read", () => {
  test("BR-2157: a command module that imports another command module is followed: a change to the imported one selects the tests naming the importing command", () => {
    const { wt } = cliFixture({
      "src/invocation/tree.ts": 'import "../a/commands.ts";\nimport "../b/commands.ts";\nimport "../g/commands.ts";\nimport "../h/commands.ts";\n',
      "src/g/commands.ts": 'import "../h/commands.ts";\nexport const gCommands = { commands: [entry("three", 30, three)] };\n',
      "src/h/commands.ts": 'export const hCommands = { commands: [entry("four", 40, four)] };\n',
      "src/g/g.test.ts": spawnWords('"three"'),
      "src/h/h.test.ts": spawnWords('"four"'),
    });
    write(wt, { "src/h/commands.ts": 'export const hCommands = { commands: [entry("four", 40, four)] }; // changed\n' });
    expect(reasons(wt)).toEqual({
      "src/g/g.test.ts": "drives canon three (src/h/commands.ts changed, through src/g/commands.ts)",
      "src/h/h.test.ts": "drives canon four (src/h/commands.ts changed)",
    });
  });

  test("BR-2157: a one-word command counts only as an argument, not inside JSON or YAML text or at the start of a longer string", () => {
    const { wt } = cliFixture({
      "src/e/e.test.ts": spawnWords('..."two --json".split(" ")'),
      "src/f/f.test.ts": spawnWords('"unrelated"', 'const cfg = `{"two":"ok","list":["a"]}`;\n'),
    });
    write(wt, { "src/b/commands.ts": "export const bCommands = { commands: [entry(\"two\", 20, two)] }; // changed\n" });
    expect(reasons(wt)).toEqual({ "src/b/b.test.ts": "drives canon two (src/b/commands.ts changed)" });
  });

  test("BR-2157: a test whose command words are built at run time is selected by a change on the entry side only", () => {
    const { wt } = cliFixture();
    write(wt, { "src/a/commands.ts": 'import "./a.ts";\nexport const aCommands = { commands: [entry("one", 10, one, "work")] }; // changed\n' });
    expect(reasons(wt)["src/c/c.test.ts"]).toBeUndefined();
    write(wt, { "src/invocation/strict.ts": "export const strict = 2;\n" });
    expect(reasons(wt)["src/c/c.test.ts"]).toBe("runs the CLI (src/invocation/strict.ts changed, through src/invocation/main.ts)");
  });

  test("BR-2157: a changed data file under a path a module spells from its own location selects the tests that import the module and the tests that drive its command, with the path in the reason", () => {
    const readSkills = 'import { join } from "node:path";\nexport const dir = join(import.meta.dir, "..", "..", ".claude", "skills");\n';
    const { wt } = cliFixture({
      "src/a/a.ts": readSkills,
      "src/i/i.test.ts": 'import "../a/a.ts";\n',
      ".claude/skills/canon-test/SKILL.md": "skill\n",
      "canon/notes/n.md": "note\n",
    });
    write(wt, { ".claude/skills/canon-test/SKILL.md": "skill changed\n" });
    const r = reasons(wt);
    const note = "reads .claude/skills (.claude/skills/canon-test/SKILL.md changed, via src/a/a.ts";
    expect(r["src/i/i.test.ts"]).toBe(`${note})`);
    expect(r["src/a/a.test.ts"]).toBe(`drives canon work one (${note}, through src/a/commands.ts)`);
    expect(r["src/b/b.test.ts"]).toBeUndefined();
    expect(r["src/d/d.test.ts"]).toBeUndefined();
  });

  test("BR-2157: a changed markdown file nothing reads by a spelled path selects no test, and a path that names a code file or the repo root is not a data read", () => {
    const { wt } = cliFixture({
      "src/a/a.ts": 'import { join } from "node:path";\nexport const x = [join(import.meta.dir, "..", ".."), join(import.meta.dir, "..", "b", "commands.ts")];\n',
      "src/i/i.test.ts": 'import "../a/a.ts";\n',
      "canon/notes/n.md": "note\n",
    });
    write(wt, { "canon/notes/n.md": "note changed\n", "README.md": "changed\n" });
    expect(reasons(wt)).toEqual({});
  });

  test("BR-2157: the selection output says how many tests spawn the CLI and how many commands are known", () => {
    const { wt } = cliFixture();
    write(wt, { "src/b/commands.ts": "export const bCommands = { commands: [entry(\"two\", 20, two)] }; // changed\n" });
    expect(canon(wt, "work", "test").out).toContain("CLI tests: 4 file(s) spawn the CLI, 2 command(s) known");
  });

  test("BR-2157: a test that points at a main.ts whose command table is empty fails canon work test with exit 4", () => {
    const { wt } = cliFixture({ "src/invocation/tree.ts": 'import "../a/commands.ts";\n// registrations are written another way now\n', "src/a/commands.ts": "export const aCommands = {};\n" });
    write(wt, { "README.md": "changed\n" });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(4);
    expect(r.err).toContain("src/a/a.test.ts spawns src/invocation/main.ts");
    expect(r.err).toContain("the command table is empty");
    expect(runs(wt)).toEqual([]);
  });

  test("BR-2157: a test that points at a main.ts that is not in the project fails canon work test with exit 4 naming the path", () => {
    const { wt } = fixture("sh run.sh {file}", { "src/x.test.ts": spawnWords('"two"').replace('"invocation", "main.ts"', '"gone", "main.ts"') });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(4);
    expect(r.err).toContain("src/x.test.ts spawns gone/main.ts, which is not a file in the project: no CLI entry found");
  });

  test("BR-2157: the real tree is read: at least 50 tests that spawn the CLI and 30 commands are recognised", () => {
    // reason: only src/ is read, copied to a temporary project, so the test does not read a floor_skip_paths directory (BR-2164, BR-2181)
    const copy = mkdtempSync(join(tmpdir(), "canon-real-tree-"));
    cpSync(join(import.meta.dir, "..", ".."), join(copy, "src"), { recursive: true });
    const exists = (p: string) => existsSync(join(copy, p));
    const reader = cliReader(copy, (f) => importedPaths(copy, f, exists));
    const tests = [...new Bun.Glob("src/**/*.test.ts").scanSync({ cwd: copy })];
    for (const f of tests) reader.cliOf(f, readFileSync(join(copy, f), "utf8"));
    expect(reader.problems()).toEqual([]);
    const { files, commands } = reader.counts();
    expect(files).toBeGreaterThanOrEqual(50);
    expect(commands).toBeGreaterThanOrEqual(30);
  });
});
