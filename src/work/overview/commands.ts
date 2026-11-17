import { defineCommand } from "citty";
import { entry, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { overview, overviewJson, overviewLines } from "./overview.ts";

/** `canon overview`: the whole progress from the current release down (BR-2505, D-129). */
const command = defineCommand({
  meta: { description: "Whole progress, largest first: the current release with each success criterion's state and evidence, plans, what waits for the owner, the head of the owner's order, recent landings" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const o = must(overview(workspace(), { ruleCounts: true }));
    if (args.json) return json(overviewJson(o));
    for (const line of overviewLines(o)) say(line);
  },
});

export const overviewCommands: DomainCommands = { commands: [entry("overview", 25, command)] };
