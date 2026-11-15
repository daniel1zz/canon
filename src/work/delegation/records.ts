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
  return [`${subject}: delegated to ${d.worker}; design owner ${d.owner}; revision ${d.revision}; epoch ${d.epoch}; acceptor ${d.acceptor ?? "none"}${pending ? `; new design pending: canon work accept-design ${subject}` : ""}`];
}
