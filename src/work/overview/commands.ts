import { defineCommand } from "citty";
import { entry, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { historyJson, historyLines, LANDED_DETAIL, overview, overviewJson, overviewLines } from "./overview.ts";
import { remaining, remainingLines } from "./remaining.ts";

/** `canon overview`: the current state only (BR-2505, D-129, D-151); `--history` for the detail. */
const command = defineCommand({
  meta: { description: "The current state: the current release with its rules and each success criterion's state, the agenda (delegate, judge, owner), the changes in progress or waiting, and a history outline; --history gives the recent goal changes and landings in full" },
  args: { json: { type: "boolean" }, history: { type: "boolean", description: "The recent goal changes in full and the last 10 landings with what they advanced" } },
  run({ args }) {
    const ws = workspace();
    if (args.history) {
      const o = must(overview(ws, { ruleCounts: false, agenda: false, landed: LANDED_DETAIL }));
      if (args.json) return json(historyJson(o));
      for (const line of historyLines(o)) say(line);
      return;
    }
    const o = must(overview(ws, { ruleCounts: true }));
    if (args.json) return json(overviewJson(o));
    for (const line of overviewLines(o)) say(line);
  },
});

/** `canon work remaining`: every unfinished item by source (BR-2629, #298). */
const remainingCmd = defineCommand({
  meta: { description: "Everything unfinished, by source: open changes, rules not passed, open review findings, unanswered questions, accepted decisions no rule or change names" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const r = must(remaining(workspace()));
    if (args.json) return json(r);
    for (const line of remainingLines(r)) say(line);
  },
});

export const overviewCommands: DomainCommands = { commands: [entry("overview", 25, command), entry("remaining", 52, remainingCmd, "work")] };
