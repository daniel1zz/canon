import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../db.ts";
import { isGone, type Proc } from "../claims/liveness.ts";
import { delegation, type Delegation } from "./records.ts";
import { isWorker } from "./worker.ts";

/**
 * The design owner taking a delegated change back (BR-2500, D-128): by `canon work take`, or by the takeover of a
 * lapsed claim in `canon work start`, `land` and `stop` (BR-2100, BR-2104). Every function here runs inside the
 * caller's write transaction.
 */

interface ClaimRow {
  readonly holder: string;
  readonly worktree: string | null;
  readonly pid: number | null;
  readonly pid_start: string | null;
}

const sessionOf = (actor: string): string | undefined => actor.split(":")[1];
const nameOf = (actor: string): string => actor.split(":").slice(2).join(":");
const alive = (pid: number | null, start: string | null): boolean => pid === null || start === null || isGone({ pid, start }) !== true;

/**
 * The landing of this change that is queued, running or a member of a running batch, while its lander process
 * (BR-2142) is not provably gone; undefined when there is none. A row without a process is counted: nothing proves it over.
 */
export function landingInProgress(db: CoordDb, subject: string, worktree: string | null): string | undefined {
  const rows = db.db
    .query<{ id: number; state: string; pid: number | null; pid_start: string | null; batch: number | null }, [string, string]>(
      "SELECT id, state, pid, pid_start, batch FROM queue WHERE (subject = ? OR worktree = ?) AND state IN ('waiting','landing') ORDER BY id",
    )
    .all(subject, worktree ?? "");
  for (const r of rows) {
    const leader = r.batch === null ? null : db.db.query<{ state: string; pid: number | null; pid_start: string | null }, [number]>("SELECT state, pid, pid_start FROM queue WHERE id = ?").get(r.batch);
    const inBatch = leader !== null && (leader.state === "waiting" || leader.state === "landing") && alive(leader.pid, leader.pid_start);
    if (alive(r.pid, r.pid_start) || inBatch) return `landing #${r.id} is ${inBatch ? `in the batch of landing #${r.batch}` : r.state === "waiting" ? "queued" : "running"}`;
  }
  return undefined;
}

/** Ends the delegation as a take does: the epoch rises by one and the old one is void for good (BR-2500, BR-2498). */
function endDelegation(db: CoordDb, d: Delegation, actor: string, from: string, worktree: string | null, extra: Record<string, unknown>): void {
  const epoch = d.epoch + 1;
  db.db.query("UPDATE delegations SET epoch = ?, ended = ? WHERE subject = ?").run(epoch, new Date().toISOString(), d.subject);
  db.event(actor, "claim.handover", d.subject, { from, by: "design-owner", worktree, epoch, ...extra });
}

/**
 * Before `canon work start`, `land` or `stop` takes over a lapsed claim another actor holds (BR-2100, BR-2104): on a
 * change delegated out, only its design owner may, with no landing in progress, and then it is a take. True when the
 * takeover was made a take (the caller writes no `claim.take`); false when the change is not delegated out.
 */
export function lapsedTakeover(db: CoordDb, subject: string, actor: string, cur: ClaimRow): Result<boolean> {
  const d = delegation(db, subject);
  if (!d || d.ended || cur.holder === actor || cur.worktree?.startsWith("hold:")) return ok(false);
  const refuse = (message: string, extra: Record<string, unknown> = {}): Result<boolean> => {
    db.event(actor, "claim.refuse", subject, { reason: "delegated", actor: cur.holder, owner: d.owner, ...extra });
    return err("conflict", message);
  };
  if (actor !== d.owner) {
    return refuse(`${subject} is delegated to ${d.worker} and held by ${cur.holder}; only its design owner ${d.owner} can take it over (canon work take ${subject} --from ${nameOf(cur.holder) || "<name>"}) or delegate it again; nothing changed`);
  }
  const landing = landingInProgress(db, subject, cur.worktree);
  if (landing) return refuse(`${subject}: ${landing}; take it over once that landing ends; nothing changed`, { landing });
  // reason: an automatic takeover needs the worker stopped, as `canon work take` does: a lease that expired while its
  // process still runs is no stopped worker. With no process to look at, an expired lease is the only signal (BR-2500, #153, #155).
  const gone = cur.pid !== null && cur.pid_start !== null ? isGone({ pid: cur.pid, start: cur.pid_start }) : undefined;
  if (gone === false) {
    const other = sessionOf(cur.holder) !== sessionOf(actor);
    return refuse(
      `${subject} is held by ${cur.holder}, whose session process ${cur.pid} is still running${other ? " in another session" : ""}, although its lease has lapsed; stop that worker through the dispatch tool or its host first, then run canon work take ${subject} --from ${nameOf(cur.holder) || "<name>"} --stopped${other ? " (while that process runs in another session, --stopped is refused too)" : ""}; nothing changed`,
      { process: "alive" },
    );
  }
  endDelegation(db, d, actor, cur.holder, cur.worktree, { lapsed: true });
  return ok(true);
}

export interface TakenBack {
  /** The worktree the owner now holds; empty when no one holds a claim. */
  readonly worktree: string;
  readonly epoch: number;
  readonly asserted: boolean;
}

/**
 * `canon work take <C-n> --from <name>` on a change with a delegation record (BR-2500). Undefined when the change has
 * none: the caller falls back to BR-2336's same-session subagent take.
 */
export function takeBack(db: CoordDb, subject: string, actor: string, from: string, stopped: boolean, leaseMs: number, owner: Proc | undefined): Result<TakenBack> | undefined {
  return db.db.transaction((): Result<TakenBack> | undefined => {
    const d = delegation(db, subject);
    if (!d) return undefined;
    const cur = db.db.query<ClaimRow, [string]>("SELECT holder, worktree, pid, pid_start FROM claims WHERE subject = ?").get(subject);
    const refuse = (message: string, extra: Record<string, unknown> = {}): Result<TakenBack> => {
      db.event(actor, "claim.refuse", subject, { reason: "handover", from, actor: cur?.holder ?? null, ...extra });
      return err("conflict", message);
    };
    if (actor !== d.owner) return refuse(`${subject} is delegated by ${d.owner}; only its current design owner can take it back (you are ${actor}); nothing changed. If that session has ended (a new session, another machine), adopt its delegations first: canon work adopt ${subject} --from ${d.owner} (add --gone when canon cannot tell it ended)`);
    if (d.ended) return refuse(`${subject}: its delegation already ended at ${d.ended}; there is nothing delegated to take back`);
    // reason: a worker that released its claim (stop --release) leaves the delegation in force with no claim to hand over;
    // the owner ends it so the change and its rule proposals come back, keeping a claim the owner already holds (BR-2500)
    if (!cur || cur.holder === actor) {
      if (from !== d.worker) return refuse(`${subject} is delegated to ${d.worker}, not to ${from}; nothing changed`);
      const running = landingInProgress(db, subject, cur?.worktree ?? null);
      if (running) return refuse(`${subject}: ${running}; end the delegation once that landing ends (landed or refused); nothing changed`, { landing: running });
      endDelegation(db, d, actor, from, cur?.worktree ?? null, { claim: cur ? "owner" : "none" });
      return ok({ worktree: cur?.worktree ?? "", epoch: d.epoch + 1, asserted: false });
    }
    if (cur.worktree?.startsWith("hold:")) return refuse(`${subject}'s worktree is being deleted by \`canon work clean\` or \`canon work drop\` right now; nothing changed`);
    if (!isWorker(cur.holder) || nameOf(cur.holder) !== from) return refuse(`${subject} is claimed by ${cur.holder}, not by a worker named ${from}; nothing changed`);
    const landing = landingInProgress(db, subject, cur.worktree);
    if (landing) return refuse(`${subject}: ${landing}; take it over once that landing ends (landed or refused); nothing changed`, { landing });
    const gone = cur.pid !== null && cur.pid_start !== null ? isGone({ pid: cur.pid, start: cur.pid_start }) : undefined;
    if (gone !== true) {
      const state = gone === false ? `its session process ${cur.pid} is still running` : "canon cannot tell whether its session has stopped";
      if (!stopped) return refuse(`${subject} is held by ${cur.holder} and ${state}; stop that worker through the dispatch tool or its host first, then run canon work take ${subject} --from ${from} --stopped; nothing changed`, { process: gone === false ? "alive" : "unknown" });
      // reason: --stopped vouches for a worker canon cannot see; a process proven alive in another session is not one (BR-2500)
      if (gone === false && sessionOf(cur.holder) !== sessionOf(actor)) return refuse(`${subject} is held by ${cur.holder}, whose session process ${cur.pid} is still running in another session; --stopped cannot take over a running session; stop it first; nothing changed`, { process: "alive" });
    }
    const expires = new Date(Date.now() + leaseMs).toISOString();
    db.db.query("UPDATE claims SET holder = ?, expires_at = ?, pid = ?, pid_start = ?, delegation_epoch = NULL, version = version + 1 WHERE subject = ?").run(actor, expires, owner?.pid ?? null, owner?.start ?? null, subject);
    const asserted = gone !== true;
    endDelegation(db, d, actor, cur.holder, cur.worktree, asserted ? { stopped: "asserted" } : {});
    return ok({ worktree: cur.worktree ?? "", epoch: d.epoch + 1, asserted });
  }).immediate();
}
