import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../workspace.ts";
import { liveClaim } from "../claims/claims.ts";
import { handoffs } from "../session/handoffs.ts";
import { corpusOf } from "../session/session.ts";

/**
 * A delegated change nobody is working on (BR-2522, #255): its delegation is in force, no claim on it still binds (none,
 * expired, or its session process gone, BR-2100), and its branch has had no commit, nor the delegation an update, for
 * `delegation_stall_minutes`. Worked out on every read, never stored.
 */
export interface StalledDelegation {
  readonly subject: string;
  readonly worker: string;
  readonly owner: string;
  /** The later of the branch's last commit and the last delegate or redelegate, ISO 8601. */
  readonly since: string;
  /** The last commit on the change's branch, ISO 8601; absent when it has no branch. */
  readonly lastCommit?: string;
  /** The worker's last handoff (`canon work stop --next`), when one is recorded. */
  readonly handoff?: string;
}

/** The delegated changes stalled at `now` (BR-2522). */
export function stalledDelegations(ws: Workspace, now: number = Date.now()): Result<StalledDelegation[]> {
  const rows = ws.db.db.query<{ subject: string; worker: string; owner: string }, []>("SELECT subject, worker, owner FROM delegations WHERE ended IS NULL ORDER BY subject").all();
  if (rows.length === 0) return ok([]);
  const refs = git(ws.primary, "for-each-ref", "--format=%(committerdate:iso-strict) %(refname:short)", "refs/heads/change/");
  if (!refs.ok) return err("io", `cannot list change branches to find stalled delegations: ${refs.error.message}`);
  const lastCommitOf = (subject: string): string | undefined => {
    const name = new RegExp(`^change/${subject}(?:-.*)?$`);
    const dates = refs.value
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ date: l.slice(0, l.indexOf(" ")), branch: l.slice(l.indexOf(" ") + 1) }))
      .filter((r) => name.test(r.branch))
      .map((r) => r.date);
    return dates.length === 0 ? undefined : dates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  };
  const notes = new Map(handoffs(ws.db).map((h) => [h.subject, h.next]));
  const out: StalledDelegation[] = [];
  // reason: a change closed on main is finished whatever its delegation record says; read main only when a candidate exists (BR-2522, #264)
  let closed: ReadonlySet<string> | undefined;
  const closedOnMain = (subject: string): Result<boolean> => {
    if (!closed) {
      const main = corpusOf(ws, ws.config.main);
      if (!main.ok) return main;
      closed = new Set(main.value.docs.filter((d) => d.kind === "change" && d.status !== "open").map((d) => d.id));
    }
    return ok(closed.has(subject));
  };
  for (const r of rows) {
    if (liveClaim(ws.db, r.subject)) continue;
    const delegated = ws.db.db
      .query<{ ts: string }, [string]>("SELECT ts FROM events WHERE subject = ? AND kind IN ('delegation.create', 'delegation.update') ORDER BY id DESC LIMIT 1")
      .get(r.subject)?.ts;
    const lastCommit = lastCommitOf(r.subject);
    const times = [lastCommit, delegated].filter((t): t is string => t !== undefined);
    if (times.length === 0) continue;
    const since = times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    if (now - Date.parse(since) < ws.config.delegationStallMs) continue;
    const done = closedOnMain(r.subject);
    if (!done.ok) return done;
    if (done.value) continue;
    const handoff = notes.get(r.subject);
    out.push({ subject: r.subject, worker: r.worker, owner: r.owner, since, ...(lastCommit ? { lastCommit } : {}), ...(handoff ? { handoff } : {}) });
  }
  return ok(out);
}

/** The `canon work status` line of one stalled delegation (BR-2522). */
export function stalledLine(s: StalledDelegation): string {
  return `${s.subject}: stalled: delegated to ${s.worker}, no live worker and no commit since ${s.since}${s.lastCommit ? ` (last commit ${s.lastCommit})` : " (no branch commit)"}${s.handoff ? `; last handoff: ${s.handoff}` : ""}; design owner ${s.owner}: delegate it again (canon work delegate ${s.subject} --to <name>) or take it over (canon work take ${s.subject})`;
}
