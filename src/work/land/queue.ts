import type { CoordDb } from "../db.ts";
import { isGone, type Proc } from "../claims/liveness.ts";

/**
 * Live coordination operations (design §2). Each is one transaction on the shared DB, so two sessions
 * racing for the same claim or queue slot see a consistent answer (P4).
 */
/** Default; projects set their own in canon/config.yaml (`lander_stale_minutes`). */
export const QUEUE_STALE_MS = 10 * 60 * 1000;

const now = () => new Date();
const iso = (d: Date) => d.toISOString();

// ---- landing queue: FIFO, one lander at a time; a lander that stops heart-beating is skipped ----

export interface QueueEntry {
  readonly id: number;
  readonly worktree: string;
  readonly subject: string | null;
  readonly state: string;
  readonly enqueued_at: string;
  readonly heartbeat: string;
}

/** `lander` is the landing process itself, so a waiter can see at once that it died (D-11). */
export function enqueue(db: CoordDb, worktree: string, subject: string | null, actor: string, lander?: Proc): number {
  const t = iso(now());
  const r = db.db
    .query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat, pid, pid_start) VALUES (?, ?, 'waiting', ?, ?, ?, ?)")
    .run(worktree, subject, t, t, lander?.pid ?? null, lander?.start ?? null);
  db.event(actor, "queue.enter", subject, { worktree });
  return Number(r.lastInsertRowid);
}

/**
 * Becomes the lander if every earlier entry is finished, stale, or held by a process that is gone. Returns the
 * entries still ahead otherwise. The process probe runs before the transaction so it never holds the write lock.
 */
export function tryTurn(db: CoordDb, entryId: number, staleMs = QUEUE_STALE_MS): { readonly mine: boolean; readonly ahead: number } {
  const ahead = db.db
    .query<{ id: number; pid: number; pid_start: string }, [number]>("SELECT id, pid, pid_start FROM queue WHERE id < ? AND state IN ('waiting','landing') AND pid IS NOT NULL AND pid_start IS NOT NULL")
    .all(entryId);
  const dead = ahead.filter((e) => isGone({ pid: e.pid, start: e.pid_start }) === true).map((e) => e.id);
  const tx = db.db.transaction(() => {
    for (const id of dead) db.db.query("UPDATE queue SET state = 'abandoned', result = 'lander process gone' WHERE id = ? AND state IN ('waiting','landing')").run(id);
    const stale = iso(new Date(now().getTime() - staleMs));
    db.db.query("UPDATE queue SET state = 'abandoned' WHERE state IN ('waiting','landing') AND heartbeat < ? AND id != ?").run(stale, entryId);
    db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(iso(now()), entryId);
    const ahead = db.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM queue WHERE id < ? AND state IN ('waiting','landing')").get(entryId)?.n ?? 0;
    if (ahead === 0) db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(entryId);
    return { mine: ahead === 0, ahead };
  });
  return tx.immediate();
}

export function heartbeat(db: CoordDb, entryId: number): void {
  db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(iso(now()), entryId);
}

export function finishEntry(db: CoordDb, entryId: number, state: "landed" | "failed", result: string): void {
  db.db.query("UPDATE queue SET state = ?, result = ?, heartbeat = ? WHERE id = ?").run(state, result, iso(now()), entryId);
}

/** Marks an entry failed only while it is still waiting or landing; false when it had already finished. */
export function failIfActive(db: CoordDb, entryId: number, result: string): boolean {
  return db.db.query("UPDATE queue SET state = 'failed', result = ?, heartbeat = ? WHERE id = ? AND state IN ('waiting','landing')").run(result, iso(now()), entryId).changes > 0;
}

export function activeQueue(db: CoordDb): QueueEntry[] {
  return db.db.query<QueueEntry, []>("SELECT id, worktree, subject, state, enqueued_at, heartbeat FROM queue WHERE state IN ('waiting','landing') ORDER BY id").all();
}
