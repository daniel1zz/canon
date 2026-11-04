import { existsSync } from "node:fs";
import type { Say, Workspace } from "../../workspace.ts";
import type { CoordDb } from "../../db.ts";
import { git } from "../../../kernel/git.ts";
import { isGone } from "../../claims/liveness.ts";
import { closeSubject, reopen } from "../finish/finish.ts";
import { rebaseInProgress } from "../worktree-state.ts";

/**
 * Landings that never recorded a result (BR-2307..BR-2310, D-58). `canon work land` records `land.start` with its own
 * process before anything slow; a landing whose latest `land.start` has no end event and whose process is gone was
 * killed (SIGKILL, a harness timeout) where no signal handler could run (BR-2099).
 */

/** The events that end a landing: BR-2307. */
const ENDS = "('land.ok','land.refuse','land.killed','land.lost','land.interrupt')";

export type AttemptState = "running" | "interrupted" | "unknown";

export interface Attempt {
  /** The `land.start` event. */
  readonly id: number;
  readonly ts: string;
  readonly subject: string | null;
  readonly worktree: string;
  readonly pid: number | null;
  readonly pidStart: string | null;
  readonly state: AttemptState;
  /** What the killed landing left behind; empty unless it is interrupted. */
  readonly leftovers: Leftovers;
}

export interface Leftovers {
  /** Queue entries of the dead lander that are still waiting or landing. */
  readonly queue: readonly number[];
  /** The change's close commit is the branch's top commit. */
  readonly closeCommit: boolean;
  readonly rebase: boolean;
}

const NONE: Leftovers = { queue: [], closeCommit: false, rebase: false };

interface StartRow {
  id: number;
  ts: string;
  subject: string | null;
  worktree: string;
  detail: string;
}

function toAttempt(db: CoordDb, r: StartRow): Attempt | undefined {
  // reason: a worktree that was cleaned or dropped has nothing left to report or clean (D-58).
  if (!existsSync(r.worktree)) return undefined;
  const ended = db.db
    .query<{ one: number }, [number, string, string | null, string | null]>(`SELECT 1 AS one FROM events WHERE id > ? AND kind IN ${ENDS} AND (worktree = ? OR (? IS NOT NULL AND subject = ?)) LIMIT 1`)
    .get(r.id, r.worktree, r.subject, r.subject);
  if (ended) return undefined;
  const d = JSON.parse(r.detail) as { pid?: number | null; pid_start?: string | null };
  const pid = typeof d.pid === "number" ? d.pid : null;
  const start = typeof d.pid_start === "string" ? d.pid_start : null;
  // reason: no recorded process, or an unreadable process table, proves nothing: say so instead of calling it killed (D-11).
  const gone = pid !== null && start !== null ? isGone({ pid, start }) : undefined;
  const state: AttemptState = gone === undefined ? "unknown" : gone ? "interrupted" : "running";
  return { id: r.id, ts: r.ts, subject: r.subject, worktree: r.worktree, pid, pidStart: start, state, leftovers: state === "interrupted" ? leftoversOf(db, r.worktree, r.subject, pid!, start!) : NONE };
}

/** The unfinished landings of every worktree: its latest `land.start`, when nothing ended it. */
export function openAttempts(db: CoordDb): Attempt[] {
  const rows = db.db
    .query<StartRow, []>("SELECT id, ts, subject, worktree, detail FROM events WHERE kind = 'land.start' AND id IN (SELECT MAX(id) FROM events WHERE kind = 'land.start' GROUP BY worktree) ORDER BY id")
    .all();
  return rows.flatMap((r) => toAttempt(db, r) ?? []);
}

/** The unfinished landing of one worktree. */
export function attemptIn(db: CoordDb, worktree: string): Attempt | undefined {
  const r = db.db.query<StartRow, [string]>("SELECT id, ts, subject, worktree, detail FROM events WHERE kind = 'land.start' AND worktree = ? ORDER BY id DESC LIMIT 1").get(worktree);
  return r ? toAttempt(db, r) : undefined;
}

function closeCommitOf(wt: string, subject: string | null): { subject: string; path: string } | undefined {
  if (!subject) return undefined;
  const top = git(wt, "log", "-1", "--format=%s");
  const files = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "HEAD~1", "HEAD");
  if (!top.ok || top.value !== closeSubject(subject) || !files.ok || files.value === "" || files.value.includes("\n")) return undefined;
  return { subject, path: files.value };
}

// reason: a member its leader locked in is about to be on main; it is not this attempt's to give up (BR-2172).
const OPEN_ENTRY = "state IN ('waiting','landing') AND NOT (state = 'landing' AND batch IS NOT NULL)";

function leftoversOf(db: CoordDb, wt: string, subject: string | null, pid: number, start: string): Leftovers {
  const queue = db.db.query<{ id: number }, [number, string]>(`SELECT id FROM queue WHERE pid = ? AND pid_start = ? AND ${OPEN_ENTRY} ORDER BY id`).all(pid, start).map((q) => q.id);
  return { queue, closeCommit: closeCommitOf(wt, subject) !== undefined, rebase: rebaseInProgress(wt) };
}

/** What `status`, `brief`, `after-land` and the next landing say about an unfinished landing (BR-2308, BR-2310). */
export function describeAttempt(a: Attempt): string[] {
  const who = `${a.subject ?? "-"} (${a.worktree})`;
  if (a.state === "running") return [`${who}: landing running, process ${a.pid} since ${a.ts}`];
  if (a.state === "unknown") return [`${who}: landing started ${a.ts} has no recorded result; whether its process is still running could not be read`];
  const out = [`${who}: landing INTERRUPTED: its process ${a.pid} (started ${a.ts}) is gone and no landing result was recorded`];
  const l = a.leftovers;
  if (l.queue.length > 0) out.push(`  left behind: queue entry ${l.queue.map((q) => `#${q}`).join(", ")} (the next landing from this worktree gives it up)`);
  if (l.closeCommit) out.push(`  left behind: the close commit is the branch's top commit (the next landing from this worktree takes it back)`);
  if (l.rebase) out.push(`  left behind: a rebase stopped midway; run \`git rebase --abort\` in ${a.worktree} before landing again (canon does not undo it: it may be one you started)`);
  out.push(`  next: run \`canon work land\` again in ${a.worktree}`);
  return out;
}

/** Queue entries whose lander process is gone, for `canon work status` (BR-2308). */
export function goneLanders(db: CoordDb): Set<number> {
  const rows = db.db.query<{ id: number; pid: number; pid_start: string }, []>("SELECT id, pid, pid_start FROM queue WHERE state IN ('waiting','landing') AND pid IS NOT NULL AND pid_start IS NOT NULL").all();
  return new Set(rows.filter((r) => isGone({ pid: r.pid, start: r.pid_start }) === true).map((r) => r.id));
}

/**
 * The next landing from a worktree whose previous landing was killed: says so, takes back what it can (BR-2309).
 * A rebase left midway is only named: it may be one the person started after the kill.
 */
export function settleInterrupted(ws: Workspace, say: Say): void {
  const a = attemptIn(ws.db, ws.root);
  if (!a) return;
  if (a.state === "running") {
    say(`the previous landing from this worktree is still running (process ${a.pid}, started ${a.ts})`);
    return;
  }
  if (a.state !== "interrupted") return;
  for (const line of describeAttempt(a)) say(line);
  for (const q of a.leftovers.queue) {
    ws.db.db.query(`UPDATE queue SET state = 'abandoned', result = 'lander process gone' WHERE id = ? AND pid = ? AND pid_start = ? AND ${OPEN_ENTRY}`).run(q, a.pid, a.pidStart);
  }
  const close = a.leftovers.rebase ? undefined : closeCommitOf(ws.root, a.subject);
  const reopened = close !== undefined && reopen(ws.root, close, say);
  ws.db.event(ws.actor, "land.interrupt", a.subject, { start: a.id, pid: a.pid, queue: a.leftovers.queue, close_commit_reopened: reopened, rebase_in_progress: a.leftovers.rebase });
}
