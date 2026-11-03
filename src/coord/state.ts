import { err, ok, type Result } from "../kernel/result.ts";
import type { CoordDb } from "./db.ts";
import { isGone, type Proc } from "./liveness.ts";

/**
 * Live coordination operations (design §2). Each is one transaction on the shared DB, so two sessions
 * racing for the same claim or queue slot see a consistent answer (P4).
 */
/** Defaults; projects set their own in canon/config.yaml (`claim_lease_hours`, `lander_stale_minutes`). */
export const CLAIM_LEASE_MS = 12 * 60 * 60 * 1000;
export const QUEUE_STALE_MS = 10 * 60 * 1000;

const now = () => new Date();
const iso = (d: Date) => d.toISOString();

export interface Claim {
  readonly subject: string;
  readonly holder: string; // worktree path
  readonly actor: string;
  readonly expires_at: string;
}

/**
 * Takes or refreshes the claim on a change. The holder is the worktree: one change, one worktree, one actor.
 * Refused while another worktree or another actor holds a live lease (BR-2011): every session starting a change
 * gets the same worktree path, so the path alone never tells two sessions apart. An expired lease can be taken over.
 */
export function takeClaim(db: CoordDb, subject: string, holder: string, actor: string, leaseMs = CLAIM_LEASE_MS, owner?: Proc): Result<Claim> {
  const tx = db.db.transaction((): Result<Claim> => {
    const cur = db.db
      .query<{ holder: string; expires_at: string; worktree: string | null; pid: number | null; pid_start: string | null }, [string]>("SELECT holder, expires_at, worktree, pid, pid_start FROM claims WHERE subject = ?")
      .get(subject);
    const other = cur !== null && (cur.worktree !== holder || cur.holder !== actor);
    const binds = other && bindsStill(cur);
    // A lease that has not expired but whose session process is gone frees at once (BR-2100).
    const gone = other && !binds && new Date(cur.expires_at) > now();
    if (binds) {
      db.event(actor, "claim.refuse", subject, { reason: "held", by: cur.worktree, actor: cur.holder, until: cur.expires_at });
      return err(
        "conflict",
        `${subject} is claimed by ${cur.holder} in ${cur.worktree} until ${cur.expires_at}; it frees when that session runs \`canon work stop --release\` there or the lease expires`,
      );
    }
    const expires = iso(new Date(now().getTime() + leaseMs));
    db.db
      .query(
        "INSERT INTO claims(subject, holder, worktree, expires_at, pid, pid_start) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET holder = excluded.holder, worktree = excluded.worktree, expires_at = excluded.expires_at, pid = excluded.pid, pid_start = excluded.pid_start, version = version + 1",
      )
      .run(subject, actor, holder, expires, owner?.pid ?? null, owner?.start ?? null);
    db.event(actor, cur && !other ? "claim.renew" : "claim.take", subject, { worktree: holder, ...(gone ? { from: cur.holder, reason: "holder-process-gone" } : {}) });
    return ok({ subject, holder, actor, expires_at: expires });
  });
  return tx.immediate();
}

/**
 * Extends the lease of the claim this worktree holds (BR-2011): every work command in the worktree renews it,
 * so a session working longer than one lease is never taken over. Returns the claim, or undefined when the
 * worktree holds none (it may have been taken over after expiring).
 *
 * Only the holder renews (BR-2104): another actor running a work command in the worktree is refused while the
 * claim still binds, and takes it over once it no longer does (lease expired or session process gone, BR-2100).
 */
export function renewClaim(db: CoordDb, worktree: string, actor: string, leaseMs = CLAIM_LEASE_MS, owner?: Proc): Result<Claim | undefined> {
  const tx = db.db.transaction((): Result<Claim | undefined> => {
    const cur = db.db
      .query<{ subject: string; holder: string; expires_at: string; pid: number | null; pid_start: string | null }, [string]>("SELECT subject, holder, expires_at, pid, pid_start FROM claims WHERE worktree = ?")
      .get(worktree);
    if (!cur) return ok(undefined);
    if (cur.holder !== actor && bindsStill(cur)) {
      db.event(actor, "claim.refuse", cur.subject, { reason: "held", by: worktree, actor: cur.holder, until: cur.expires_at });
      return err("conflict", `${cur.subject} in ${worktree} is claimed by ${cur.holder} until ${cur.expires_at}; only that session can renew, stop, release or land it`);
    }
    const expires = iso(new Date(now().getTime() + leaseMs));
    // The holder's own session may run under a new process now (a resumed session): follow it, so the claim is not freed under it.
    db.db
      .query("UPDATE claims SET holder = ?, expires_at = ?, pid = ?, pid_start = ?, version = version + 1 WHERE subject = ?")
      .run(actor, expires, owner?.pid ?? (cur.holder === actor ? cur.pid : null), owner?.start ?? (cur.holder === actor ? cur.pid_start : null), cur.subject);
    db.event(actor, cur.holder === actor ? "claim.renew" : "claim.take", cur.subject, { worktree, ...(cur.holder === actor ? {} : { from: cur.holder }) });
    return ok({ subject: cur.subject, holder: worktree, actor, expires_at: expires });
  });
  return tx.immediate();
}

interface ClaimRow {
  readonly subject: string;
  readonly holder: string;
  readonly worktree: string | null;
  readonly expires_at: string;
  readonly pid: number | null;
  readonly pid_start: string | null;
}

/**
 * Holds a change for a moment while `canon work clean` or `canon work drop` removes its worktree, so a
 * `canon work start` that arrives meanwhile is refused instead of getting a worktree that is about to vanish
 * (BR-2019, BR-2064). `onlyIfUnclaimed` (clean) fails on any claim row; otherwise (drop) it fails only on a
 * claim of another actor that still binds (BR-2100) and takes over any other. Returns the row it replaced, so
 * a caller that gives up can put it back. Writes no claim events: it is not work, and `canon stats` counts
 * claim events (BR-2067).
 */
export function holdClaim(db: CoordDb, subject: string, worktree: string, actor: string, onlyIfUnclaimed: boolean, leaseMs = CLAIM_LEASE_MS): Result<{ prior: ClaimRow | null }> {
  const read = () => db.db.query<ClaimRow, [string]>("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims WHERE subject = ?").get(subject) ?? null;
  // reason: the process probe runs outside the write transaction (as in tryTurn); the transaction re-reads and
  // only proceeds when the row is still the one probed.
  const seen = read();
  const binds = seen !== null && seen.holder !== actor && bindsStill(seen);
  const tx = db.db.transaction((): Result<{ prior: ClaimRow | null }> => {
    const cur = read();
    const same = JSON.stringify(cur) === JSON.stringify(seen);
    if (cur && (onlyIfUnclaimed || !same || binds)) {
      return err("conflict", `${subject} is claimed by ${cur.holder} in ${cur.worktree} until ${cur.expires_at}; nothing was deleted`);
    }
    db.db
      .query("INSERT INTO claims(subject, holder, worktree, expires_at, pid, pid_start) VALUES (?, ?, ?, ?, NULL, NULL) ON CONFLICT(subject) DO UPDATE SET holder = excluded.holder, worktree = excluded.worktree, expires_at = excluded.expires_at, pid = NULL, pid_start = NULL, version = version + 1")
      .run(subject, actor, worktree, iso(new Date(now().getTime() + leaseMs)));
    return ok({ prior: cur });
  });
  return tx.immediate();
}

/** Ends a hold made by holdClaim, and only that one, putting back the row it replaced. */
export function unholdClaim(db: CoordDb, subject: string, worktree: string, actor: string, prior: ClaimRow | null): void {
  const tx = db.db.transaction(() => {
    const gone = db.db.query("DELETE FROM claims WHERE subject = ? AND worktree = ? AND holder = ?").run(subject, worktree, actor).changes > 0;
    if (gone && prior) {
      db.db.query("INSERT INTO claims(subject, holder, worktree, expires_at, pid, pid_start) VALUES (?, ?, ?, ?, ?, ?)").run(prior.subject, prior.holder, prior.worktree, prior.expires_at, prior.pid, prior.pid_start);
    }
  });
  tx.immediate();
}

export function releaseClaim(db: CoordDb, subject: string, actor: string): void {
  db.db.query("DELETE FROM claims WHERE subject = ?").run(subject);
  db.event(actor, "claim.release", subject, {});
}

export function claims(db: CoordDb): Claim[] {
  return db.db
    .query<{ subject: string; holder: string; worktree: string; expires_at: string }, []>("SELECT subject, holder, worktree, expires_at FROM claims ORDER BY subject")
    .all()
    .map((r) => ({ subject: r.subject, holder: r.worktree, actor: r.holder, expires_at: r.expires_at }));
}

/**
 * The claim on a change while it still binds: its lease has not expired and its session process is not provably
 * gone (BR-2011, BR-2100). Undefined when there is no claim or it no longer binds anyone.
 */
export function liveClaim(db: CoordDb, subject: string): Claim | undefined {
  const r = db.db
    .query<{ subject: string; holder: string; worktree: string; expires_at: string; pid: number | null; pid_start: string | null }, [string]>("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims WHERE subject = ?")
    .get(subject);
  if (!r || !bindsStill(r)) return undefined;
  return { subject: r.subject, holder: r.worktree, actor: r.holder, expires_at: r.expires_at };
}

function bindsStill(r: { expires_at: string; pid: number | null; pid_start: string | null }): boolean {
  if (new Date(r.expires_at) <= now()) return false;
  // An unreadable process table keeps the lease (D-11).
  return !(r.pid !== null && r.pid_start !== null && isGone({ pid: r.pid, start: r.pid_start }) === true);
}

export function claimOfWorktree(db: CoordDb, worktree: string): Claim | undefined {
  return claims(db).find((c) => c.holder === worktree);
}

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

// ---- questions reserved for a human (P7) ----

export interface Question {
  readonly id: number;
  readonly subject: string | null;
  readonly asked_by: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string | null;
  readonly answered_by: string | null;
  /** The human's own words when an agent relayed the answer (BR-2021); null for a direct answer. */
  readonly relayed: string | null;
  readonly asked_at: string;
}

export function ask(db: CoordDb, actor: string, subject: string | null, question: string, options: readonly string[]): number {
  const r = db.db.query("INSERT INTO questions(subject, asked_by, question, options, asked_at) VALUES (?, ?, ?, ?, ?)").run(subject, actor, question, JSON.stringify(options), iso(now()));
  db.event(actor, "human.ask", subject, { question });
  return Number(r.lastInsertRowid);
}

export function questions(db: CoordDb, which: "pending" | "all"): Question[] {
  const rows = db.db
    .query<Omit<Question, "options"> & { options: string }, []>(`SELECT id, subject, asked_by, question, options, answer, answered_by, relayed, asked_at FROM questions ${which === "pending" ? "WHERE answer IS NULL" : ""} ORDER BY id`)
    .all();
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options) as string[] }));
}

/**
 * Records the answer to a question reserved for a human (BR-2021, D-6). A `human:` actor answers directly.
 * An agent may record an answer only as a relay of what the human said in its session, with the human's own
 * words: canon cannot tell a relay from an invention (an agent can also fake its identity through the
 * environment), so it does not pretend to prevent one; it records which kind of answer this is, so the record
 * never says "the human answered" when an agent wrote it.
 *
 * The write is atomic: two answers racing for one question cannot both succeed (BR-2040).
 */
export function answer(db: CoordDb, id: number, text: string, by: string, relayed?: string): Result<void> {
  const quote = relayed?.trim();
  if (!by.startsWith("human:") && !quote) {
    db.event(by, "human.answer.refuse", String(id), { reason: "not-human-no-relay" });
    return err("invalid", `${by} is not a human; an agent records a human's answer only with --relayed "<the human's own words>" (BR-2021)`);
  }
  if (by.startsWith("human:") && quote) return err("invalid", "--relayed is for an agent passing on a human's answer; a human answers directly");
  const tx = db.db.transaction((): Result<void> => {
    const q = db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(id);
    if (!q) return err("not_found", `no question #${id}`);
    const r = db.db.query("UPDATE questions SET answer = ?, answered_by = ?, relayed = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(text, by, quote ?? null, iso(now()), id);
    if (r.changes === 0) return err("conflict", `question #${id} is already answered`);
    db.event(by, "human.answer", String(id), { answer: text, ...(quote ? { relayed: quote } : {}) });
    return ok(undefined);
  });
  return tx.immediate();
}

/** Who answered, in words: the human, or an agent relaying the human's own words. */
export function answeredBy(q: Pick<Question, "answered_by" | "relayed">): string {
  return q.relayed ? `${q.answered_by} relaying the human: "${q.relayed}"` : (q.answered_by ?? "");
}
