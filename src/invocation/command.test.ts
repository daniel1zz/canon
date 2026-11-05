import { describe, expect, it } from "bun:test";
import { defineCommand } from "citty";
import { assemble, entry } from "./command.ts";

const cmd = (description: string) => defineCommand({ meta: { description }, run() {} });

describe("assemble", () => {
  it("orders top-level commands and a group's subcommands by rank, whichever domain gives them", () => {
    const out = assemble([
      { commands: [entry("c", 30, cmd("c")), entry("y", 2, cmd("y"), "g")] },
      { groups: [{ name: "g", rank: 20, meta: { description: "group" } }], commands: [entry("a", 10, cmd("a")), entry("x", 1, cmd("x"), "g")] },
    ]);
    expect(Object.keys(out)).toEqual(["a", "g", "c"]);
    expect(Object.keys(out["g"]!.subCommands as object)).toEqual(["x", "y"]);
    expect(out["g"]!.meta).toEqual({ description: "group" });
  });

  it("throws on a name two domains define, a subcommand of an undeclared group, and an empty group", () => {
    expect(() => assemble([{ commands: [entry("a", 1, cmd("a"))] }, { commands: [entry("a", 2, cmd("a"))] }])).toThrow("two domains define the command a");
    expect(() => assemble([{ commands: [entry("x", 1, cmd("x"), "g")] }])).toThrow("no domain declares the group g");
    expect(() => assemble([{ groups: [{ name: "g", rank: 1, meta: {} }] }])).toThrow("has no subcommands");
  });
});
