import { err, ok, type Result } from "../kernel/result.ts";
import type { CoordDb } from "./db.ts";

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
 * Takes or refreshes the claim on a change. The holder is the worktree: one change, one worktree.
 * Refused while another worktree holds a live lease; an expired lease can be taken over.
 */
export function takeClaim(db: CoordDb, subject: string, holder: string, actor: string, leaseMs = CLAIM_LEASE_MS): Result<Claim> {
  const tx = db.db.transaction((): Result<Claim> => {
    const cur = db.db.query<{ holder: string; expires_at: string; worktree: string | null }, [string]>("SELECT holder, expires_at, worktree FROM claims WHERE subject = ?").get(subject);
    if (cur && cur.worktree !== holder && new Date(cur.expires_at) > now()) {
      db.event(actor, "claim.refuse", subject, { reason: "held", by: cur.worktree, until: cur.expires_at });
      return err("conflict", `${subject} is claimed by ${cur.holder} in ${cur.worktree} until ${cur.expires_at}`);
    }
    const expires = iso(new Date(now().getTime() + leaseMs));
    db.db
      .query("INSERT INTO claims(subject, holder, worktree, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET holder = excluded.holder, worktree = excluded.worktree, expires_at = excluded.expires_at, version = version + 1")
      .run(subject, actor, holder, expires);
    db.event(actor, cur ? "claim.renew" : "claim.take", subject, { worktree: holder });
    return ok({ subject, holder, actor, expires_at: expires });
  });
  return tx.immediate();
}

/**
 * Extends the lease of the claim this worktree holds (BR-2011): every work command in the worktree renews it,
 * so a session working longer than one lease is never taken over. Returns the claim, or undefined when the
 * worktree holds none (it may have been taken over after expiring).
 */
export function renewClaim(db: CoordDb, worktree: string, actor: string, leaseMs = CLAIM_LEASE_MS): Claim | undefined {
  const tx = db.db.transaction((): Claim | undefined => {
    const cur = claimOfWorktree(db, worktree);
    if (!cur) return undefined;
    const expires = iso(new Date(now().getTime() + leaseMs));
    db.db.query("UPDATE claims SET expires_at = ?, version = version + 1 WHERE subject = ? AND worktree = ?").run(expires, cur.subject, worktree);
    return { ...cur, expires_at: expires };
  });
  return tx.immediate();
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

export function enqueue(db: CoordDb, worktree: string, subject: string | null, actor: string): number {
  const t = iso(now());
  const r = db.db.query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat) VALUES (?, ?, 'waiting', ?, ?)").run(worktree, subject, t, t);
  db.event(actor, "queue.enter", subject, { worktree });
  return Number(r.lastInsertRowid);
}

/** Becomes the lander if every earlier entry is finished or stale. Returns the entries still ahead otherwise. */
export function tryTurn(db: CoordDb, entryId: number, staleMs = QUEUE_STALE_MS): { readonly mine: boolean; readonly ahead: number } {
  const tx = db.db.transaction(() => {
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
  readonly asked_at: string;
}

export function ask(db: CoordDb, actor: string, subject: string | null, question: string, options: readonly string[]): number {
  const r = db.db.query("INSERT INTO questions(subject, asked_by, question, options, asked_at) VALUES (?, ?, ?, ?, ?)").run(subject, actor, question, JSON.stringify(options), iso(now()));
  db.event(actor, "human.ask", subject, { question });
  return Number(r.lastInsertRowid);
}

export function questions(db: CoordDb, which: "pending" | "all"): Question[] {
  const rows = db.db
    .query<Omit<Question, "options"> & { options: string }, []>(`SELECT id, subject, asked_by, question, options, answer, answered_by, asked_at FROM questions ${which === "pending" ? "WHERE answer IS NULL" : ""} ORDER BY id`)
    .all();
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options) as string[] }));
}

/**
 * Records a human's answer. Only a `human:` actor may answer (BR-2021): a terminal alone proves nothing, since
 * an agent can open a pseudo-terminal; BR-2023 guarantees an agent session is never recorded as human.
 */
export function answer(db: CoordDb, id: number, text: string, by: string): Result<void> {
  if (!by.startsWith("human:")) {
    db.event(by, "human.answer.refuse", String(id), { reason: "not-human" });
    return err("invalid", `only a human answers questions; ${by} is not a human actor (BR-2021)`);
  }
  const q = db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(id);
  if (!q) return err("not_found", `no question #${id}`);
  if (q.answer !== null) return err("conflict", `question #${id} is already answered`);
  db.db.query("UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(text, by, iso(now()), id);
  db.event(by, "human.answer", String(id), { answer: text });
  return ok(undefined);
}
