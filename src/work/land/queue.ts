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
    // reason: solo = 0 says this lander understands batches; an older canon leaves it NULL and is never batched (BR-2172).
    .query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat, pid, pid_start, solo) VALUES (?, ?, 'waiting', ?, ?, ?, ?, 0)")
    .run(worktree, subject, t, t, lander?.pid ?? null, lander?.start ?? null);
  db.event(actor, "queue.enter", subject, { worktree });
  return Number(r.lastInsertRowid);
}

/** The outcome of one try for the turn. `lost` is set when this entry is no longer waiting (BR-2144). */
export interface Turn {
  readonly mine: boolean;
  readonly ahead: number;
  /** Why this entry can never take a turn: its state and result, e.g. `abandoned: lander process gone`. */
  readonly lost?: string;
  /** A leader is testing this entry in its batch: wait, neither take a turn nor refuse (BR-2172). */
  readonly batched?: { readonly leader: number; readonly head: string };
  /** The leader landed this entry in its batch: `sha` is the commit of this change on main (BR-2172). */
  readonly landedBy?: { readonly leader: number; readonly sha: string; readonly head: string };
}

/**
 * Becomes the lander if every earlier entry is finished, stale, or held by a process that is gone. Returns the
 * entries still ahead otherwise. The process probe runs before the transaction so it never holds the write lock.
 * Only an entry that is still 'waiting' can take the turn: one another lander marked abandoned (it stopped
 * heart-beating, or looked gone) gets `lost` and never lands after the landing that skipped it (BR-2144, issue #29).
 */
export function tryTurn(db: CoordDb, entryId: number, staleMs = QUEUE_STALE_MS): Turn {
  const ahead = db.db
    .query<{ id: number; pid: number; pid_start: string }, [number]>("SELECT id, pid, pid_start FROM queue WHERE id < ? AND state IN ('waiting','landing') AND pid IS NOT NULL AND pid_start IS NOT NULL")
    .all(entryId);
  const dead = ahead.filter((e) => isGone({ pid: e.pid, start: e.pid_start }) === true).map((e) => e.id);
  const tx = db.db.transaction((): Turn => {
    // reason: the state is read and set in this one write transaction, so a skipped entry cannot slip back in (BR-2144).
    const own = db.db.query<{ state: string; result: string | null; batch: number | null; head: string | null }, [number]>("SELECT state, result, batch, head FROM queue WHERE id = ?").get(entryId);
    if (own?.state === "landed" && own.batch !== null && own.result && own.head) return { mine: false, ahead: 0, landedBy: { leader: own.batch, sha: own.result, head: own.head } };
    // reason: a batched entry stays 'waiting' with `batch` set, since the state column's CHECK constraint predates batches (D-26).
    if (own?.state === "waiting" && own.batch !== null && own.head) {
      // reason: a leader that is no longer landing (it died, or ended without settling its batch) frees its members to wait again (BR-2172, D-26).
      const leader = db.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(own.batch);
      if (leader?.state === "landing") {
        db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(iso(now()), entryId);
        return { mine: false, ahead: 0, batched: { leader: own.batch, head: own.head } };
      }
      db.db.query("UPDATE queue SET batch = NULL, head = NULL WHERE id = ? AND state = 'waiting'").run(entryId);
    }
    if (!own || own.state !== "waiting") return { mine: false, ahead: 0, lost: own ? `${own.state}${own.result ? `: ${own.result}` : ""}` : "no such queue entry" };
    for (const id of dead) db.db.query("UPDATE queue SET state = 'abandoned', result = 'lander process gone' WHERE id = ? AND state IN ('waiting','landing')").run(id);
    const stale = iso(new Date(now().getTime() - staleMs));
    db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE state IN ('waiting','landing') AND heartbeat < ? AND id != ?").run(stale, entryId);
    db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(iso(now()), entryId);
    const ahead = db.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM queue WHERE id < ? AND state IN ('waiting','landing')").get(entryId)?.n ?? 0;
    if (ahead === 0) db.db.query("UPDATE queue SET state = 'landing' WHERE id = ? AND state = 'waiting'").run(entryId);
    return { mine: ahead === 0, ahead };
  });
  return tx.immediate();
}

/** Beats only while the entry is landing; false once another lander marked it abandoned (BR-2144). */
export function heartbeat(db: CoordDb, entryId: number): boolean {
  return db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ? AND state = 'landing'").run(iso(now()), entryId).changes > 0;
}

/** Whether this entry still holds the turn: 'landing', not abandoned by a later lander meanwhile (BR-2144). */
export function holdsTurn(db: CoordDb, entryId: number): { readonly held: boolean; readonly state: string } {
  const r = db.db.query<{ state: string; result: string | null }, [number]>("SELECT state, result FROM queue WHERE id = ?").get(entryId);
  return { held: r?.state === "landing", state: r ? `${r.state}${r.result ? `: ${r.result}` : ""}` : "no such queue entry" };
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

// ---- batches (D-26): the lander holding the turn tests the entries right behind it together ----

export interface BatchCandidate {
  readonly id: number;
  readonly worktree: string;
  readonly subject: string | null;
}

/**
 * The entries right behind `leader` in queue order that may join its batch, at most `max`: each still waiting,
 * queued by a canon that knows batches and not marked to land on its own, with a live lander that beat within the stale time. Stops at the first entry
 * that may not, so no entry is tested ahead of an earlier one (BR-2020, BR-2172).
 */
export function batchCandidates(db: CoordDb, leader: number, max: number, staleMs = QUEUE_STALE_MS): BatchCandidate[] {
  const rows = db.db
    .query<{ id: number; worktree: string; subject: string | null; state: string; batch: number | null; solo: number | null; heartbeat: string; pid: number | null; pid_start: string | null }, [number]>(
      "SELECT id, worktree, subject, state, batch, solo, heartbeat, pid, pid_start FROM queue WHERE id > ? AND state IN ('waiting','landing') ORDER BY id",
    )
    .all(leader);
  const fresh = iso(new Date(now().getTime() - staleMs));
  const out: BatchCandidate[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    if (r.state !== "waiting" || r.batch !== null || r.solo !== 0 || r.heartbeat < fresh || r.pid === null || r.pid_start === null) break;
    if (isGone({ pid: r.pid, start: r.pid_start }) !== false) break;
    out.push({ id: r.id, worktree: r.worktree, subject: r.subject });
  }
  return out;
}

/** Moves a waiting entry into `leader`'s batch, recording the HEAD it is tested at; false when it is no longer waiting. */
export function joinBatch(db: CoordDb, leader: number, entryId: number, head: string): boolean {
  return db.db.query("UPDATE queue SET batch = ?, head = ? WHERE id = ? AND state = 'waiting' AND batch IS NULL").run(leader, head, entryId).changes > 0;
}

/** Sends a batched entry back to waiting; `solo` marks it to land on its own from now on (BR-2173). False when it had left meanwhile. */
export function leaveBatch(db: CoordDb, entryId: number, solo: boolean): boolean {
  return db.db.query("UPDATE queue SET batch = NULL, head = NULL, solo = ? WHERE id = ? AND state = 'waiting' AND batch IS NOT NULL").run(solo ? 1 : 0, entryId).changes > 0;
}

/** Whether an entry is still in a batch (not killed or abandoned meanwhile). */
export function inBatch(db: CoordDb, entryId: number, leader: number): boolean {
  const r = db.db.query<{ state: string; batch: number | null }, [number]>("SELECT state, batch FROM queue WHERE id = ?").get(entryId);
  return r?.state === "waiting" && r.batch === leader;
}

/** Records a batched entry as landed at `sha`, its own commit on main; false when it had left the batch. */
export function landBatched(db: CoordDb, entryId: number, sha: string): boolean {
  return db.db.query("UPDATE queue SET state = 'landed', result = ?, heartbeat = ? WHERE id = ? AND state = 'waiting' AND batch IS NOT NULL").run(sha, iso(now()), entryId).changes > 0;
}

/** Whether this entry was marked to land on its own after a failed batch (BR-2173). */
export function isSolo(db: CoordDb, entryId: number): boolean {
  return (db.db.query<{ solo: number | null }, [number]>("SELECT solo FROM queue WHERE id = ?").get(entryId)?.solo ?? 0) === 1;
}
