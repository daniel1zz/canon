import { defineCommand } from "citty";
import { entry, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { ISSUE_LIMIT, issueStatus, LIMIT_NOTE, renderIssues } from "./issues.ts";

/** Open GitHub issues and the commits on main that name them as fixed; read only (BR-2168, BR-2170, BR-2225). */
const issues = defineCommand({
  meta: { description: "List the project's open GitHub issues (through gh, read only) and whether a commit on main names each as fixed" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const list = must(issueStatus(ws));
    if (args.json) {
      // reason: the JSON fields are fixed (BR-2206), so the note on a list cut at the limit goes to stderr (BR-2225)
      if (list.length >= ISSUE_LIMIT) console.error(`canon issues: read ${list.length} open issues, ${LIMIT_NOTE}`);
      return json(list);
    }
    for (const line of renderIssues(list, ws.config.main)) say(line);
  },
});

export const issueCommands: DomainCommands = { commands: [entry("issues", 180, issues)] };
