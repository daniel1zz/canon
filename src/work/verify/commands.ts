import { defineCommand } from "citty";
import { entry, EXIT, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { takesMany } from "../../invocation/strict.ts";
import { workTest, workTestFailed } from "./verify.ts";

/** `canon work test`. */

const test = takesMany(defineCommand({
  meta: { description: "Run the test files related to this change (changed tests, tests importing changed files, tests naming touched rules), one file per test_command run; --all runs every test file; named files run instead of selecting" },
  args: {
    all: { type: "boolean", description: "Run every test file, not only the related ones" },
    files: { type: "positional", required: false, description: "Test files to run instead of selecting; their reports are recorded (BR-2344)" },
  },
  async run({ args }) {
    const ws = workspace();
    const only = args._.map(String);
    if (args.all && only.length > 0) fail({ code: "invalid", message: "name test files or pass --all, not both" });
    const r = must(await workTest(ws, Boolean(args.all), say, undefined, only));
    if (workTestFailed(r)) process.exit(EXIT.refused);
  },
}));

export const verifyCommands: DomainCommands = { commands: [entry("test", 30, test, "work")] };
