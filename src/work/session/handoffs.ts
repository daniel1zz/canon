import type { CoordDb } from "../db.ts";

/**
 * Live coordination operations (design §2). Each is one transaction on the shared DB, so two sessions
 * racing for the same claim or queue slot see a consistent answer (P4).
 */

const now = () => new Date();
const iso = (d: Date) => d.toISOString();

// ---- handoffs: where a change stands when its session stops (P3) ----

/** Why a session stopped (BR-2025, D-151): the state is computed from this, never from the text of the next step. */
export const HANDOFF_REASONS = ["land", "design", "owner", "deps", "partial"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** A handoff's reason and, for `owner`, what it waits on: a question number as `#12` or a success criterion `R-2/S3`. */
export interface Why {
  readonly reason: HandoffReason;
  readonly on: string | null;
}

export interface Handoff {
  readonly subject: string;
  readonly worktree: string | null;
  readonly actor: string;
  readonly next: string;
  readonly note: string | null;
  /** Null on a handoff written before reasons were recorded: shown as `unrecorded` until canon work handoff-reason sets it (BR-2575). */
  readonly reason: HandoffReason | null;
  readonly on: string | null;
  readonly updated_at: string;
}

export function writeHandoff(db: CoordDb, h: Omit<Handoff, "updated_at">): void {
  db.db
    .query("INSERT INTO handoffs(subject, worktree, actor, next, note, reason, on_ref, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET worktree = excluded.worktree, actor = excluded.actor, next = excluded.next, note = excluded.note, reason = excluded.reason, on_ref = excluded.on_ref, updated_at = excluded.updated_at")
    .run(h.subject, h.worktree, h.actor, h.next, h.note, h.reason, h.on, iso(now()));
  db.event(h.actor, "handoff.write", h.subject, { next: h.next, reason: h.reason, on: h.on });
}

/** Sets the reason of the handoff on `subject`, the rest unchanged (BR-2575); false when it has none. */
export function setHandoffReason(db: CoordDb, actor: string, subject: string, why: Why): boolean {
  const before = db.db.query<{ reason: string | null; on_ref: string | null }, [string]>("SELECT reason, on_ref FROM handoffs WHERE subject = ?").get(subject);
  if (!before) return false;
  db.db.query("UPDATE handoffs SET reason = ?, on_ref = ? WHERE subject = ?").run(why.reason, why.on, subject);
  db.event(actor, "handoff.reason", subject, { reason: why.reason, on: why.on, before: { reason: before.reason, on: before.on_ref } });
  return true;
}

export function handoffs(db: CoordDb): Handoff[] {
  return db.db.query<Handoff, []>("SELECT subject, worktree, actor, next, note, reason, on_ref AS \"on\", updated_at FROM handoffs ORDER BY updated_at DESC").all();
}

/** How a handoff's reason is written: `owner #12`, `land`, `unrecorded` for an old one (BR-2025, BR-2572). */
export const reasonText = (h: Pick<Handoff, "reason" | "on">): string => (h.reason === null ? "unrecorded" : h.on ? `${h.reason} ${h.on}` : h.reason);

export function dropHandoff(db: CoordDb, subject: string): void {
  db.db.query("DELETE FROM handoffs WHERE subject = ?").run(subject);
}

/** A handoff's first line, at most 200 characters, for the lists that show every handoff at once (BR-2465). */
export function firstLine(next: string): string {
  const lines = next.split("\n");
  const line = lines[0]!.trimEnd();
  const cut = line.length > 200 ? `${line.slice(0, 200)}…` : line;
  return lines.length > 1 || line.length > 200 ? `${cut} (canon brief in its worktree shows all of it)` : cut;
}
