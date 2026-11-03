import { defineCommand } from "citty";
import { entry, EXIT, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { watch } from "./watch.ts";

/** `canon floor watch`: the background floor of merge-then-test (D-31). */

const watchCmd = defineCommand({
  meta: { description: "With floor_timing: after, test main's latest commit in a temporary worktree; one at a time, latest commit only (landings and canon brief start it)" },
  async run() {
    const ws = workspace();
    const r = must(await watch(ws, say));
    // reason: exit 1 when the last commit it tested failed, as a refusing check exits (D-4); the result is also in floor.fail.
    if (r.tested.at(-1)?.passed === false) process.exit(EXIT.refused);
  },
});

export const watchCommands: DomainCommands = {
  groups: [{ name: "floor", rank: 125, meta: { description: "The floor run in the background on main (floor_timing: after, D-31)" } }],
  commands: [entry("watch", 10, watchCmd, "floor")],
};
