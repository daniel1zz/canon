import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { argumentProblem, bindValues } from "./strict.ts";

const MAIN = join(import.meta.dir, "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-string-option-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) Bun.spawnSync(["git", ...args], { cwd: root });
  expect(canon(root, "init", "--floor", "true").code).toBe(0);
  return root;
}

/** The title of the only decision in the project. */
function decisionTitle(root: string): string {
  const files = readdirSync(join(root, "canon/decisions"));
  expect(files).toHaveLength(1);
  return /^title: (.*)$/m.exec(readFileSync(join(root, "canon/decisions", files[0]!), "utf8"))![1]!;
}

// `x` takes a string --title and a boolean --json and has a subcommand `sub`; `g` has a string --name before its subcommand.
const tree = defineCommand({
  meta: { name: "canon" },
  subCommands: {
    x: defineCommand({ args: { title: { type: "string" }, json: { type: "boolean" } }, run() {}, subCommands: { sub: defineCommand({ run() {} }) } }),
    g: defineCommand({ args: { name: { type: "string" } }, subCommands: { leaf: defineCommand({ args: { title: { type: "string" } }, run() {} }) } }),
  },
});

describe("a string option takes the next word as its value", () => {
  test("BR-2228: a value that starts with - is joined to its option, at the level that declares it", () => {
    expect(bindValues(tree, ["x", "--title", "-x"])).toEqual(["x", "--title=-x"]);
    expect(bindValues(tree, ["x", "--title", "--json"])).toEqual(["x", "--title=--json"]);
    expect(bindValues(tree, ["x", "--title", "--"])).toEqual(["x", "--title=--"]);
    expect(bindValues(tree, ["x", "--title", "plain"])).toEqual(["x", "--title", "plain"]);
    expect(bindValues(tree, ["x", "--json", "-x"])).toEqual(["x", "--json", "-x"]);
    expect(bindValues(tree, ["g", "--name", "-n", "leaf", "--title", "-t"])).toEqual(["g", "--name=-n", "leaf", "--title=-t"]);
    expect(bindValues(tree, ["x", "--", "--title", "-x"])).toEqual(["x", "--", "--title", "-x"]);
  });

  test("BR-2228: the argument check reads the word after a string option as its value, not as an option or a positional", () => {
    expect(argumentProblem(tree, ["x", "--title", "-x"])).toBeUndefined();
    expect(argumentProblem(tree, ["x", "--title", "--bogus"])).toBeUndefined();
    expect(argumentProblem(tree, ["x", "--json", "-x"])).toContain("has no option -x");
  });

  test("BR-2228: canon decision new --title \"-x\" creates a decision titled -x; --title=-x gives the same title", () => {
    const spaced = project();
    expect(canon(spaced, "decision", "new", "--title", "-x").code).toBe(0);
    expect(decisionTitle(spaced)).toBe("-x");
    const joined = project();
    expect(canon(joined, "decision", "new", "--title=-x").code).toBe(0);
    expect(decisionTitle(joined)).toBe("-x");
  });

  test("BR-2228 BR-2194: --json and --help after a string option are its value; a plain title is unchanged", () => {
    const json = project();
    expect(canon(json, "decision", "new", "--title", "--json").code).toBe(0);
    expect(decisionTitle(json)).toBe("--json");
    const help = project();
    const r = canon(help, "decision", "new", "--title", "--help");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("USAGE");
    expect(decisionTitle(help)).toBe("--help");
    const plain = project();
    expect(canon(plain, "decision", "new", "--title", "普通标题").code).toBe(0);
    expect(decisionTitle(plain)).toBe("普通标题");
  });

  test("BR-2228: after a boolean option a word starting with - is still an unknown option", () => {
    const root = project();
    const r = canon(root, "search", "brief", "--json", "-x");
    expect(r.code).toBe(2);
    expect(r.err).toContain("-x");
  });
});
