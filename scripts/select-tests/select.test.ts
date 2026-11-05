import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importedPaths } from "./imports.ts";
import { cliReader, selectTests } from "./select.ts";

const MAIN = join(import.meta.dir, "main.ts");

interface Project {
  readonly dir: string;
  readonly files: Map<string, string>;
  readonly changed: string[];
}

/** A throwaway project of plain files; `change` and `remove` record what the "change" touched, as canon's stdin would list it. */
function project(files: Record<string, string>): Project {
  const dir = mkdtempSync(join(tmpdir(), "canon-select-"));
  const p: Project = { dir, files: new Map(), changed: [] };
  for (const [path, text] of Object.entries(files)) put(p, path, text);
  return p;
}

function put(p: Project, path: string, text: string) {
  mkdirSync(dirname(join(p.dir, path)), { recursive: true });
  writeFileSync(join(p.dir, path), text);
  p.files.set(path, text);
}

const change = (p: Project, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    put(p, path, text);
    if (!p.changed.includes(path)) p.changed.push(path);
  }
};

const remove = (p: Project, path: string) => {
  rmSync(join(p.dir, path));
  p.files.delete(path);
  p.changed.push(path);
};

/** file → reasons, for the test files (every `*.test.ts`) the change selects. */
function select(p: Project) {
  const all = [...p.files.keys()];
  const r = selectTests(p.dir, p.changed, all.filter((f) => f.endsWith(".test.ts")).sort(), all);
  return { ...r, reasons: Object.fromEntries(r.selected.map((s) => [s.file, s.reasons.join("; ")])) };
}

const base = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
  "src/b.test.ts": 'import { a } from "./a.ts";\n',
  "src/c.test.ts": 'import { b } from "./b.ts";\n',
  "src/d.test.ts": "export {};\n",
};

describe("select-tests: tests that import what changed", () => {
  test("BR-2347: a changed source file selects the tests importing it directly or through other files", () => {
    const p = project(base);
    change(p, { "src/a.ts": "export const a = 2;\n" });
    expect(select(p).reasons).toEqual({ "src/b.test.ts": "imports src/a.ts", "src/c.test.ts": "imports src/a.ts (through src/b.ts)" });
  });

  test("BR-2347: a deleted file still selects the tests whose import names it without an extension or as .js", () => {
    const p = project({ ...base, "src/g.test.ts": 'import "./a";\n', "src/h.test.ts": 'import { a } from "./a.js";\n' });
    remove(p, "src/a.ts");
    expect(select(p).reasons).toEqual({
      "src/b.test.ts": "imports src/a.ts",
      "src/c.test.ts": "imports src/a.ts (through src/b.ts)",
      "src/g.test.ts": "imports src/a.ts",
      "src/h.test.ts": "imports src/a.ts",
    });
  });

  test("BR-2347: a change nothing imports, or a file a test only names in a string, selects nothing", () => {
    const p = project({ ...base, "src/s.test.ts": 'const s = "./a.ts";\n' });
    change(p, { "README.md": "changed\n" });
    expect(select(p).reasons).toEqual({});
  });

  test("BR-2347: non-relative specifiers are not followed", () => {
    const p = project({ ...base, "src/n.test.ts": 'import { a } from "a";\nimport x from "node:path";\n' });
    change(p, { "src/a.ts": "export const a = 2;\n" });
    expect(select(p).reasons["src/n.test.ts"]).toBeUndefined();
  });
});

/**
 * The base project plus a CLI: src/invocation/main.ts imports the command table src/invocation/tree.ts, which imports two command modules.
 * src/a/commands.ts registers `work one` and imports src/a/a.ts; src/b/commands.ts registers `two`. Tests that spawn
 * it: src/a/a.test.ts names `work one`, src/a/spaced.test.ts names it in one literal, src/b/b.test.ts names `two`,
 * src/c/c.test.ts names no command. src/d/d.test.ts has a "two" literal but never builds the CLI's path.
 */
const spawnWords = (words: string, extra = "") => `const MAIN = join(import.meta.dir, "..", "invocation", "main.ts");\n${extra}Bun.spawnSync(["bun", MAIN, ${words}]);\n`;

function cliProject(extra: Record<string, string> = {}) {
  return project({
    ...base,
    "src/invocation/main.ts": 'import "./tree.ts";\nimport "./strict.ts";\n',
    "src/invocation/strict.ts": "export const strict = 1;\n",
    "src/invocation/tree.ts": 'import "../a/commands.ts";\nimport "../b/commands.ts";\n',
    "src/a/commands.ts": 'import "./a.ts";\nexport const aCommands = { commands: [entry("one", 10, one, "work")] };\n',
    "src/a/a.ts": "export const one = 1;\n",
    "src/b/commands.ts": '// entry("one", 1, x, "work") in a comment registers nothing\nexport const bCommands = { commands: [entry("two", 20, two)] };\n',
    "src/a/a.test.ts": spawnWords('"work", "one", "--json"'),
    "src/a/spaced.test.ts": spawnWords('..."work one --json".split(" ")'),
    "src/b/b.test.ts": spawnWords('"two"'),
    "src/c/c.test.ts": spawnWords("...process.argv"),
    "src/d/d.test.ts": 'const args = ["two"];\n',
    ...extra,
  });
}

const touchB = { "src/b/commands.ts": 'export const bCommands = { commands: [entry("two", 20, two)] }; // changed\n' };

describe("select-tests: tests that spawn the CLI", () => {
  test("BR-2348: a changed command module selects the tests that name its command, with the command in the reason", () => {
    const p = cliProject();
    change(p, { "src/a/commands.ts": 'import "./a.ts";\nexport const aCommands = { commands: [entry("one", 10, one, "work")] }; // changed\n' });
    const { reasons } = select(p);
    expect(reasons["src/a/a.test.ts"]).toBe("drives canon work one (src/a/commands.ts changed)");
    expect(reasons["src/a/spaced.test.ts"]).toBe("drives canon work one (src/a/commands.ts changed)");
    expect(Object.keys(reasons).sort()).toEqual(["src/a/a.test.ts", "src/a/spaced.test.ts"]);
  });

  test("BR-2348: a file a command module imports selects the tests that name the command, and the chain is shown", () => {
    const p = cliProject();
    change(p, { "src/a/a.ts": "export const one = 2;\n" });
    const via = "drives canon work one (src/a/a.ts changed, through src/a/commands.ts)";
    expect(select(p).reasons).toEqual({ "src/a/a.test.ts": via, "src/a/spaced.test.ts": via });
  });

  test("BR-2348: a change to another command's module selects neither the tests of this command nor tests naming no command", () => {
    const p = cliProject();
    change(p, touchB);
    expect(select(p).reasons).toEqual({ "src/b/b.test.ts": "drives canon two (src/b/commands.ts changed)" });
  });

  test("BR-2348: a change to the command table or to what the CLI's entry file imports selects every test that spawns the CLI", () => {
    const p = cliProject();
    change(p, { "src/invocation/strict.ts": "export const strict = 2;\n" });
    const through = "runs the CLI (src/invocation/strict.ts changed, through src/invocation/main.ts)";
    expect(select(p).reasons).toEqual({ "src/a/a.test.ts": through, "src/a/spaced.test.ts": through, "src/b/b.test.ts": through, "src/c/c.test.ts": through });
    const q = cliProject();
    change(q, { "src/invocation/tree.ts": 'import "../a/commands.ts";\nimport "../b/commands.ts";\n// changed\n' });
    const table = "runs the CLI (src/invocation/tree.ts changed, through src/invocation/main.ts)";
    expect(select(q).reasons).toEqual({ "src/a/a.test.ts": table, "src/a/spaced.test.ts": table, "src/b/b.test.ts": table, "src/c/c.test.ts": table });
  });

  test("BR-2348: a test that names a command without spawning the CLI is not selected by that command's change", () => {
    const p = cliProject();
    change(p, touchB);
    expect(select(p).reasons["src/d/d.test.ts"]).toBeUndefined();
  });

  test("BR-2348: a command module that imports another command module is followed: a change to the imported one selects the tests naming the importing command", () => {
    const p = cliProject({
      "src/invocation/tree.ts": 'import "../a/commands.ts";\nimport "../b/commands.ts";\nimport "../g/commands.ts";\nimport "../h/commands.ts";\n',
      "src/g/commands.ts": 'import "../h/commands.ts";\nexport const gCommands = { commands: [entry("three", 30, three)] };\n',
      "src/h/commands.ts": 'export const hCommands = { commands: [entry("four", 40, four)] };\n',
      "src/g/g.test.ts": spawnWords('"three"'),
      "src/h/h.test.ts": spawnWords('"four"'),
    });
    change(p, { "src/h/commands.ts": 'export const hCommands = { commands: [entry("four", 40, four)] }; // changed\n' });
    expect(select(p).reasons).toEqual({
      "src/g/g.test.ts": "drives canon three (src/h/commands.ts changed, through src/g/commands.ts)",
      "src/h/h.test.ts": "drives canon four (src/h/commands.ts changed)",
    });
  });

  test("BR-2348: a one-word command counts only as an argument, not inside JSON or YAML text or at the start of a longer string", () => {
    const p = cliProject({
      "src/e/e.test.ts": spawnWords('..."two --json".split(" ")'),
      "src/f/f.test.ts": spawnWords('"unrelated"', 'const cfg = `{"two":"ok","list":["a"]}`;\n'),
    });
    change(p, touchB);
    expect(select(p).reasons).toEqual({ "src/b/b.test.ts": "drives canon two (src/b/commands.ts changed)" });
  });

  test("BR-2348: a test whose command words are built at run time is selected by a change on the entry side only", () => {
    const p = cliProject();
    change(p, { "src/a/commands.ts": 'import "./a.ts";\nexport const aCommands = { commands: [entry("one", 10, one, "work")] }; // changed\n' });
    expect(select(p).reasons["src/c/c.test.ts"]).toBeUndefined();
    change(p, { "src/invocation/strict.ts": "export const strict = 2;\n" });
    expect(select(p).reasons["src/c/c.test.ts"]).toBe("runs the CLI (src/invocation/strict.ts changed, through src/invocation/main.ts)");
  });

  test("BR-2348: the tests that spawn the CLI and the commands the table registers are counted", () => {
    const p = cliProject();
    change(p, touchB);
    expect(select(p).cli).toEqual({ files: 4, commands: 2 });
  });

  test("BR-2351: a test that points at a main.ts whose command table is empty is a problem naming the test, the path and the cause", () => {
    const p = cliProject({ "src/invocation/tree.ts": 'import "../a/commands.ts";\n// registrations are written another way now\n', "src/a/commands.ts": "export const aCommands = {};\n" });
    change(p, { "README.md": "changed\n" });
    const { problems } = select(p);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("src/a/a.test.ts spawns src/invocation/main.ts");
    expect(problems[0]).toContain("the command table is empty");
  });

  test("BR-2351: a test that points at a main.ts that is not in the project is a problem naming the path", () => {
    const p = project({ ...base, "src/x.test.ts": spawnWords('"two"').replace('"invocation", "main.ts"', '"gone", "main.ts"') });
    expect(select(p).problems).toEqual(["src/x.test.ts spawns gone/main.ts, which is not a file in the project: no CLI entry found"]);
  });

  test("BR-2348: the real tree is read: at least 50 tests that spawn the CLI and 30 commands are recognised", () => {
    // reason: only src/ is read, copied to a temporary project, so the test reads no directory canon's floor_skip_paths names (BR-2164)
    const copy = mkdtempSync(join(tmpdir(), "canon-real-tree-"));
    cpSync(join(import.meta.dir, "..", "..", "src"), join(copy, "src"), { recursive: true });
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

describe("select-tests: modules that read data files", () => {
  const readSkills = 'import { join } from "node:path";\nexport const dir = join(import.meta.dir, "..", "..", ".claude", "skills");\n';

  test("BR-2349: a changed data file under a path a module spells from its own location selects the tests that import the module and the tests that drive its command, with the path in the reason", () => {
    const p = cliProject({ "src/a/a.ts": readSkills, "src/i/i.test.ts": 'import "../a/a.ts";\n', ".claude/skills/canon-test/SKILL.md": "skill\n", "canon/notes/n.md": "note\n" });
    change(p, { ".claude/skills/canon-test/SKILL.md": "skill changed\n" });
    const { reasons } = select(p);
    const note = "reads .claude/skills (.claude/skills/canon-test/SKILL.md changed, via src/a/a.ts";
    expect(reasons["src/i/i.test.ts"]).toBe(`${note})`);
    expect(reasons["src/a/a.test.ts"]).toBe(`drives canon work one (${note}, through src/a/commands.ts)`);
    expect(reasons["src/b/b.test.ts"]).toBeUndefined();
    expect(reasons["src/d/d.test.ts"]).toBeUndefined();
  });

  test("BR-2349: a changed markdown file nothing reads by a spelled path selects no test, and a path that names a code file or the repo root is not a data read", () => {
    const p = cliProject({
      "src/a/a.ts": 'import { join } from "node:path";\nexport const x = [join(import.meta.dir, "..", ".."), join(import.meta.dir, "..", "b", "commands.ts")];\n',
      "src/i/i.test.ts": 'import "../a/a.ts";\n',
      "canon/notes/n.md": "note\n",
    });
    change(p, { "canon/notes/n.md": "note changed\n", "README.md": "changed\n" });
    expect(select(p).reasons).toEqual({});
  });
});

// reason: fixture sources are assembled from pieces, so this file does not itself read like a test that reads the repository's own canon/ files
const META = ["import", "meta", "dir"].join(".");
const URLA = ["import", "meta", "url"].join(".");
const CWD = ["process", "cwd()"].join(".");
const RULES = ["canon", "rules"].join("/");
const NOTES = ["canon", "notes"].join("/");
const READ = ["read", "FileSync"].join("");

describe("select-tests: tests that read a changed non-code file", () => {
  const ROOTED = `const ROOT = join(${META}, "..", "..");\n`;
  const reading: Record<string, string> = {
    "src/a/root.test.ts": `${ROOTED}const t = ${READ}(join(ROOT, "${RULES}/x/BR-1.md"), "utf8");\n`,
    "src/a/partial.test.ts": `${ROOTED}for (const n of names) ${READ}(join(ROOT, "canon", n));\n`,
    "src/a/forms.test.ts": [
      ROOTED.trimEnd(),
      `const a = ${READ}(\`\${ROOT}/${NOTES}/N-1.md\`);`,
      `const b = new URL("../../${RULES}/x.md", ${URLA});`,
      `const c = ${READ}("${RULES}/x.md");`,
      `const d = join(${CWD}, "${RULES}");`,
      `spawnSync(["ls"], { cwd: ROOT });`,
      "",
    ].join("\n"),
    "src/a/clean.test.ts": [
      `const MAIN = join(${META}, "..", "invocation", "main.ts");`,
      `const root = mkdtempSync(join(tmpdir(), "x-"));`,
      `writeFileSync(join(root, "${RULES}/x/BR-1.md"), "");`,
      `const out = join(${META}, "..", "..", "..", "..", "${RULES}");`,
      `spawnSync(["ls"], { cwd: MAIN });`,
      "",
    ].join("\n"),
    "tests/a.py": `open(Path(__file__).parent.parent / "${RULES}" / "x.md")\n`,
  };

  test("BR-2350: each recognised way of reaching a changed file from the repository selects the test, with the path and the line; temp repos, other paths, paths outside the repository and other languages do not", () => {
    const p = project(reading);
    change(p, { [`${RULES}/x/BR-1.md`]: "changed\n" });
    const { reasons } = select(p);
    // root.test.ts reads that very file; partial.test.ts and the cwd forms read something that may hold it
    expect(reasons["src/a/root.test.ts"]).toBe(`reads ${RULES}/x/BR-1.md (${RULES}/x/BR-1.md changed, line 2)`);
    expect(reasons["src/a/partial.test.ts"]).toBe(`reads canon (${RULES}/x/BR-1.md changed, line 2)`);
    expect(reasons["src/a/forms.test.ts"]).toContain(`reads ${RULES} (${RULES}/x/BR-1.md changed, line 5)`);
    expect(reasons["src/a/forms.test.ts"]).toContain("reads the repository root");
    expect(reasons["src/a/clean.test.ts"]).toBeUndefined();
    expect(reasons["tests/a.py"]).toBeUndefined();
  });

  test("BR-2350: a changed file nothing reads by such a path selects nothing, and a changed code file is the imports' business", () => {
    const p = project({ "src/a/root.test.ts": reading["src/a/root.test.ts"]!, "src/a/clean.test.ts": reading["src/a/clean.test.ts"]! });
    change(p, { "docs/other.md": "changed\n", "src/lib.ts": "export {};\n" });
    expect(select(p).reasons).toEqual({});
  });
});

describe("select-tests: the command canon runs", () => {
  const run = (cwd: string, stdin: string) => {
    const r = Bun.spawnSync(["bun", MAIN], { cwd, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const withConfig = (files: Record<string, string>) => {
    const p = project({ "canon/config.yaml": 'tests: ["src/**/*.test.ts"]\n', ...files });
    Bun.spawnSync(["git", "init", "-q"], { cwd: p.dir });
    return p;
  };

  test("BR-2351: paths on standard input give test files and reasons on standard output, one per line with a tab, the summary on standard error", () => {
    const p = withConfig(base);
    const r = run(p.dir, "src/a.ts\n");
    expect(r.code).toBe(0);
    expect(r.out).toBe("src/b.test.ts\timports src/a.ts\nsrc/c.test.ts\timports src/a.ts (through src/b.ts)\n");
    expect(r.err).toContain("0 file(s) spawn the CLI");
  });

  test("BR-2351: nothing on standard input selects nothing and exits 0", () => {
    const r = run(withConfig(base).dir, "");
    expect([r.code, r.out]).toEqual([0, ""]);
  });

  test("BR-2351: a CLI table that cannot be read exits 1 with the reason on standard error and prints no test", () => {
    const p = withConfig({ ...base, "src/x.test.ts": spawnWords('"two"').replace('"invocation", "main.ts"', '"gone", "main.ts"') });
    const r = run(p.dir, "README.md\n");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("src/x.test.ts spawns gone/main.ts");
  });

  test("BR-2351: a project without a tests list in canon/config.yaml selects nothing", () => {
    const p = project({ "canon/config.yaml": "floor: true\n", ...base });
    Bun.spawnSync(["git", "init", "-q"], { cwd: p.dir });
    const r = run(p.dir, "src/a.ts\n");
    expect([r.code, r.out]).toEqual([0, ""]);
  });
});
