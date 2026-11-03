import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../db.ts";
import { isGone, selfProcess, type Proc } from "./liveness.ts";

/**
 * Live coordination operations (design §2). Each is one transaction on the shared DB, so two sessions
 * racing for the same claim or queue slot see a consistent answer (P4).
 */
/** Default; projects set their own in canon/config.yaml (`claim_lease_hours`). */
export const CLAIM_LEASE_MS = 12 * 60 * 60 * 1000;

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
    // reason: a live claim refuses every start, the same actor included: Claude Code gives a session's
    // subagents one session id and one process, so the actor cannot tell two of them apart; the worktree is
    // what keeps them apart, so the same actor is not invited in either (BR-2011, D-18).
    const binds = cur !== null && bindsStill(cur);
    // A lease that has not expired but whose session process is gone frees at once (BR-2100).
    const gone = cur !== null && !binds && new Date(cur.expires_at) > now();
    if (binds) {
      db.event(actor, "claim.refuse", subject, { reason: "held", by: cur.worktree, actor: cur.holder, until: cur.expires_at });
      const own =
        cur.holder === actor ? `; it is in progress in that worktree: if you did not start it in this conversation, pick another change (whoever started it continues there)` : "";
      return err(
        "conflict",
        `${subject} is claimed by ${cur.holder} in ${cur.worktree} until ${cur.expires_at}${own}; it frees when the holder runs \`canon work stop --release\` there or the lease expires`,
      );
    }
    const expires = iso(new Date(now().getTime() + leaseMs));
    db.db
      .query(
        "INSERT INTO claims(subject, holder, worktree, expires_at, pid, pid_start) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET holder = excluded.holder, worktree = excluded.worktree, expires_at = excluded.expires_at, pid = excluded.pid, pid_start = excluded.pid_start, version = version + 1",
      )
      .run(subject, actor, holder, expires, owner?.pid ?? null, owner?.start ?? null);
    db.event(actor, "claim.take", subject, { worktree: holder, ...(gone ? { from: cur.holder, reason: "holder-process-gone" } : {}) });
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
export function holdClaim(db: CoordDb, subject: string, worktree: string, actor: string, onlyIfUnclaimed: boolean, leaseMs = CLAIM_LEASE_MS): Result<Hold> {
  const read = () => db.db.query<ClaimRow, [string]>("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims WHERE subject = ?").get(subject) ?? null;
  // reason: the process probe runs outside the write transaction (as in tryTurn); the transaction re-reads and
  // only proceeds when the row is still the one probed.
  const seen = read();
  // reason: any live claim or hold binds, the same actor included: subagents of one session share the actor,
  // so a drop must not archive away a sibling's worktree while it works there (BR-2064, issue #18).
  const binds = seen !== null && bindsStill(seen);
  const self = selfProcess();
  const mark = holdMark(worktree);
  const tx = db.db.transaction((): Result<Hold> => {
    const cur = read();
    const same = JSON.stringify(cur) === JSON.stringify(seen);
    if (cur && (onlyIfUnclaimed || !same || binds)) {
      return err("conflict", `${subject} is claimed by ${cur.holder} in ${cur.worktree} until ${cur.expires_at}; nothing was deleted (the holder frees it with \`canon work stop --release\` in that worktree)`);
    }
    // The hold names this process, so it frees as soon as a killed clean or drop is gone (BR-2100, issue #16).
    db.db
      .query("INSERT INTO claims(subject, holder, worktree, expires_at, pid, pid_start) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET holder = excluded.holder, worktree = excluded.worktree, expires_at = excluded.expires_at, pid = excluded.pid, pid_start = excluded.pid_start, version = version + 1")
      .run(subject, actor, mark, iso(new Date(now().getTime() + leaseMs)), self?.pid ?? null, self?.start ?? null);
    return ok({ subject, mark, prior: cur });
  });
  return tx.immediate();
}

/** A hold taken by holdClaim: what unholdClaim needs to remove exactly this one. */
export interface Hold {
  readonly subject: string;
  /** The worktree column of the hold row: `hold:<path>#<id>`, unique to this hold. */
  readonly mark: string;
  readonly prior: ClaimRow | null;
}

/**
 * The worktree a hold records: never a real worktree path, so `takeClaim` from the same actor and the same
 * path sees someone else's claim instead of its own to renew (issue #15); unique per hold, so ending one hold
 * never removes another command's hold or a real claim (issue #18).
 */
function holdMark(worktree: string): string {
  return `hold:${worktree}#${crypto.randomUUID()}`;
}

function isHold(worktree: string | null): boolean {
  return worktree?.startsWith("hold:") === true;
}

/** Ends a hold made by holdClaim, and only that one, putting back the row it replaced. */
export function unholdClaim(db: CoordDb, hold: Hold): void {
  const tx = db.db.transaction(() => {
    const gone = db.db.query("DELETE FROM claims WHERE subject = ? AND worktree = ?").run(hold.subject, hold.mark).changes > 0;
    const p = hold.prior;
    if (gone && p) db.db.query("INSERT INTO claims(subject, holder, worktree, expires_at, pid, pid_start) VALUES (?, ?, ?, ?, ?, ?)").run(p.subject, p.holder, p.worktree, p.expires_at, p.pid, p.pid_start);
  });
  tx.immediate();
}

/**
 * Extends the lease only while this actor still holds the claim in this worktree: a landing keeps its claim alive
 * while it waits and runs, without ever touching a claim another session has taken over since (BR-2108).
 */
export function keepClaim(db: CoordDb, worktree: string, actor: string, leaseMs = CLAIM_LEASE_MS): void {
  db.db.query("UPDATE claims SET expires_at = ?, version = version + 1 WHERE worktree = ? AND holder = ?").run(iso(new Date(now().getTime() + leaseMs)), worktree, actor);
}

/** Releases the claim only if this actor still holds it in this worktree; false when someone else holds it now (BR-2108). */
export function releaseOwnClaim(db: CoordDb, subject: string, worktree: string, actor: string): boolean {
  const gone = db.db.query("DELETE FROM claims WHERE subject = ? AND worktree = ? AND holder = ?").run(subject, worktree, actor).changes > 0;
  if (gone) db.event(actor, "claim.release", subject, {});
  return gone;
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
