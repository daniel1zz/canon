import type { ArgsDef, CommandDef } from "citty";

/** The command a command line names, the words that named it, and the arguments left for that command. */
export interface Resolved {
  readonly cmd: CommandDef<ArgsDef>;
  readonly path: readonly string[];
  readonly rest: readonly string[];
}

type Def = { type?: string; alias?: string | string[] };

const argsOf = (cmd: CommandDef<ArgsDef>) => (cmd.args ?? {}) as Record<string, Def>;
const subsOf = (cmd: CommandDef<ArgsDef>) => (cmd.subCommands ?? {}) as Record<string, CommandDef<ArgsDef>>;

/**
 * Walks subcommands the way citty's runCommand does: at each level the first word that does not start
 * with "-" names the subcommand. Stops at an unknown name, which citty itself then reports.
 * The words in front of a subcommand name belong to the level above and are returned as `before`.
 */
export function resolve(main: CommandDef<ArgsDef>, raw: readonly string[]): Resolved & { readonly before: readonly { cmd: CommandDef<ArgsDef>; path: readonly string[]; args: readonly string[] }[] } {
  let cmd = main;
  let rest = [...raw];
  const path: string[] = [];
  const before: { cmd: CommandDef<ArgsDef>; path: readonly string[]; args: readonly string[] }[] = [];
  for (;;) {
    const subs = subsOf(cmd);
    if (Object.keys(subs).length === 0) break;
    const i = rest.findIndex((a) => !a.startsWith("-"));
    const name = i < 0 ? undefined : rest[i];
    const sub = name === undefined ? undefined : subs[name];
    if (!sub) break;
    before.push({ cmd, path: [...path], args: rest.slice(0, i) });
    path.push(name!);
    cmd = sub;
    rest = rest.slice(i + 1);
  }
  return { cmd, path, rest, before };
}

/**
 * Every argument a command line passes must be one its command declares (BR-2097): an unknown `--flag`
 * is silently ignored by citty, so `--dry-run` on a command without it would really run.
 * Mirrors citty's parser: `--name value` / `--name=value` for strings, `--name`, `--no-name`, `--name true|false`
 * for booleans, `-abc` as single-letter aliases, and everything after `--` as positionals.
 * Returns the problem to report, or undefined when the line is valid.
 */
export function unknownArgument(cmd: CommandDef<ArgsDef>, name: string, args: readonly string[]): string | undefined {
  const defs = argsOf(cmd);
  const kinds = new Map<string, string>();
  for (const [name, d] of Object.entries(defs)) {
    if (d.type === "positional") continue;
    kinds.set(name, d.type ?? "string");
    for (const a of d.alias === undefined ? [] : Array.isArray(d.alias) ? d.alias : [d.alias]) kinds.set(a, d.type ?? "string");
  }
  const flags = Object.entries(defs).filter(([, d]) => d.type !== "positional").map(([n]) => `--${n}`);
  const valid = flags.length ? `valid options: ${flags.join(", ")}` : "it takes no options";
  const unknown = (flag: string) => `\`${name}\` has no option ${flag}; ${valid}`;
  const positionals = Object.values(defs).filter((d) => d.type === "positional").length;
  const given: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      given.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      given.push(a);
      continue;
    }
    if (!a.startsWith("--")) {
      for (const c of a.slice(1).split("=")[0]!) if (!kinds.has(c)) return unknown(`-${c}`);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = a.slice(2, eq < 0 ? undefined : eq);
    if (flag.startsWith("no-") && !kinds.has(flag)) {
      if (kinds.get(flag.slice(3)) !== "boolean") return unknown(a);
      continue;
    }
    const kind = kinds.get(flag);
    if (!kind) return unknown(`--${flag}`);
    if (kind === "boolean") {
      const v = eq < 0 ? undefined : a.slice(eq + 1);
      if (v !== undefined && v !== "true" && v !== "false") return `\`${name}\`: --${flag} takes no value (got ${JSON.stringify(v)})`;
      if (v === undefined && (args[i + 1] === "true" || args[i + 1] === "false")) i++;
      continue;
    }
    // reason: citty takes the next word as the value unless it starts with "-" (string flags only)
    if (eq < 0 && i + 1 < args.length && !args[i + 1]!.startsWith("-")) i++;
  }
  if (given.length > positionals) {
    const extra = JSON.stringify(given[positionals]);
    return `\`${name}\` takes ${positionals === 0 ? "no" : positionals} positional argument(s); unexpected ${extra}`;
  }
  return undefined;
}
