import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../db.ts";
import { delegation, type Delegation } from "./records.ts";
import { isWorker } from "./worker.ts";

/**
 * `designer`: the worker may design (BR-2633). It may also take up a change that has no delegation in force and no live claim
 * (the claim itself is checked by whoever takes it), where a plain worker may start only the change delegated to its name.
 */
export function workerMayStart(db: CoordDb, subject: string, actor: string, designer = false): Result<Delegation | undefined> {
  if (!isWorker(actor)) return ok(undefined);
  const d = delegation(db, subject);
  if (designer && (!d || d.ended)) return ok(undefined);
  const name = actor.split(":").slice(2).join(":");
  if (d?.ended) return err("refused", `${subject}: its delegation to ${d.worker} ended when design owner ${d.owner} took it back at ${d.ended}; ask the design owner to canon work delegate it again`);
  if (!d || d.worker !== name || (d.acceptor !== null && d.acceptor !== actor)) {
    return err("refused", `${subject}: ${d ? `delegated to ${d.worker}; acceptor ${d.acceptor ?? "none"}` : "未派发"}; ask the design owner to canon work delegate it`);
  }
  return ok(d);
}

/** Called inside the claim mutation's transaction, before any lapse takeover or lease write (BR-2498). */
export function workerMayUseClaim(db: CoordDb, subject: string, actor: string): Result<void> {
  if (!isWorker(actor)) return ok(undefined);
  const d = delegation(db, subject);
  if (!d) return ok(undefined);
  // reason: a take ends the delegation and voids every older epoch for good (BR-2500, BR-2498)
  if (d.ended) return err("conflict", `${subject}: its delegation ended when design owner ${d.owner} took it back at ${d.ended}; this worker's claim no longer counts; nothing changed`);
  const c = db.db.query<{ holder: string; delegation_epoch: number | null }, [string]>("SELECT holder,delegation_epoch FROM claims WHERE subject = ?").get(subject);
  return d.acceptor === actor && c?.holder === actor && c.delegation_epoch === d.epoch
    ? ok(undefined)
    : err("conflict", `${subject}: only acceptor ${d.acceptor ?? "none"} holding epoch ${d.epoch} may use this claim; run canon work accept-design ${subject} if a new design is pending; nothing changed`);
}

export const workerNewWorkError = () => err("refused", "new work must be created by the design owner, then assigned with canon work delegate; workers cannot create changes or chores");
