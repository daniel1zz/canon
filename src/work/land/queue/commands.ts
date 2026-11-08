import { defineCommand } from "citty";
import { entry, fail, must, say, workspace, type DomainCommands } from "../../../invocation/command.ts";
import { namedChange } from "../../humans/commands.ts";
import { changeOffMain, mainCorpus } from "../../session/session.ts";
import { findDoc } from "../../../knowledge/query/query.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { Workspace } from "../../workspace.ts";
import { clear, mark } from "./urgent.ts";

/** Change `id`'s status and whether it can still land: open on main, or open or closed by `land --finish` on its own branch and not yet on main. */
function changeStatus(ws: Workspace, id: string): Result<{ status: string; canLand: boolean }> {
  const onMain = mainCorpus(ws);
  if (!onMain.ok) return onMain;
  const doc = findDoc(onMain.value, id);
  if (doc?.kind === "change") return ok({ status: doc.status, canLand: doc.status === "open" });
  const off = changeOffMain(ws, id);
  if (!off.ok) return off;
  if (!off.value) return err("not_found", `${id} is not a change`);
  const status = off.value.doc.status;
  // reason: land --finish commits status: done on the branch before it waits in the queue, so done there still has to land (BR-2363, #153)
  return ok({ status, canLand: status === "open" || status === "done" });
}

/** `canon backlog urgent`: the owner's priority for the landing queue (BR-2363, D-69). */

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
    // reason: only a change that can still land can be waiting to land; anything else is a typo, not a priority (BR-2363)
    const subject = must(namedChange(ws, name));
    const { status, canLand } = must(changeStatus(ws, subject));
    if (!canLand && !args.clear) {
      ws.db.event(ws.actor, "urgent.refuse", subject, { reason: "not-open", status });
      fail({ code: "invalid", message: `${subject} is ${status} and cannot land: only a change that can still land has a priority` });
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
