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
      const sub = subagentOf(actor, cur.holder);
      const own =
        sub !== undefined
          ? `; it is held by your subagent ${sub}: if that subagent has finished, run \`canon work take ${subject} --from ${sub}\`, otherwise pick another change`
          : cur.holder === actor
            ? `; it is in progress in that worktree: if you did not start it in this conversation, pick another change (whoever started it continues there)`
            : "";
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
      const sub = subagentOf(actor, cur.holder);
      const who = sub !== undefined ? `, a subagent of this session: do not work in this worktree unless you are that subagent; if it has finished, run \`canon work take ${cur.subject} --from ${sub}\`` : "";
      return err("conflict", `${cur.subject} in ${worktree} is claimed by ${cur.holder} until ${cur.expires_at}; only that holder can renew, stop, release or land it${who}`);
    }
    const expires = iso(new Date(now().getTime() + leaseMs));
    // reason: while a landing of this worktree is in the queue, the claim names that lander, and the holder's own
    // work commands (a `canon work stop` while it waits) leave it so, or the session exiting would free it (BR-2142, issue #30).
    // A lander killed by SIGKILL leaves its queue row active: a gone lander is no landing (issue #31).
    const landing =
      cur.holder === actor &&
      cur.pid !== null &&
      cur.pid_start !== null &&
      db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state IN ('waiting','landing') AND pid = ? AND pid_start = ?").get(worktree, cur.pid, cur.pid_start) !== null &&
      isGone({ pid: cur.pid, start: cur.pid_start }) !== true;
    // The holder's own session may run under a new process now (a resumed session): follow it, so the claim is not freed under it.
    const own = cur.holder === actor;
    const pid = landing ? cur.pid : (owner?.pid ?? (own ? cur.pid : null));
    const pidStart = landing ? cur.pid_start : (owner?.start ?? (own ? cur.pid_start : null));
    db.db.query("UPDATE claims SET holder = ?, expires_at = ?, pid = ?, pid_start = ?, version = version + 1 WHERE subject = ?").run(actor, expires, pid, pidStart, cur.subject);
    db.event(actor, cur.holder === actor ? "claim.renew" : "claim.take", cur.subject, { worktree, ...(cur.holder === actor ? {} : { from: cur.holder }) });
    return ok({ subject: cur.subject, holder: worktree, actor, expires_at: expires });
  });
  return tx.immediate();
}

/**
 * The agent id of a subagent of this session that holds a claim: the holder is `<actor>:<id>` while the actor is a
 * session-level `agent:<session>` (BR-2023, D-62). Undefined for any other pair.
 */
function subagentOf(actor: string, holder: string): string | undefined {
  return /^agent:[^:]+$/.test(actor) && holder.startsWith(`${actor}:`) ? holder.slice(actor.length + 1) : undefined;
}

/**
 * The main session takes back the claim a subagent of the same session holds (`canon work take`, BR-2336): the holder
 * becomes the session-level actor and the lease starts again. It does not know whether the subagent has finished (the
 * subagent and the main session share one process, so the process probe cannot tell, D-11, D-62); a subagent that
 * still runs finds its next `land` or `stop` refused, loudly (BR-2104).
 */
export function handOverClaim(db: CoordDb, subject: string, actor: string, from: string, leaseMs = CLAIM_LEASE_MS, owner?: Proc): Result<Claim> {
  const tx = db.db.transaction((): Result<Claim> => {
    const cur = db.db.query<{ holder: string; worktree: string | null }, [string]>("SELECT holder, worktree FROM claims WHERE subject = ?").get(subject);
    const refuse = (message: string, extra: Record<string, unknown> = {}): Result<Claim> => {
      db.event(actor, "claim.refuse", subject, { reason: "handover", from, actor: cur?.holder ?? null, ...extra });
      return err("conflict", message);
    };
    if (!cur) return refuse(`${subject} has no claim; there is nothing to take over`);
    if (subagentOf(actor, cur.holder) !== from) return refuse(`${subject} is claimed by ${cur.holder}, not by a subagent ${from} of this session (${actor}); only a subagent of this session can be taken over; nothing changed`);
    if (isHold(cur.worktree)) return refuse(`${subject}'s worktree is being deleted by \`canon work clean\` or \`canon work drop\` right now; nothing changed`);
    const expires = iso(new Date(now().getTime() + leaseMs));
    db.db.query("UPDATE claims SET holder = ?, expires_at = ?, pid = ?, pid_start = ?, version = version + 1 WHERE subject = ?").run(actor, expires, owner?.pid ?? null, owner?.start ?? null, subject);
    db.event(actor, "claim.handover", subject, { from, by: "main-session", worktree: cur.worktree });
    return ok({ subject, holder: cur.worktree ?? "", actor, expires_at: expires });
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
 * (BR-2019, BR-2064). It fails on a claim that still binds (BR-2100), the same actor's included, and on a row
 * that changed since it was probed; it takes over any other. Clean and drop judge a claim exactly as start does
 * (`liveClaim`). Returns the row it replaced, so a caller that gives up can put it back. Writes no claim events:
 * it is not work, and `canon stats` counts claim events (BR-2067).
 */
export function holdClaim(db: CoordDb, subject: string, worktree: string, actor: string, leaseMs = CLAIM_LEASE_MS): Result<Hold> {
  const read = () => db.db.query<ClaimRow, [string]>("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims WHERE subject = ?").get(subject) ?? null;
  // reason: the process probe runs outside the write transaction (as in tryTurn); the transaction re-reads and
  // only proceeds when the row is still the one probed.
  const seen = read();
  // reason: any live claim or hold binds, the same actor included: subagents of one session share the actor,
  // so a clean or drop must not delete a sibling's worktree while it works there (BR-2019, BR-2064, issue #18).
  const binds = seen !== null && bindsStill(seen);
  const self = selfProcess();
  const mark = holdMark(worktree);
  const tx = db.db.transaction((): Result<Hold> => {
    const cur = read();
    const same = JSON.stringify(cur) === JSON.stringify(seen);
    if (cur && (!same || binds)) {
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

/** The session process a claim named before a landing bound it to the lander; what `unbindFromLander` puts back. */
export interface LanderBinding {
  readonly worktree: string;
  readonly actor: string;
  readonly lander: Proc;
  readonly prior: { readonly pid: number; readonly pid_start: string };
}

/**
 * While a landing runs, the claim this actor holds in this worktree names the lander's own process instead of
 * the session's, so a session that exits mid-landing does not free the claim to another session (BR-2142).
 * Only a claim that names a process is bound: a lease-only claim never frees on a process's exit anyway.
 * Undefined when nothing was bound.
 */
export function bindToLander(db: CoordDb, worktree: string, actor: string, lander: Proc): LanderBinding | undefined {
  const tx = db.db.transaction((): LanderBinding | undefined => {
    const cur = db.db.query<{ pid: number | null; pid_start: string | null }, [string, string]>("SELECT pid, pid_start FROM claims WHERE worktree = ? AND holder = ?").get(worktree, actor);
    if (!cur || cur.pid === null || cur.pid_start === null) return undefined;
    db.db.query("UPDATE claims SET pid = ?, pid_start = ?, version = version + 1 WHERE worktree = ? AND holder = ?").run(lander.pid, lander.start, worktree, actor);
    return { worktree, actor, lander, prior: { pid: cur.pid, pid_start: cur.pid_start } };
  });
  return tx.immediate();
}

/**
 * Ends a landing's binding: the claim names the session process again, if it still names this lander. A session
 * that exited meanwhile thus frees the claim the moment the landing ends (BR-2100, BR-2142); a holder that renewed
 * under a new session process during the landing keeps that one.
 */
export function unbindFromLander(db: CoordDb, b: LanderBinding): void {
  db.db
    .query("UPDATE claims SET pid = ?, pid_start = ?, version = version + 1 WHERE worktree = ? AND holder = ? AND pid = ? AND pid_start = ?")
    .run(b.prior.pid, b.prior.pid_start, b.worktree, b.actor, b.lander.pid, b.lander.start);
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
 * Whether a claim still binds (BR-2011, BR-2100): `live`, or why not: its lease ended (`expired`) or the session
 * process it names is provably gone (`holder-gone`). The one judgement start, clean, drop, brief and status share.
 */
export type ClaimState = "live" | "expired" | "holder-gone";

export interface ClaimWithState extends Claim {
  readonly state: ClaimState;
}

/** Every claim row with its state, as `canon work status` lists them (BR-2192). */
export function claimsWithState(db: CoordDb): ClaimWithState[] {
  return db.db
    .query<ClaimRow, []>("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims ORDER BY subject")
    .all()
    .map((r) => ({ subject: r.subject, holder: r.worktree ?? "", actor: r.holder, expires_at: r.expires_at, state: stateOf(r) }));
}

/** The claims that still bind anyone; an expired or abandoned row is not one (BR-2100). */
export function liveClaims(db: CoordDb): Claim[] {
  return claimsWithState(db)
    .filter((c) => c.state === "live")
    .map(({ state: _state, ...c }) => c);
}

/**
 * The claim on a change while it still binds: its lease has not expired and its session process is not provably
 * gone (BR-2011, BR-2100). Undefined when there is no claim or it no longer binds anyone.
 */
export function liveClaim(db: CoordDb, subject: string): Claim | undefined {
  const r = db.db.query<ClaimRow, [string]>("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims WHERE subject = ?").get(subject);
  if (!r || !bindsStill(r)) return undefined;
  return { subject: r.subject, holder: r.worktree ?? "", actor: r.holder, expires_at: r.expires_at };
}

/**
 * The change whose worktree a `canon work clean` or `canon work drop` is removing right now: a hold on it that
 * still binds (BR-2025). Undefined when none is; a hold whose clean or drop was killed no longer binds (BR-2100).
 */
export function deletionOf(db: CoordDb, worktree: string): { subject: string } | undefined {
  const prefix = `hold:${worktree}#`;
  const rows = db.db
    .query<ClaimRow, [number, string]>("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims WHERE substr(worktree, 1, ?) = ?")
    .all(prefix.length, prefix);
  const r = rows.find((x) => bindsStill(x));
  return r ? { subject: r.subject } : undefined;
}

function stateOf(r: { expires_at: string; pid: number | null; pid_start: string | null }): ClaimState {
  if (new Date(r.expires_at) <= now()) return "expired";
  // An unreadable process table keeps the lease (D-11).
  return r.pid !== null && r.pid_start !== null && isGone({ pid: r.pid, start: r.pid_start }) === true ? "holder-gone" : "live";
}

function bindsStill(r: { expires_at: string; pid: number | null; pid_start: string | null }): boolean {
  return stateOf(r) === "live";
}

/**
 * The claim this worktree holds, live or not: the worktree belongs to that change whatever its lease, so
 * `canon brief` and `canon human ask` name it (BR-2024, BR-2075); who may act in it is decided by renewClaim.
 */
export function claimOfWorktree(db: CoordDb, worktree: string): Claim | undefined {
  return claims(db).find((c) => c.holder === worktree);
}
