import { defineCommand } from "citty";
import { entry, EXIT, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { takesMany } from "../../invocation/strict.ts";
import { workTest, workTestFailed } from "./verify.ts";
import { backgroundRun, recordExit } from "../land/detach.ts";
import { stopTest, testInBackground, TEST_RUN } from "./background.ts";

/** `canon work test`. */

const test = takesMany(defineCommand({
  meta: { description: "Run the test files related to this change (changed tests, tests importing changed files, tests naming touched rules), one file per test_command run; --all runs every test file; named files run instead of selecting" },
  args: {
    all: { type: "boolean", description: "Run every test file, not only the related ones" },
    files: { type: "positional", required: false, description: "Test files to run instead of selecting; their reports are recorded (BR-2344)" },
    stop: { type: "boolean", description: "Stop this worktree's test run going on in the background and print how it ended" },
  },
  async run({ args }) {
    const ws = workspace();
    const only = args._.map(String);
    if (args.all && only.length > 0) fail({ code: "invalid", message: "name test files or pass --all, not both" });
    const run = backgroundRun(process.env, process.ppid, TEST_RUN.env);
    if (run === undefined) {
      if (args.stop) {
        if (args.all || only.length > 0) fail({ code: "invalid", message: "--stop takes no test files and no --all" });
        const stopped = await stopTest(ws);
        if (!stopped.ok) fail({ code: stopped.code, message: stopped.message });
        process.exit(stopped.ok ? stopped.code : EXIT.ok);
      }
      // The run goes on in its own background process; this one only follows it and exits with its code (BR-2467).
      process.exit(await testInBackground(ws, [...(args.all ? ["--all"] : []), ...only]));
    }
    if (args.stop) fail({ code: "invalid", message: "--stop is not for the background test run itself" });
    recordExit(run);
    const r = must(await workTest(ws, Boolean(args.all), say, undefined, only));
    if (workTestFailed(r)) process.exit(EXIT.refused);
  },
}));

export const verifyCommands: DomainCommands = { commands: [entry("test", 30, test, "work")] };
