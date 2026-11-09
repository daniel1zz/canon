import type { ArgsDef, CommandDef } from "citty";

/** The command a command line names, the words that named it, and the arguments left for that command. */
export interface Resolved {
  readonly cmd: CommandDef<ArgsDef>;
  readonly path: readonly string[];
  readonly rest: readonly string[];
}

type Def = { type?: string; alias?: string | string[] };

const argsOf = (cmd: CommandDef<ArgsDef>) => (cmd.args ?? {}) as Record<string, Def>;

/** Commands whose last positional takes any number of words, such as `canon work clean <C-n>...` (BR-2152). */
const variadic = new WeakSet<object>();
export function takesMany<T extends object>(cmd: T): T {
  variadic.add(cmd);
  return cmd;
}
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
 * A string option always takes the next word as its value, also one that starts with "-" (BR-2228): citty would read
 * `--title -x` as two options, so such a pair is joined into `--title=-x`, which citty reads as the value. Walks the
 * levels the way `resolve` does, so each word is matched against the options of the command it belongs to.
 * Pairs whose value does not start with "-" are left as they are: citty already reads them right.
 */
export function bindValues(main: CommandDef<ArgsDef>, raw: readonly string[]): string[] {
  const out: string[] = [];
  let cmd = main;
  let descending = true;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (a === "--") {
      out.push(...raw.slice(i));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      const subs = subsOf(cmd);
      const sub = descending && Object.hasOwn(subs, a) ? subs[a] : undefined;
      if (sub) cmd = sub;
      else descending = false;
      out.push(a);
      continue;
    }
    const next = raw[i + 1];
    const def = a.startsWith("--") && !a.includes("=") ? argsOf(cmd)[a.slice(2)] : undefined;
    if (def && (def.type ?? "string") === "string" && next !== undefined && next.startsWith("-")) {
      out.push(`${a}=${next}`);
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
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
  const owner = new Map<string, string>();
  for (const [name, d] of Object.entries(defs)) {
    if (d.type === "positional") continue;
    kinds.set(name, d.type ?? "string");
    owner.set(name, name);
    for (const a of d.alias === undefined ? [] : Array.isArray(d.alias) ? d.alias : [d.alias]) {
      kinds.set(a, d.type ?? "string");
      owner.set(a, name);
    }
  }
  const seen = new Set<string>();
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
    // reason: citty turns a repeated string option into an array, which each command read differently: a title joined
    // with commas, options dropped, a number refused with an odd message (BR-2382, #169)
    const option = owner.get(flag)!;
    if (seen.has(option)) return `\`${name}\`: --${option} is given more than once; give it once (an option that takes several values takes them in one, separated by commas)`;
    seen.add(option);
    // reason: a string option always takes the next word, also one starting with "-" (BR-2228; bindValues joins such pairs for citty)
    if (eq < 0 && i + 1 < args.length) i++;
  }
  if (given.length > positionals && !(positionals > 0 && variadic.has(cmd))) {
    const extra = JSON.stringify(given[positionals]);
    return `\`${name}\` takes ${positionals === 0 ? "no" : positionals} positional argument(s); unexpected ${extra}`;
  }
  return undefined;
}

/**
 * The first argument problem of a whole command line (BR-2097), checked at every level it passes through: the words in
 * front of each subcommand name against the command above it, and the rest against the command it ends on. That last
 * command is checked when it has no subcommands, and also when it has some but runs by itself, as `canon x --flag`
 * without a subcommand name does; one with subcommands and no run of its own is left to citty, which refuses it.
 */
export function argumentProblem(main: CommandDef<ArgsDef>, raw: readonly string[]): string | undefined {
  const at = resolve(main, raw);
  const runsItself = Object.keys(subsOf(at.cmd)).length === 0 || typeof at.cmd.run === "function";
  const levels = [...at.before, ...(runsItself ? [{ cmd: at.cmd, path: at.path, args: at.rest }] : [])];
  for (const l of levels) {
    const name = ["canon", ...l.path].join(" ");
    const problem = unknownArgument(l.cmd, name, l.args);
    if (problem) return `${problem} (see \`${name} --help\`)`;
  }
  return undefined;
}
