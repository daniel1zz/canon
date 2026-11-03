import { defineCommand } from "citty";
import { entry, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { mainCorpus } from "../session/session.ts";
import { drop } from "./drop.ts";

/** `canon work drop`. */

const dropCmd = defineCommand({
  meta: { description: "Drop a change's worktree, branch and claim; archives anything that would be lost to refs/canon/archive first" },
  args: { change: { type: "positional", required: true } },
  run({ args }) {
    const ws = workspace();
    must(drop(ws, String(args.change), say));
    const onMain = mainCorpus(ws);
    const doc = onMain.ok ? findDoc(onMain.value, String(args.change)) : undefined;
    if (doc?.kind === "change" && doc.status === "open") say(`${doc.id} is still open on ${ws.config.main}; mark it with \`canon change drop ${doc.id}\` in a change if the work will not happen`);
  },
});

export const dropCommands: DomainCommands = { commands: [entry("drop", 60, dropCmd, "work")] };
