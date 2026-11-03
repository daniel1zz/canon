import { defineCommand } from "citty";
import { entry, json, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { issueStatus, renderIssues } from "./issues.ts";

/** Open GitHub issues and the commits on main that name them as fixed; read only (BR-2168, BR-2170). */
const issues = defineCommand({
  meta: { description: "List the project's open GitHub issues (through gh, read only) and whether a commit on main names each as fixed" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const list = must(issueStatus(ws));
    if (args.json) return json(list);
    for (const line of renderIssues(list, ws.config.main)) say(line);
  },
});

export const issueCommands: DomainCommands = { commands: [entry("issues", 180, issues)] };
