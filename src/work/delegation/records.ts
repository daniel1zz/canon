import type { CoordDb } from "../db.ts";

export interface ContractItem { readonly path: string; readonly id?: string; readonly hash: string }
export interface Delegation {
  readonly subject: string;
  readonly worker: string;
  readonly owner: string;
  readonly revision: string;
  readonly epoch: number;
  readonly acceptor: string | null;
  readonly manifest: readonly ContractItem[];
  readonly taskHash: string;
  /** Why this delegation is light (BR-2632): its worker runs no tests or builds; null for a heavy delegation. */
  readonly light: string | null;
  /** When the design owner took the change back (BR-2500); null while the delegation is in force. */
  readonly ended: string | null;
}
interface Row extends Omit<Delegation, "manifest" | "taskHash"> { manifest: string; task_hash: string }

export function delegation(db: CoordDb, subject: string): Delegation | undefined {
  const row = db.db.query<Row, [string]>("SELECT * FROM delegations WHERE subject = ?").get(subject);
  if (!row) return undefined;
  const { manifest, task_hash, ...rest } = row;
  return { ...rest, manifest: JSON.parse(manifest), taskHash: task_hash };
}

export function delegationNotice(db: CoordDb, subject: string): string[] {
  const d = delegation(db, subject);
  if (!d) return [];
  const c = db.db.query<{ holder: string; delegation_epoch: number | null }, [string]>("SELECT holder, delegation_epoch FROM claims WHERE subject = ?").get(subject);
  const pending = c?.holder === d.acceptor && c?.delegation_epoch !== d.epoch;
  if (d.ended) return [`${subject}: delegation to ${d.worker} ended at ${d.ended}, taken back by design owner ${d.owner}; epoch ${d.epoch}; delegate it again to hand it to a worker`];
  return [`${subject}: delegated to ${d.worker}; design owner ${d.owner}; revision ${d.revision}; epoch ${d.epoch}; acceptor ${d.acceptor ?? "none"}${d.light !== null ? `; light: ${d.light}` : ""}${pending ? `; new design pending: canon work accept-design ${subject}` : ""}`];
}

/**
 * Ends the delegation in force on `subject` because the change was dropped (BR-2574): as a take ends it (the epoch rises,
 * `ended` is set, BR-2500), with a `delegation.end` event naming the command; nothing when none is in force.
 */
export function endOnDrop(db: CoordDb, actor: string, subject: string, by: "canon work drop" | "canon change drop"): boolean {
  const d = delegation(db, subject);
  if (!d || d.ended !== null) return false;
  const at = new Date().toISOString();
  db.db.query("UPDATE delegations SET epoch = ?, ended = ? WHERE subject = ? AND ended IS NULL").run(d.epoch + 1, at, subject);
  db.event(actor, "delegation.end", subject, { by, worker: d.worker, owner: d.owner, epoch: d.epoch + 1 });
  return true;
}
