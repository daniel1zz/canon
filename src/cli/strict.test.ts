import { describe, expect, test } from "bun:test";
import { defineCommand } from "citty";
import { argumentProblem } from "./strict.ts";

// A command tree shaped like canon's: `x` runs by itself and also has a subcommand; `g` only groups subcommands.
const tree = defineCommand({
  meta: { name: "canon" },
  subCommands: {
    x: defineCommand({
      args: { json: { type: "boolean" } },
      run() {},
      subCommands: { sub: defineCommand({ args: { all: { type: "boolean" } }, run() {} }) },
    }),
    g: defineCommand({ subCommands: { leaf: defineCommand({ run() {} }) } }),
  },
});

describe("argument checking across command levels", () => {
  test("BR-2097: a command that has subcommands but runs by itself checks its own options too", () => {
    expect(argumentProblem(tree, ["x", "--bogus"])).toContain("`canon x` has no option --bogus");
    expect(argumentProblem(tree, ["x", "--json"])).toBeUndefined();
  });

  test("BR-2097: its subcommand checks its own options, and words before the subcommand name are checked against the command above", () => {
    expect(argumentProblem(tree, ["x", "sub", "--all"])).toBeUndefined();
    expect(argumentProblem(tree, ["x", "sub", "--json"])).toContain("`canon x sub` has no option --json");
    expect(argumentProblem(tree, ["x", "--json", "sub"])).toBeUndefined();
    expect(argumentProblem(tree, ["x", "--bogus", "sub"])).toContain("`canon x` has no option --bogus");
  });

  test("BR-2097: a group that cannot run by itself is left to citty, which refuses a line naming no subcommand", () => {
    expect(argumentProblem(tree, ["g", "--bogus"])).toBeUndefined();
    expect(argumentProblem(tree, ["g", "leaf", "--bogus"])).toContain("`canon g leaf` has no option --bogus");
  });
});
