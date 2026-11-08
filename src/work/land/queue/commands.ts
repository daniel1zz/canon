import { defineCommand } from "citty";
import { entry, fail, must, say, workspace, type DomainCommands } from "../../../invocation/command.ts";
import { namedChange } from "../../humans/commands.ts";
import { changeOffMain, mainCorpus } from "../../session/session.ts";
import { findDoc } from "../../../knowledge/query/query.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { Workspace } from "../../workspace.ts";
import { clear, mark } from "./urgent.ts";

/** The status of change `id`, from main or from its own branch. */
function changeStatus(ws: Workspace, id: string): Result<string> {
  const onMain = mainCorpus(ws);
  if (!onMain.ok) return onMain;
  const doc = findDoc(onMain.value, id);
  if (doc?.kind === "change") return ok(doc.status);
  const off = changeOffMain(ws, id);
  if (!off.ok) return off;
  return off.value ? ok(off.value.doc.status) : err("not_found", `${id} is not a change`);
}

/** `canon backlog urgent`: the owner's priority for the landing queue (BR-2375, D-69). */

const urgent = defineCommand({
  meta: {
    description:
      "Record the owner's priority for a change at once: it lands before the other waiting changes (after the fix of a failing main). Agents use it ONLY when the owner asked for it in the conversation, passing their words with --relayed; it ends when the change lands or with --clear",
  },
  args: {
    change: { type: "positional", required: true, description: "The change (C-n)" },
    relayed: { type: "string", description: "The owner's own words this passes on (required, recorded with who relayed them)" },
    clear: { type: "boolean", description: "Remove the priority again" },
  },
  run({ args }) {
    const ws = workspace();
    const relayed = typeof args.relayed === "string" ? args.relayed : undefined;
    const name = String(args.change);
    // reason: only an open change can be waiting to land; anything else is a typo, not a priority (BR-2375)
    const subject = must(namedChange(ws, name));
    const status = must(changeStatus(ws, subject));
    if (status !== "open" && !args.clear) {
      ws.db.event(ws.actor, "urgent.refuse", subject, { reason: "not-open", status });
      fail({ code: "invalid", message: `${subject} is ${status}, not open: only a change that can still land has a priority` });
    }
    if (args.clear) {
      must(clear(ws.db, ws.actor, subject, relayed));
      say(`${subject} is no longer urgent`);
      return;
    }
    must(mark(ws.db, ws.actor, subject, relayed));
    say(`${subject} is urgent: it takes the next turn in the landing queue (relayed by ${ws.actor}); it ends when ${subject} lands or with --clear`);
  },
});

export const urgentCommands: DomainCommands = {
  groups: [{ name: "backlog", rank: 128, meta: { description: "The owner's priorities for the landing queue" } }],
  commands: [entry("urgent", 10, urgent, "backlog")],
};
