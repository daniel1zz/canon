import { defineCommand } from "citty";
import { assemble } from "./command.ts";
import { installCommands } from "../install/commands.ts";
import { referenceCommands } from "./reference/commands.ts";
import { checkCommands } from "../knowledge/check/commands.ts";
import { documentCommands } from "../knowledge/documents/commands.ts";
import { queryCommands } from "../knowledge/query/commands.ts";
import { reviewCommands } from "../knowledge/review/commands.ts";
import { releaseCommands } from "../knowledge/releases/commands.ts";
import { workCommands } from "../work/commands.ts";
import { claimCommands } from "../work/claims/commands.ts";
import { dropCommands } from "../work/drop/commands.ts";
import { executionCommands } from "../work/execution/commands.ts";
import { hooksCommands } from "../work/hooks/commands.ts";
import { humanCommands } from "../work/humans/commands.ts";
import { issueCommands } from "../work/issues/commands.ts";
import { landCommands } from "../work/land/commands.ts";
import { urgentCommands } from "../work/land/queue/commands.ts";
import { sessionCommands } from "../work/session/commands.ts";
import { snapshotCommands } from "../work/snapshots/commands.ts";
import { statsCommands } from "../work/stats/commands.ts";
import { verifyCommands } from "../work/verify/commands.ts";
import { watchCommands } from "../work/watch/commands.ts";
import { remoteCommands } from "../work/remote/commands.ts";

/**
 * Only assembles: every domain defines its commands in commands.ts in its own directory, with their place in --help,
 * so a new command never edits this file; it changes only when a domain is added (C-132, D-15). Kept apart from
 * main.ts, which runs the command line when imported, so tests can walk the tree (C-214).
 */
export const main = defineCommand({
  meta: { name: "canon", description: "Shared memory and coordination for a project built by many concurrent AI sessions" },
  subCommands: assemble([
    installCommands,
    hooksCommands,
    referenceCommands,
    checkCommands,
    documentCommands,
    queryCommands,
    releaseCommands,
    reviewCommands,
    executionCommands,
    workCommands,
    sessionCommands,
    landCommands,
    urgentCommands,
    verifyCommands,
    watchCommands,
    remoteCommands,
    claimCommands,
    dropCommands,
    humanCommands,
    statsCommands,
    snapshotCommands,
    issueCommands,
  ]),
});
