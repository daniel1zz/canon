import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { commandFor, selectTests } from "./verify.ts";

// reason: the CLI cases spawn canon and then one shell per selected file; under load each spawn can take seconds (C-111)
setDefaultTimeout(30_000);

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

  test("BR-2157: a changed test file is selected as changed, an untracked one too", () => {
    const { wt } = fixture();
    write(wt, { "src/d.test.ts": "export const d = 1;\n" });
    sh(wt, "commit", "-qam", "edit d");
    write(wt, { "src/g.test.ts": "export {};\n" });
    expect(reasons(wt)).toEqual({ "src/d.test.ts": "changed", "src/g.test.ts": "changed" });
  });

  test("BR-2157: a changed rule file selects the tests whose running titles name it, not skipped ones", () => {
    const { wt } = fixture();
    write(wt, { [`canon/rules/core/${rule}.md`]: `---\nid: ${rule}\ntitle: x\nstatus: active\n---\n` });
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

  test("BR-2160: without test_command canon work test exits 2 and says what to write", () => {
    const { wt } = fixture();
    write(wt, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\n' });
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(2);
    expect(r.err).toContain('test_command: "bun test {file}"');
    expect(canon(wt, "check").code).not.toBe(2);
  });
});
