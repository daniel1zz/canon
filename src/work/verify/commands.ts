import { defineCommand } from "citty";
import { entry, EXIT, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { workTest } from "./verify.ts";

/** `canon work test`. */

const test = defineCommand({
  meta: { description: "Run the test files related to this change (changed tests, tests importing changed files, tests naming touched rules), one file per test_command run; --all runs every test file" },
  args: { all: { type: "boolean", description: "Run every test file, not only the related ones" } },
  async run({ args }) {
    const ws = workspace();
    const r = must(await workTest(ws, Boolean(args.all), say));
    if (r.failed > 0) process.exit(EXIT.refused);
  },
});

export const verifyCommands: DomainCommands = { commands: [entry("test", 30, test, "work")] };
