import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../db.ts";
import { isGone } from "../claims/liveness.ts";

/**
 * `canon work adopt`: a main session or a person becomes the design owner of the delegations whose owner session has
 * ended, so it can take them back or delegate them again (BR-2500, D-128). It changes the owner only: the worker's
 * claim and the delegation's epoch stay, and the new owner takes back with `canon work take` as usual.
 */

export interface Adopted {
  readonly subjects: readonly string[];
  /** proven: a process the old owner's claims recorded is gone; asserted: canon could not tell, the runner said --gone. */
  readonly gone: "proven" | "asserted";
}

/** Whether the old owner's session is gone, from the session processes its claims recorded: true, false (one runs), or undefined. */
export function ownerGone(db: CoordDb, owner: string): boolean | undefined {
  const rows = db.db.query<{ pid: number | null; pid_start: string | null }, [string]>("SELECT pid, pid_start FROM claims WHERE holder = ?").all(owner);
  let gone: boolean | undefined;
  for (const r of rows) {
    if (r.pid === null || r.pid_start === null) continue;
    const g = isGone({ pid: r.pid, start: r.pid_start });
    if (g === false) return false;
    if (g === true) gone = true;
  }
  return gone;
}

/** A session-level actor (a main session `agent:<session>`) or a person (`human:<name>`); not a worker or subagent. */
export const mayAdopt = (actor: string): boolean => /^agent:[^:]+$/.test(actor) || /^human:[^:]+$/.test(actor);

/** How long an owner canon cannot see stays quiet before the agenda offers its delegations for adoption (BR-2647). */
export const ORPHAN_QUIET_MS = 6 * 60 * 60 * 1000;

/**
 * Delegations in force whose design owner is another actor whose session is gone, or one canon cannot see that has
 * written no event for ORPHAN_QUIET_MS: one entry per owner, for the agenda of a session that may adopt (BR-2647).
 */
export function orphanedDelegations(db: CoordDb, actor: string, now: number): { owner: string; subjects: string[]; since: string | null; proven: boolean }[] {
  if (!mayAdopt(actor)) return [];
  const rows = db.db.query<{ owner: string; subject: string }, [string]>("SELECT owner, subject FROM delegations WHERE ended IS NULL AND owner != ? ORDER BY owner, subject").all(actor);
  const byOwner = new Map<string, string[]>();
  for (const r of rows) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r.subject]);
  const out: { owner: string; subjects: string[]; since: string | null; proven: boolean }[] = [];
  for (const [owner, subjects] of byOwner) {
    const gone = ownerGone(db, owner);
    if (gone === false) continue;
    const last = db.db.query<{ ts: string | null }, [string]>("SELECT max(ts) AS ts FROM events WHERE actor = ?").get(owner)?.ts ?? null;
    // reason: another main session that recorded no process looks the same as an ended one; quiet for hours tells them apart (BR-2647)
    if (gone === undefined && last !== null && now - Date.parse(last) < ORPHAN_QUIET_MS) continue;
    out.push({ owner, subjects, since: last, proven: gone === true });
  }
  return out;
}

export function adopt(db: CoordDb, actor: string, from: string, subjects: readonly string[], gone: boolean): Result<Adopted> {
  return db.db.transaction((): Result<Adopted> => {
    const refuse = (message: string, extra: Record<string, unknown> = {}): Result<Adopted> => {
      db.event(actor, "claim.refuse", subjects.length === 1 ? subjects[0]! : null, { reason: "adopt", from, subjects, ...extra });
      return err("conflict", message);
    };
    if (from === actor) return refuse(`${from} is you: you already own its delegations; nothing changed`);
    const open = db.db.query<{ subject: string }, [string]>("SELECT subject FROM delegations WHERE owner = ? AND ended IS NULL ORDER BY subject").all(from).map((r) => r.subject);
    const chosen = subjects.length > 0 ? subjects : open;
    if (chosen.length === 0) return refuse(`${from} owns no delegation in force; nothing to adopt`);
    const notOwned = chosen.filter((s) => !open.includes(s));
    if (notOwned.length > 0) return refuse(`${notOwned.join(", ")}: not a delegation in force owned by ${from}; nothing changed`, { not_owned: notOwned });
    const state = ownerGone(db, from);
    // reason: a design owner whose session still runs keeps its delegations; --gone cannot override a process canon sees (BR-2500)
    if (state === false) return refuse(`${from}'s session process is still running; it can take back or delegate its changes itself; nothing changed`, { process: "alive" });
    if (state === undefined && !gone) return refuse(`canon cannot tell whether ${from}'s session has ended (no session process of it is recorded on this machine); if it has, run again with --gone; nothing changed`, { process: "unknown" });
    const how = state === true ? "proven" : "asserted";
    for (const s of chosen) {
      db.db.query("UPDATE delegations SET owner = ? WHERE subject = ?").run(actor, s);
      db.event(actor, "delegation.adopt", s, { from, to: actor, gone: how });
    }
    return ok({ subjects: chosen, gone: how });
  }).immediate();
}
