import type { DomainCommands } from "../cli/command.ts";

/** `canon work`: the group its subdomains (session, land, verify, drop) and config (after-land) add their subcommands to. */
export const workCommands: DomainCommands = {
  groups: [{ name: "work", rank: 120, meta: { description: "One change, one worktree, one agent: start → commit → land" } }],
};
