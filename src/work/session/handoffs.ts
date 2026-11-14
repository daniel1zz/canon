import type { CoordDb } from "../db.ts";

/**
 * Live coordination operations (design §2). Each is one transaction on the shared DB, so two sessions
 * racing for the same claim or queue slot see a consistent answer (P4).
 */

const now = () => new Date();
const iso = (d: Date) => d.toISOString();

// ---- handoffs: where a change stands when its session stops (P3) ----

export interface Handoff {
  readonly subject: string;
  readonly worktree: string | null;
  readonly actor: string;
  readonly next: string;
  readonly note: string | null;
  readonly updated_at: string;
}

export function writeHandoff(db: CoordDb, h: Omit<Handoff, "updated_at">): void {
  db.db
    .query("INSERT INTO handoffs(subject, worktree, actor, next, note, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET worktree = excluded.worktree, actor = excluded.actor, next = excluded.next, note = excluded.note, updated_at = excluded.updated_at")
    .run(h.subject, h.worktree, h.actor, h.next, h.note, iso(now()));
  db.event(h.actor, "handoff.write", h.subject, { next: h.next });
}

export function handoffs(db: CoordDb): Handoff[] {
  return db.db.query<Handoff, []>("SELECT subject, worktree, actor, next, note, updated_at FROM handoffs ORDER BY updated_at DESC").all();
}

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
