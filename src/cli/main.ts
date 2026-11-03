#!/usr/bin/env bun
import { defineCommand, renderUsage, runCommand } from "citty";
import { assemble, EXIT } from "./command.ts";
import { argumentProblem, resolve } from "./strict.ts";
import { installCommands } from "./install/commands.ts";
import { configCommands } from "../config/commands.ts";
import { referenceCommands } from "../config/reference/commands.ts";
import { checkCommands } from "../knowledge/check/commands.ts";
import { documentCommands } from "../knowledge/documents/commands.ts";
import { queryCommands } from "../knowledge/query/commands.ts";
import { workCommands } from "../work/commands.ts";
import { dropCommands } from "../work/drop/commands.ts";
import { humanCommands } from "../work/humans/commands.ts";
import { issueCommands } from "../work/issues/commands.ts";
import { landCommands } from "../work/land/commands.ts";
import { sessionCommands } from "../work/session/commands.ts";
import { statsCommands } from "../work/stats/commands.ts";
import { verifyCommands } from "../work/verify/commands.ts";

/**
 * Only assembles: every domain defines its commands in commands.ts in its own directory, with their place in --help,
 * so a new command never edits this file; it changes only when a domain is added (C-132, D-15).
 */
const main = defineCommand({
  meta: { name: "canon", description: "Shared memory and coordination for a project built by many concurrent AI sessions" },
  subCommands: assemble([
    installCommands,
    configCommands,
    referenceCommands,
    checkCommands,
    documentCommands,
    queryCommands,
    workCommands,
    sessionCommands,
    landCommands,
    verifyCommands,
    dropCommands,
    humanCommands,
    statsCommands,
    issueCommands,
  ]),
});

/**
 * citty's runMain exits 1 on every error; canon keeps 1 for check refusals, so usage errors exit 2 and
 * unexpected exceptions (bugs) exit 70 (D-4). Help prints usage to stdout and exits 0, before any argument check.
 */
async function run(): Promise<void> {
  const raw = process.argv.slice(2);
  const at = resolve(main, raw);
  // reason: after `--` every word is a positional argument, `--help` included, as citty parses it (BR-2194)
  const options = raw.includes("--") ? raw.slice(0, raw.indexOf("--")) : raw;
  if (options.includes("--help") || options.includes("-h")) {
    // reason: printed with console.log, not citty's runMain: consola is silent under a test runner, so help could not be tested.
    // Its backticks are markup consola would have turned into colour.
    // reason: citty names a command without meta.name after process.argv[1], which is "/$bunfs/root/canon" in the compiled
    // binary and the script path under bun; give it the words that named the command instead (BR-2101).
    const leaf = { ...at.cmd, meta: { ...((at.cmd.meta ?? {}) as object), name: at.path.at(-1) ?? "canon" } };
    const parent = at.path.length > 0 ? { meta: { name: ["canon", ...at.path.slice(0, -1)].join(" ") } } : undefined;
    console.log(`${(await renderUsage(leaf, parent)).replaceAll("`", "")}\n`);
    return;
  }
  // Before anything runs: an argument the command does not declare is a usage error, never ignored (BR-2097).
  const problem = argumentProblem(main, raw);
  if (problem) {
    console.error(`canon: ${problem}`);
    process.exit(EXIT.usage);
  }
  try {
    await runCommand(main, { rawArgs: raw });
  } catch (e) {
    if (e instanceof Error && e.name === "CLIError") {
      console.error(`canon: ${e.message} (see \`${["canon", ...at.path].join(" ")} --help\`)`);
      process.exit(EXIT.usage);
    }
    console.error(`canon: internal error (a bug in canon): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(EXIT.internal);
  }
}

await run();
