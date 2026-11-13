import type { ArgsDef, CommandDef, CommandMeta } from "citty";
import { openWorkspace, type Workspace } from "../work/workspace.ts";
import { readCorpus } from "../knowledge/documents/read.ts";
import type { CanonError, Result } from "../kernel/result.ts";

/**
 * Exit codes — one meaning each, so an agent can branch on them (BR-2022, D-4):
 *   0 ok · 1 refused by an outcome check · 2 usage / invalid input / bad config · 3 not found
 *   4 the environment failed (git, filesystem, coordination DB) · 5 conflict: claimed, already answered, already exists
 *   70 a bug in canon · 75 not finished yet, run again later (a landing still queued, after_land commands still running) · 143 / 130 a lander stopped by SIGTERM / SIGINT (128 + signal, BR-2099)
 */
export const EXIT = { ok: 0, refused: 1, usage: 2, notFound: 3, env: 4, conflict: 5, internal: 70, timeout: 75 } as const;

const EXIT_OF: Record<CanonError["code"], number> = { invalid: EXIT.usage, not_found: EXIT.notFound, conflict: EXIT.conflict, refused: EXIT.refused, io: EXIT.env };

export function fail(e: CanonError): never {
  console.error(`canon: ${e.message}`);
  process.exit(EXIT_OF[e.code]);
}

export function must<T>(r: Result<T>): T {
  if (!r.ok) fail(r.error);
  return r.value;
}

/** `--as <agent id>` on the commands that take or use a claim (BR-2023, D-62). */
export const AS_ARG = { as: { type: "string", description: "Subagent: your own agent id; acts as agent:<session>:<id> (Claude Code or Codex)" } } as const;

export const RUNTIME_ARG = { runtime: { type: "string", description: "Hook input protocol: claude or codex" } } as const;

/** The workspace of the current directory; `as` is the value of `--as`, absent when it was not given. */
export function workspace(as?: unknown): Workspace {
  return must(openWorkspace(process.cwd(), as === undefined ? undefined : typeof as === "string" ? as : ""));
}

/** The corpus of this worktree, read with the project's declared types. */
export const corpusOf = (ws: Workspace) => readCorpus(ws.root, ws.config.types, ws.config);

export const list = (v: unknown): string[] => (typeof v === "string" && v.trim() !== "" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
export const say = (line: string) => console.log(line);
export const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));

// ---------------------------------------------------------------- how domains contribute commands

/**
 * One command a domain contributes, from the file `commands.ts` in that domain's own directory; src/invocation/tree.ts
 * only assembles them, so a new command never edits a shared file (C-132).
 * `under` names the group it belongs to (`work`), absent for a top-level command; `rank` is its place in
 * `--help` among its siblings (lower first).
 */
export interface CommandEntry {
  readonly name: string;
  readonly rank: number;
  readonly under?: string;
  readonly cmd: CommandDef<ArgsDef>;
}

/** A top-level command whose subcommands come from several domains (`canon work`): only its description and place. */
export interface CommandGroup {
  readonly name: string;
  readonly rank: number;
  readonly meta: CommandMeta;
}

export interface DomainCommands {
  readonly commands?: readonly CommandEntry[];
  readonly groups?: readonly CommandGroup[];
}

// reason: citty's CommandDef is generic over its own args; an entry holds any command, so the type is widened once here
export const entry = <T extends ArgsDef>(name: string, rank: number, cmd: CommandDef<T>, under?: string): CommandEntry => ({
  name,
  rank,
  cmd: cmd as unknown as CommandDef<ArgsDef>,
  ...(under === undefined ? {} : { under }),
});

/**
 * The subcommands of `canon`, from every domain's contribution, in rank order. A name given twice, a subcommand of
 * a group nobody declared, or a group with no subcommands is a bug in canon and throws.
 */
export function assemble(domains: readonly DomainCommands[]): Record<string, CommandDef<ArgsDef>> {
  const commands = domains.flatMap((d) => d.commands ?? []);
  const groups = domains.flatMap((d) => d.groups ?? []);
  const byRank = <T extends { rank: number }>(xs: readonly T[]) => [...xs].sort((a, b) => a.rank - b.rank);
  const named = (pairs: readonly (readonly [string, CommandDef<ArgsDef>])[], where: string) => {
    const out: Record<string, CommandDef<ArgsDef>> = {};
    for (const [name, cmd] of pairs) {
      if (name in out) throw new Error(`two domains define the command ${where}${name}`);
      out[name] = cmd;
    }
    return out;
  };
  const groupNames = new Set(groups.map((g) => g.name));
  for (const c of commands) if (c.under !== undefined && !groupNames.has(c.under)) throw new Error(`canon ${c.under} ${c.name}: no domain declares the group ${c.under}`);
  const top = byRank([
    ...commands.filter((c) => c.under === undefined).map((c) => ({ rank: c.rank, name: c.name, cmd: c.cmd })),
    ...groups.map((g) => {
      const subs = byRank(commands.filter((c) => c.under === g.name));
      if (subs.length === 0) throw new Error(`the group canon ${g.name} has no subcommands`);
      return { rank: g.rank, name: g.name, cmd: { meta: g.meta, subCommands: named(subs.map((s) => [s.name, s.cmd] as const), `${g.name} `) } as CommandDef<ArgsDef> };
    }),
  ]);
  return named(top.map((t) => [t.name, t.cmd] as const), "");
}
