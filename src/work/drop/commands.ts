import { defineCommand } from "citty";
import { entry, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { mainCorpus } from "../session/session.ts";
import { drop } from "./drop.ts";
import { BACKLOG_FILE, backlogAt } from "../../knowledge/documents/backlog.ts";

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
    // A dropped change the owner's order still lists is said, never refused: dropping is legitimate (BR-2064, #112).
    const id = String(args.change).toUpperCase();
    const listed = must(backlogAt(ws.primary, ws.config.main, ws.config.types)).find((e) => e.id === id);
    if (listed) say(`${id} is still listed in ${BACKLOG_FILE}:${listed.line} on ${ws.config.main}; the owner removes that line if the work will not happen`);
  },
});

export const dropCommands: DomainCommands = { commands: [entry("drop", 60, dropCmd, "work")] };
