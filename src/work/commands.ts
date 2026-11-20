import type { DomainCommands } from "../invocation/command.ts";

/** `canon work`: the group its subdomains (session, land, verify, drop) and config (after-land) add their subcommands to. */
export const workCommands: DomainCommands = {
  groups: [
    { name: "work", rank: 120, meta: { description: "Work lifecycle: start → commit → land" } },
    { name: "chore", rank: 121, meta: { description: "Light changes: a title only; the change file is written when they land through the shared queue" } },
  ],
};
