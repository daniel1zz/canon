import type { CoordDb } from "../../db.ts";
import { isGone, type Proc } from "../../claims/liveness.ts";

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
  return enter(db, worktree, subject, actor, lander).id;
}

/**
 * Where a landing entered the queue: `kept` when it took back the place its last attempt kept for it, after a conflict
 * refusal (BR-2177), a timeout or a signal (BR-2368); `after` says which.
 */
export interface Entered {
  readonly id: number;
  readonly kept?: { readonly resolveMs: number; readonly after: "conflict" | "timeout" | "killed" };
}

/**
 * Enters the landing queue. A landing from the same worktree and change whose last entry stopped (refused for a
 * conflict, timed out, or killed by a signal) and kept its place takes that entry back within its keep time, so it is
 * ahead of every entry queued after it (BR-2177, BR-2368, D-29, D-75);
 * otherwise it gets a new entry at the tail. Looked up and taken in one transaction, so it is taken at most once.
 */
export function enter(db: CoordDb, worktree: string, subject: string | null, actor: string, lander?: Proc): Entered {
  const tx = db.db.transaction((): Entered => {
    const t = iso(now());
    const kept = db.db
      .query<{ id: number; heartbeat: string; result: string | null }, [string, string | null, string]>(
        "SELECT id, heartbeat, result FROM queue WHERE worktree = ? AND subject IS ? AND state = 'failed' AND keep_until IS NOT NULL AND keep_until >= ? ORDER BY id DESC LIMIT 1",
      )
      .get(worktree, subject, t);
    if (kept) {
      // reason: the row keeps its id, and queue order is id order, so it is back where it was (BR-2177); it is a fresh attempt otherwise (solo, batch reset).
      db.db
        .query("UPDATE queue SET state = 'waiting', result = NULL, heartbeat = ?, pid = ?, pid_start = ?, solo = 0, batch = NULL, head = NULL, keep_until = NULL WHERE id = ? AND state = 'failed'")
        .run(t, lander?.pid ?? null, lander?.start ?? null, kept.id);
      // The heartbeat of a failed entry is the time it was refused (finishEntry), so this is how long the conflict took to resolve.
      const resolveMs = Date.parse(t) - Date.parse(kept.heartbeat);
      // reason: the row's result says why the place was kept: `conflict: ...`, `timeout` or `killed` (BR-2368); stats count them apart (BR-2155).
      const after = kept.result === "timeout" || kept.result === "killed" ? kept.result : "conflict";
      db.event(actor, "queue.enter", subject, { worktree, kept_place: kept.id, resolve_ms: resolveMs, kept_after: after });
      return { id: kept.id, kept: { resolveMs, after } };
    }
    const r = db.db
      // reason: solo = 0 says this lander understands batches; an older canon leaves it NULL and is never batched (BR-2172).
      .query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat, pid, pid_start, solo) VALUES (?, ?, 'waiting', ?, ?, ?, ?, 0)")
      .run(worktree, subject, t, t, lander?.pid ?? null, lander?.start ?? null);
    db.event(actor, "queue.enter", subject, { worktree });
    return { id: Number(r.lastInsertRowid) };
  });
  return tx.immediate();
}

/**
 * Fails an entry that stopped for a conflict, a timeout or a signal, keeping its place for `keepMs` so that its own
 * next landing takes it back (BR-2177, BR-2368). Returns until when, or null when `keepMs` is 0 (the landing goes to the tail, as before D-29).
 */
export function failKeepingPlace(db: CoordDb, entryId: number, result: string, keepMs: number): string | null {
  const t = now();
  const until = keepMs > 0 ? iso(new Date(t.getTime() + keepMs)) : null;
  db.db.query("UPDATE queue SET state = 'failed', result = ?, heartbeat = ?, keep_until = ? WHERE id = ?").run(result, iso(t), until, entryId);
  return until;
}

/** Entries refused for a conflict whose place is still kept: their landers are resolving it (BR-2177). */
export function keptPlaces(db: CoordDb): (QueueEntry & { readonly keep_until: string })[] {
  return db.db
    .query<QueueEntry & { keep_until: string }, [string]>("SELECT id, worktree, subject, 'resolving' AS state, enqueued_at, heartbeat, keep_until FROM queue WHERE state = 'failed' AND keep_until >= ? ORDER BY id")
    .all(iso(now()));
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
  /** The leader refused this entry in its batch: the floor failed once this change joined the chain (BR-2173). */
  readonly refusedBy?: { readonly leader: number; readonly reason: "floor"; readonly message: string };
}

/** How a batch refusal is kept in the queue row's `result`, so the member's own lander can read it back (BR-2173). */
const REFUSED_IN_BATCH = "refused in batch: ";

/**
 * Who lands first among waiting entries (BR-2232, BR-2363, D-34, D-73): the change that fixes a failing main, then the
 * changes the owner marked with `canon backlog urgent` (in the coordination DB), then the changes the owner lists
 * under 优先合入 in canon/backlog.md on main, then everyone else; within one rank, queue order.
 */
export interface Priority {
  readonly fix?: string | undefined;
  /** Marked with `canon backlog urgent` (BR-2363). */
  readonly marked?: ReadonlySet<string> | undefined;
  readonly urgent: ReadonlySet<string>;
}

export const NO_PRIORITY: Priority = { urgent: new Set() };

export function rankOf(subject: string | null, p: Priority): number {
  if (subject === null) return 0;
  if (p.fix !== undefined && subject === p.fix) return 3;
  if (p.marked?.has(subject)) return 2;
  return p.urgent.has(subject) ? 1 : 0;
}

/** Whether entry `a` lands before entry `b`: higher rank first, then the lower queue id (BR-2232, BR-2020). */
export function landsBefore(a: { id: number; subject: string | null }, b: { id: number; subject: string | null }, p: Priority): boolean {
  const ra = rankOf(a.subject, p);
  const rb = rankOf(b.subject, p);
  return ra !== rb ? ra > rb : a.id < b.id;
}

/**
 * Becomes the lander if every earlier entry is finished, stale, or held by a process that is gone. Returns the
 * entries still ahead otherwise. The process probe runs before the transaction so it never holds the write lock.
 * Only an entry that is still 'waiting' can take the turn: one another lander marked abandoned (it stopped
 * heart-beating, or looked gone) gets `lost` and never lands after the landing that skipped it (BR-2144, issue #29).
 */
export function tryTurn(db: CoordDb, entryId: number, staleMs = QUEUE_STALE_MS, priority: Priority = NO_PRIORITY): Turn {
  // reason: with priorities any other active entry can be ahead (BR-2232), and an entry that took its kept place back
  // can be ahead of one that is landing (BR-2177, BR-2178), so every other active entry is probed.
  const ahead = db.db
    .query<{ id: number; pid: number; pid_start: string }, [number]>("SELECT id, pid, pid_start FROM queue WHERE id != ? AND state IN ('waiting','landing') AND pid IS NOT NULL AND pid_start IS NOT NULL")
    .all(entryId);
  const gone = ahead.filter((e) => isGone({ pid: e.pid, start: e.pid_start }) === true);
  const dead = gone.map((e) => e.id);
  const tx = db.db.transaction((): Turn => {
    // reason: the state is read and set in this one write transaction, so a skipped entry cannot slip back in (BR-2144).
    const own = db.db.query<{ state: string; result: string | null; batch: number | null; head: string | null; heartbeat: string }, [number]>("SELECT state, result, batch, head, heartbeat FROM queue WHERE id = ?").get(entryId);
    // reason: a poller whose own last heartbeat is older than the stale time was itself not running (system sleep), so every
    // heartbeat it sees is stale because of that; it only refreshes its own and judges nobody on this poll (BR-2044, issue #138).
    // A stale time of 0 has no window to be frozen for: every heartbeat is older than it, so the grace never applies.
    const frozen = staleMs > 0 && !!own && own.heartbeat < iso(new Date(now().getTime() - staleMs));
    if (own?.state === "landed" && own.batch !== null && own.result && own.head) return { mine: false, ahead: 0, landedBy: { leader: own.batch, sha: own.result, head: own.head } };
    if (own?.state === "failed" && own.batch !== null && own.result?.startsWith(REFUSED_IN_BATCH)) return { mine: false, ahead: 0, refusedBy: { leader: own.batch, reason: "floor", message: own.result.slice(REFUSED_IN_BATCH.length) } };
    // reason: a batched entry stays 'waiting' with `batch` set, since the state column's CHECK constraint predates batches (D-26).
    // A member the leader has locked in just before moving main is 'landing' with `batch` set (BR-2172, issue #42).
    if ((own?.state === "waiting" || own?.state === "landing") && own.batch !== null && own.head) {
      // reason: a leader that is no longer landing, whose process is gone, or that stopped beating (a SIGKILL skips
      // its signal handler) frees its members to wait again; nothing else would, so they would wait forever (BR-2173, issue #41).
      const leader = db.db.query<{ state: string; heartbeat: string }, [number]>("SELECT state, heartbeat FROM queue WHERE id = ?").get(own.batch);
      const fresh = iso(new Date(now().getTime() - staleMs));
      if (leader?.state === "landing" && (leader.heartbeat >= fresh || frozen) && !dead.includes(own.batch)) {
        db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(iso(now()), entryId);
        return { mine: false, ahead: 0, batched: { leader: own.batch, head: own.head } };
      }
      db.db.query("UPDATE queue SET state = 'waiting', batch = NULL, head = NULL WHERE id = ? AND state IN ('waiting','landing')").run(entryId);
      own.state = "waiting";
    }
    if (!own || own.state !== "waiting") return { mine: false, ahead: 0, lost: own ? `${own.state}${own.result ? `: ${own.result}` : ""}` : "no such queue entry" };
    for (const e of gone) abandonGone(db, e.id, { pid: e.pid, start: e.pid_start });
    const stale = iso(new Date(now().getTime() - staleMs));
    if (!frozen) db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE state IN ('waiting','landing') AND heartbeat < ? AND id != ?").run(stale, entryId);
    db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(iso(now()), entryId);
    // reason: a landing that is under way is never interrupted, even by an entry ahead of it in order that took its kept place back (BR-2178).
    const me = db.db.query<{ id: number; subject: string | null }, [number]>("SELECT id, subject FROM queue WHERE id = ?").get(entryId)!;
    const others = db.db.query<{ id: number; subject: string | null; state: string }, [number]>("SELECT id, subject, state FROM queue WHERE id != ? AND state IN ('waiting','landing')").all(entryId);
    // reason: priority only reorders who goes next; a landing under way is never interrupted (BR-2232, BR-2178).
    const ahead = others.filter((o) => o.state === "landing" || landsBefore(o, me, priority)).length;
    if (ahead === 0) db.db.query("UPDATE queue SET state = 'landing' WHERE id = ? AND state = 'waiting'").run(entryId);
    return { mine: ahead === 0, ahead };
  });
  return tx.immediate();
}

/**
 * Marks an entry abandoned because the lander probed as gone, only while that lander still owns it: a landing that
 * took the entry back as its kept place meanwhile (BR-2177) is another, live lander (issue #45). False when it did not.
 */
export function abandonGone(db: CoordDb, entryId: number, probed: Proc): boolean {
  return db.db
    .query("UPDATE queue SET state = 'abandoned', result = 'lander process gone' WHERE id = ? AND pid = ? AND pid_start = ? AND state IN ('waiting','landing')")
    .run(entryId, probed.pid, probed.start).changes > 0;
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
  db.db.query("UPDATE queue SET state = ?, result = ?, heartbeat = ?, keep_until = NULL WHERE id = ?").run(state, result, iso(now()), entryId);
  if (state === "landed") endMark(db, entryId);
}

/** A change that landed is no longer marked urgent (BR-2363). */
function endMark(db: CoordDb, entryId: number): void {
  db.db.query("DELETE FROM urgent WHERE change = (SELECT subject FROM queue WHERE id = ?)").run(entryId);
}

/**
 * Marks an entry failed only while it is still waiting or landing; false when it had already finished. With `owner`
 * (the lander that entered it, null when none was recorded), only while that lander still owns it: a later landing
 * may have taken the entry back as its kept place (BR-2177, issue #45).
 */
export function failIfActive(db: CoordDb, entryId: number, result: string, owner?: Proc | null, keepMs = 0): boolean {
  // reason: a member its leader locked in is about to be on main; giving it up now would reopen a change that lands (BR-2172, issue #42).
  const active = "id = ? AND state IN ('waiting','landing') AND NOT (state = 'landing' AND batch IS NOT NULL)";
  const t = now();
  // reason: a lander killed by a signal keeps its place for its own next landing, like a timeout (BR-2368, D-75); the keep time is set in the same statement that fails it.
  const until = keepMs > 0 ? iso(new Date(t.getTime() + keepMs)) : null;
  if (owner === undefined) return db.db.query(`UPDATE queue SET state = 'failed', result = ?, heartbeat = ?, keep_until = ? WHERE ${active}`).run(result, iso(t), until, entryId).changes > 0;
  return db.db.query(`UPDATE queue SET state = 'failed', result = ?, heartbeat = ?, keep_until = ? WHERE ${active} AND pid IS ? AND pid_start IS ?`).run(result, iso(t), until, entryId, owner?.pid ?? null, owner?.start ?? null).changes > 0;
}

/** Until when a failed entry keeps its place, or null (BR-2368). */
export function keptUntil(db: CoordDb, entryId: number): string | null {
  return db.db.query<{ keep_until: string | null }, [number]>("SELECT keep_until FROM queue WHERE id = ?").get(entryId)?.keep_until ?? null;
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
 * The entries behind `leader` in queue order that may join its batch, at most `max`: each still waiting,
 * queued by a canon that knows batches and not marked to land on its own, with a live lander that beat within the stale time. Stops at the first entry
 * that may not, so no entry is tested ahead of an earlier one (BR-2020, BR-2172). An entry that took its kept place
 * back while the leader held the turn is earlier in order than the leader, and comes first (BR-2178).
 */
export function batchCandidates(db: CoordDb, leader: number, max: number, staleMs = QUEUE_STALE_MS, priority: Priority = NO_PRIORITY): BatchCandidate[] {
  const rows = db.db
    .query<{ id: number; worktree: string; subject: string | null; state: string; batch: number | null; solo: number | null; heartbeat: string; pid: number | null; pid_start: string | null }, [number]>(
      "SELECT id, worktree, subject, state, batch, solo, heartbeat, pid, pid_start FROM queue WHERE id != ? AND state IN ('waiting','landing') ORDER BY id",
    )
    .all(leader)
    // reason: members are taken in landing order, priorities included, so none is tested ahead of one that lands before it (BR-2232).
    .sort((a, b) => (landsBefore(a, b, priority) ? -1 : landsBefore(b, a, priority) ? 1 : 0));
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

/**
 * Sends a batched entry back to waiting at its place in the queue; it may join a later batch (BR-2173). False when
 * it had left meanwhile.
 */
export function leaveBatch(db: CoordDb, entryId: number): boolean {
  return db.db.query("UPDATE queue SET batch = NULL, head = NULL WHERE id = ? AND state = 'waiting' AND batch IS NOT NULL").run(entryId).changes > 0;
}

/** The batch refusal a leader left on this entry, if any (BR-2173): the message its own lander reports. */
export function batchRefusal(db: CoordDb, entryId: number): string | undefined {
  const r = db.db.query<{ state: string; result: string | null }, [number]>("SELECT state, result FROM queue WHERE id = ?").get(entryId);
  return r?.state === "failed" && r.result?.startsWith(REFUSED_IN_BATCH) ? r.result.slice(REFUSED_IN_BATCH.length) : undefined;
}

/**
 * Refuses a member of `leader`'s batch whose addition made the floor fail (BR-2173); its own lander reads the message
 * back on its next try for the turn. False when it had left the batch meanwhile.
 */
export function refuseInBatch(db: CoordDb, leader: number, entryId: number, message: string): boolean {
  return db.db.query("UPDATE queue SET state = 'failed', result = ? WHERE id = ? AND state = 'waiting' AND batch = ?").run(`${REFUSED_IN_BATCH}${message}`, entryId, leader).changes > 0;
}

/** Whether an entry is still in a batch (not killed or abandoned meanwhile). */
export function inBatch(db: CoordDb, entryId: number, leader: number): boolean {
  const r = db.db.query<{ state: string; batch: number | null }, [number]>("SELECT state, batch FROM queue WHERE id = ?").get(entryId);
  return r?.state === "waiting" && r.batch === leader;
}

/**
 * Locks the members in just before the leader moves main, all or none, in one transaction: each must still be
 * waiting in this batch. A locked member's own signal handler no longer gives its entry up (BR-2172, issue #42).
 */
export function lockBatch(db: CoordDb, leader: number, members: readonly number[]): boolean {
  const tx = db.db.transaction((): boolean => {
    for (const id of members) if (!inBatch(db, id, leader)) return false;
    for (const id of members) db.db.query("UPDATE queue SET state = 'landing' WHERE id = ? AND state = 'waiting' AND batch = ?").run(id, leader);
    return true;
  });
  return tx.immediate();
}

/** Sends locked members back to waiting when main did not move after all (BR-2172). */
export function unlockBatch(db: CoordDb, leader: number, members: readonly number[]): void {
  for (const id of members) db.db.query("UPDATE queue SET state = 'waiting', batch = NULL, head = NULL WHERE id = ? AND state = 'landing' AND batch = ?").run(id, leader);
}

/**
 * Where a member stands that its leader has locked in (BR-2172), for its signal handler (BR-2099, issue #43):
 * "locked" while the leader is still landing, alive and beating, so main may still move with it, and its heartbeat is
 * renewed so no other lander takes it for silent; otherwise a still locked entry is sent back to waiting, as tryTurn
 * does (BR-2173), and "settled" says the batch has an outcome: the entry is landed, waiting again, or finished.
 */
export function settleLocked(db: CoordDb, entryId: number, staleMs = QUEUE_STALE_MS): "locked" | "settled" {
  const row = db.db.query<{ state: string; batch: number | null }, [number]>("SELECT state, batch FROM queue WHERE id = ?").get(entryId);
  if (row?.state !== "landing" || row.batch === null) return "settled";
  const leader = db.db.query<{ state: string; heartbeat: string; pid: number | null; pid_start: string | null }, [number]>("SELECT state, heartbeat, pid, pid_start FROM queue WHERE id = ?").get(row.batch);
  // reason: the process probe runs before the transaction, so it never holds the write lock (as in tryTurn). A leader
  // with no process recorded is judged by its heartbeat alone, as tryTurn does: it may be alive and moving main (issue #96).
  const gone = !leader || (leader.pid !== null && leader.pid_start !== null && isGone({ pid: leader.pid, start: leader.pid_start }) === true);
  const fresh = iso(new Date(now().getTime() - staleMs));
  return db.db
    .transaction((): "locked" | "settled" => {
      const held = db.db.query<{ state: string; heartbeat: string }, [number]>("SELECT state, heartbeat FROM queue WHERE id = ?").get(row.batch!);
      if (!gone && held?.state === "landing" && held.heartbeat >= fresh) {
        if (db.db.query("UPDATE queue SET heartbeat = ? WHERE id = ? AND state = 'landing' AND batch = ?").run(iso(now()), entryId, row.batch).changes > 0) return "locked";
        return "settled";
      }
      db.db.query("UPDATE queue SET state = 'waiting', batch = NULL, head = NULL WHERE id = ? AND state = 'landing' AND batch = ?").run(entryId, row.batch);
      return "settled";
    })
    .immediate();
}

/** Records a locked member as landed at `sha`, its own commit on main; false when it had left the batch. */
export function landBatched(db: CoordDb, entryId: number, sha: string): boolean {
  const landed = db.db.query("UPDATE queue SET state = 'landed', result = ?, heartbeat = ? WHERE id = ? AND state = 'landing' AND batch IS NOT NULL").run(sha, iso(now()), entryId).changes > 0;
  if (landed) endMark(db, entryId);
  return landed;
}

