import { describe, expect, test } from "bun:test";
import { parseArgs, type ArgsDef, type CommandDef } from "citty";
import { argumentProblem, bindValues } from "./strict.ts";
import { main } from "./tree.ts";

type Def = { type?: string; required?: boolean; default?: unknown };

/** Every command of the tree with the words that name it, groups (no `run`) included. */
function commands(cmd: CommandDef<ArgsDef>, path: string[] = []): { path: string[]; cmd: CommandDef<ArgsDef> }[] {
  const subs = (cmd.subCommands ?? {}) as Record<string, CommandDef<ArgsDef>>;
  return [{ path, cmd }, ...Object.entries(subs).flatMap(([name, sub]) => commands(sub, [...path, name]))];
}

/** Each declared string option of each command; an option without a type is a string to citty, as to bindValues. */
const stringOptions = commands(main).flatMap(({ path, cmd }) =>
  Object.entries((cmd.args ?? {}) as Record<string, Def>)
    .filter(([, d]) => (d.type ?? "string") === "string")
    .map(([name]) => ({ path, cmd, name })),
);

describe("every declared string option takes -x as its value", () => {
  test("BR-2228: the command tree declares string options to check", () => {
    // reason: a walk that found none would pass every check below without checking anything
    expect(stringOptions.length).toBeGreaterThan(10);
    expect(stringOptions.some((o) => o.path.join(" ") === "decision new" && o.name === "title")).toBe(true);
  });

  test("BR-2228: for every command and each of its string options, `--<option> -x` binds -x as the value and the argument check does not call -x an option", () => {
    const wrong: string[] = [];
    for (const { path, cmd, name } of stringOptions) {
      // reason: citty refuses a line without the command's required positionals and other required options, so they get plain words
      const defs = Object.entries((cmd.args ?? {}) as Record<string, Def>);
      const others = defs.filter(([n, d]) => n !== name && d.type !== "positional" && d.required === true).flatMap(([n, d]) => (d.type === "boolean" ? [`--${n}`] : [`--${n}`, "v"]));
      const positionals = defs.filter(([, d]) => d.type === "positional" && d.required !== false && d.default === undefined).map(() => "p");
      const line = [...path, `--${name}`, "-x", ...others, ...positionals];
      const bound = bindValues(main, line);
      const own = bound.slice(path.length);
      const value = parseArgs(own, (cmd.args ?? {}) as ArgsDef)[name];
      const problem = argumentProblem(main, bound) ?? "";
      if (value !== "-x" || problem.includes("-x")) wrong.push(`canon ${line.join(" ")}: value ${JSON.stringify(value)}${problem ? `, ${problem}` : ""}`);
    }
    expect(wrong).toEqual([]);
  });
});
