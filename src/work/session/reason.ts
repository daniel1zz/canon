import { err, ok, type Result } from "../../kernel/result.ts";
import { isCriterionRef } from "../../knowledge/changes/links.ts";
import { criteriaByDoc } from "../../knowledge/releases/features.ts";
import type { Workspace } from "../workspace.ts";
import { HANDOFF_REASONS, type HandoffReason, type Why } from "./handoffs.ts";
import { mainCorpus } from "./session.ts";

/**
 * A handoff's reason as written on the command line (BR-2025, BR-2575, D-151), checked before anything is written: one
 * of the five reasons, `--on` only and always with `owner`. What `--on` names is checked by `whyOn` once the change is known.
 */
export function reasonArg(reason: unknown, on: unknown): Result<{ reason: HandoffReason; on: string | undefined }> {
  const list = HANDOFF_REASONS.join(", ");
  if (typeof reason !== "string" || reason.trim() === "") return err("invalid", `--reason is required: one of ${list} (BR-2025); canon reads the reason, never the text of --next`);
  const r = reason.trim().toLowerCase();
  if (!(HANDOFF_REASONS as readonly string[]).includes(r)) return err("invalid", `--reason ${reason}: give one of ${list} (BR-2025)`);
  const target = typeof on === "string" && on.trim() !== "" ? on.trim() : undefined;
  if (r === "owner" && target === undefined) return err("invalid", "--reason owner needs --on <question number> (asked with canon human ask --change <C-n>) or --on <R-n/S<k>> (BR-2025)");
  if (r !== "owner" && target !== undefined) return err("invalid", `--on is only for --reason owner; ${r} waits on nothing a number names (BR-2025)`);
  return ok({ reason: r as HandoffReason, on: target });
}

/**
 * The reason with what `owner` waits on resolved for `subject` (BR-2025): a question must be asked for this change, so
 * the owner's answer is known to free it (D-151); a success criterion must exist on main (D-149).
 */
export function whyOn(ws: Workspace, subject: string, arg: { reason: HandoffReason; on: string | undefined }): Result<Why> {
  if (arg.on === undefined) return ok({ reason: arg.reason, on: null });
  const target = arg.on.toUpperCase();
  if (isCriterionRef(target)) {
    const main = mainCorpus(ws);
    if (!main.ok) return main;
    const [doc, sid] = target.split("/") as [string, string];
    if (!criteriaByDoc(main.value).get(doc)?.some((c) => c.id === sid)) return err("not_found", `--on ${target}: no such success criterion on ${ws.config.main} (BR-2025)`);
    return ok({ reason: arg.reason, on: target });
  }
  const m = /^#?(\d+)$/.exec(arg.on);
  if (!m) return err("invalid", `--on ${arg.on}: give a question number (#12) or a success criterion (R-2/S3) (BR-2025)`);
  const q = ws.db.db.query<{ subject: string | null }, [number]>("SELECT subject FROM questions WHERE id = ?").get(Number(m[1]));
  if (!q) return err("invalid", `--on #${m[1]}: no such question; ask it with canon human ask --change ${subject} "<question>" (BR-2025)`);
  if (q.subject !== subject) return err("invalid", `--on #${m[1]}: that question is ${q.subject ? `about ${q.subject}` : "about no change"}, not ${subject}; ask it with canon human ask --change ${subject} "<question>" (BR-2025)`);
  return ok({ reason: arg.reason, on: `#${m[1]}` });
}
