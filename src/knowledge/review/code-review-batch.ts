import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoordDb } from "../../work/db.ts";
import type { Say, Workspace } from "../../work/workspace.ts";
import { isGone, selfProcess, type Proc } from "../../work/claims/liveness.ts";
import { nowMs } from "../../kernel/clock.ts";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { codeReview, type Env } from "./code-review.ts";

/**
 * Post-land code review in batches (D-59, BR-2314, BR-2315, BR-2316): `refs/canon/code-reviewed` is the last commit
 * whose code was reviewed; the landings after it wait until enough are in or the oldest is old enough, then one
 * review covers the whole range. The ref moves only after a review that filed its findings, by compare-and-swap.
 */
export const REVIEWED_REF = "refs/canon/code-reviewed";

/** A landing: the commit it put on main, the change, and when (ms). */
export interface Landed {
  readonly sha: string;
  readonly change: string | null;
  readonly at: number;
}

/** Every landing recorded (land.ok), newest first. */
export function landedEvents(db: CoordDb): Landed[] {
  return db.db
    .query<{ sha: string | null; subject: string | null; ts: string }, []>("SELECT json_extract(detail, '$.sha') AS sha, subject, ts FROM events WHERE kind = 'land.ok' ORDER BY id DESC LIMIT 5000")
    .all()
    .flatMap((r) => (r.sha ? [{ sha: r.sha, change: r.subject, at: Date.parse(r.ts) }] : []));
}

/** The commits `reviewed..head` and the landings among them, oldest first. */
export interface Pending {
  /** Where the range starts: the merge base of the reviewed commit and `head`. */
  readonly base: string;
  readonly commits: readonly string[];
  readonly landings: readonly Landed[];
  /** Whether the range changes anything outside canon/ (BR-2070). */
  readonly codeChanged: boolean;
  /** When the oldest of the landings landed; the oldest commit's date when there is none (ms). */
  readonly oldestAt: number;
}

export const readReviewedRef = (cwd: string): string | null => {
  const r = git(cwd, "rev-parse", "--verify", "--quiet", REVIEWED_REF);
  return r.ok && r.value !== "" ? r.value : null;
};

/** What `reviewed..head` holds; no commits when `head` is already reviewed. */
export function pendingRange(cwd: string, reviewed: string, head: string, landed: readonly Landed[]): Result<Pending> {
  const base = git(cwd, "merge-base", reviewed, head);
  const from = base.ok ? base.value : reviewed;
  const list = git(cwd, "rev-list", `${from}..${head}`);
  if (!list.ok) return err("io", list.error.message);
  const commits = list.value === "" ? [] : list.value.split("\n");
  if (commits.length === 0) return ok({ base: from, commits, landings: [], codeChanged: false, oldestAt: 0 });
  const order = new Map(commits.map((c, i) => [c, i]));
  const landings = landed.filter((l) => order.has(l.sha)).sort((a, b) => order.get(b.sha)! - order.get(a.sha)!);
  const diff = git(cwd, "diff", "--name-only", from, head, "--", ".", ":(exclude)canon");
  if (!diff.ok) return err("io", diff.error.message);
  const oldest = git(cwd, "log", "-1", "--format=%ct", commits[commits.length - 1]!);
  const oldestAt = landings.length > 0 ? Math.min(...landings.map((l) => l.at)) : oldest.ok ? Number(oldest.value) * 1000 : 0;
  return ok({ base: from, commits, landings, codeChanged: diff.value !== "", oldestAt });
}

/** Whether the batch is due: enough landings, or the oldest is old enough (BR-2314). */
export function reviewDue(p: Pending, limits: { maxUnreviewed: number; maxAgeMs: number }): boolean {
  return p.landings.length >= limits.maxUnreviewed || nowMs() - p.oldestAt >= limits.maxAgeMs;
}

/** `C-a, C-b` for the landings of a batch, a short commit for one without a change. */
export const changesOf = (landings: readonly Landed[]): string => landings.map((l) => l.change ?? l.sha.slice(0, 9)).join(", ");

/** The change a line of `file` at `head` belongs to: the first landing of the range that holds the commit that wrote it (BR-2210). */
export function ownerOf(cwd: string, head: string, p: Pending): (file: string, line: number) => string | undefined {
  return (file, line) => {
    const blame = git(cwd, "blame", "--porcelain", "-L", `${line},${line}`, head, "--", file);
    const sha = blame.ok ? blame.value.split(" ")[0] : undefined;
    if (!sha || !p.commits.includes(sha)) return undefined;
    const l = p.landings.find((x) => git(cwd, "merge-base", "--is-ancestor", sha, x.sha).ok);
    return l ? (l.change ?? l.sha.slice(0, 9)) : undefined;
  };
}

/** Moves the reviewed ref to `to` by compare-and-swap from `from` (empty: it must not exist yet). */
export function advanceReviewed(cwd: string, to: string, from: string | null): Result<void> {
  const r = git(cwd, "update-ref", "-m", "canon: code reviewed", REVIEWED_REF, to, from ?? "");
  return r.ok ? ok(undefined) : err("conflict", `${REVIEWED_REF} moved meanwhile and was left as it is (${r.error.message})`);
}

interface ReviewerRow {
  readonly pid: number;
  readonly pid_start: string;
}

/** Whether a review is running: a holder is recorded in the coordination database and its process is not provably gone (an unreadable process table counts as alive, D-11). */
export function reviewRunning(db: CoordDb): boolean {
  const row = db.db.query<ReviewerRow, []>("SELECT pid, pid_start FROM code_reviewer WHERE id = 1").get();
  return row !== null && isGone({ pid: row.pid, start: row.pid_start }) !== true;
}

/** Becomes the one review, taking over from a holder whose process is gone; false while another is alive (BR-2314). */
function claimReviewer(db: CoordDb, self: Proc): boolean {
  return db.db
    .transaction(() => {
      const row = db.db.query<ReviewerRow, []>("SELECT pid, pid_start FROM code_reviewer WHERE id = 1").get();
      if (row && !(row.pid === self.pid && row.pid_start === self.start) && isGone({ pid: row.pid, start: row.pid_start }) !== true) return false;
      db.db.query("INSERT OR REPLACE INTO code_reviewer(id, pid, pid_start, started_at) VALUES (1, ?, ?, ?)").run(self.pid, self.start, new Date().toISOString());
      return true;
    })
    .immediate();
}

/** Deletes the row only while it is mine: a review whose row was taken over must not delete the new holder's. */
function releaseReviewer(db: CoordDb, self: Proc): void {
  db.db.query("DELETE FROM code_reviewer WHERE id = 1 AND pid = ? AND pid_start = ?").run(self.pid, self.start);
}

const LOCK_WAIT_MS = 30 * 60_000;

/** Takes the review slot, waiting for a live holder up to 30 minutes (or not at all with `wait` false); a dead holder's slot is taken over. */
async function takeLock(db: CoordDb, wait: boolean): Promise<(() => void) | "busy"> {
  const me: Proc = selfProcess() ?? { pid: process.pid, start: "" };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (claimReviewer(db, me)) return () => releaseReviewer(db, me);
    if (!wait) return "busy";
    if (Date.now() > deadline) throw new Error("another code review has been running for more than 30 minutes");
    await Bun.sleep(2000);
  }
}

export interface BatchInput {
  readonly cwd: string;
  /** The coordination database that holds the one-review-at-a-time slot. */
  readonly db: CoordDb;
  /** The landing's base: where the reviewed ref starts when it is missing. */
  readonly base: string | undefined;
  readonly head: string;
  readonly ai: string;
  readonly gh: string;
  readonly landed: readonly Landed[];
  readonly limits: { maxUnreviewed: number; maxAgeMs: number };
  readonly force: boolean;
  /** Do not wait for a review that is running (the one the brief starts). */
  readonly noWait: boolean;
  readonly say: (line: string) => void;
}

/**
 * One `after_land` run of the code review (BR-2314, BR-2315): defers until the batch is due, then reviews the range
 * from the reviewed ref to `head` and moves the ref after the findings are filed.
 */
export async function reviewBatch(i: BatchInput): Promise<Result<void>> {
  const lock = await takeLock(i.db, !i.noWait);
  if (lock === "busy") {
    i.say("another code review is running; it covers this range");
    return ok(undefined);
  }
  try {
    let reviewed = readReviewedRef(i.cwd);
    if (reviewed === null) {
      if (!i.base) return err("not_found", `${REVIEWED_REF} does not exist yet and no CANON_BASE says where reviewing starts; run it as an after_land hook once`);
      // reason: the first run starts at this landing's base, so old history is not reviewed (BR-2315).
      const made = advanceReviewed(i.cwd, i.base, null);
      if (!made.ok) return made;
      reviewed = i.base;
    }
    const p = pendingRange(i.cwd, reviewed, i.head, i.landed);
    if (!p.ok) return p;
    if (p.value.commits.length === 0) {
      i.say("already reviewed in a batch; nothing to review");
      return ok(undefined);
    }
    if (!p.value.codeChanged) {
      const moved = advanceReviewed(i.cwd, i.head, reviewed);
      if (moved.ok) i.say("no code changed; nothing to review");
      return moved;
    }
    const n = p.value.landings.length;
    if (!i.force && !reviewDue(p.value, i.limits)) {
      i.say(`deferred — ${n} landing(s) not reviewed yet (reviewed in a batch at ${i.limits.maxUnreviewed} or after ${i.limits.maxAgeMs / 60_000} min)`);
      return ok(undefined);
    }
    const env: Env = {
      cwd: i.cwd,
      base: p.value.base,
      head: i.head,
      change: changesOf(p.value.landings),
      ai: i.ai,
      gh: i.gh,
      say: i.say,
      owner: ownerOf(i.cwd, i.head, p.value),
    };
    const r = codeReview(env);
    // reason: a failed review leaves the ref where it was, so the next run reviews the same range again (BR-2315).
    if (!r.ok) return r;
    const moved = advanceReviewed(i.cwd, i.head, reviewed);
    if (moved.ok) i.say(`reviewed ${n} landing(s) in one batch (${p.value.base.slice(0, 9)}..${i.head.slice(0, 9)})`);
    return moved;
  } finally {
    lock();
  }
}

/** The review state of main for `canon work status` and `canon brief`: undefined when nothing waits (BR-2316). */
export function unreviewed(ws: Workspace): { pending: Pending; due: boolean; head: string; reviewed: string } | undefined {
  const reviewed = readReviewedRef(ws.primary);
  const head = git(ws.primary, "rev-parse", "--verify", `refs/heads/${ws.config.main}`);
  if (reviewed === null || !head.ok) return undefined;
  const p = pendingRange(ws.primary, reviewed, head.value, landedEvents(ws.db));
  if (!p.ok || p.value.commits.length === 0 || !p.value.codeChanged || p.value.landings.length === 0) return undefined;
  return { pending: p.value, due: reviewDue(p.value, { maxUnreviewed: ws.config.reviewMaxUnreviewed, maxAgeMs: ws.config.reviewMaxAgeMs }), head: head.value, reviewed };
}

/** The line `canon work status` and `canon brief` print while landings are not code-reviewed (BR-2316). */
export function unreviewedNotice(ws: Workspace): string[] {
  const u = unreviewed(ws);
  if (!u) return [];
  const n = u.pending.landings.length;
  return [`main: ${n} landing(s) not code-reviewed yet (reviewed in a batch at ${ws.config.reviewMaxUnreviewed} or after ${ws.config.reviewMaxAgeMs / 60_000} min${u.due ? "; due now" : ""})`];
}

/**
 * `canon brief`: when the batch at main's tip is due and no review is running, starts the review commands of
 * `hooks.after_land` (the ones that run scripts/code-review.ts) in the background, for the last batch no landing is
 * left to trigger (BR-2316). Returns the log, if it started.
 */
export function startTrailingReview(ws: Workspace, say: Say): string | undefined {
  const commands = ws.config.hooks.after_land.filter((c) => c.includes("scripts/code-review.ts"));
  if (commands.length === 0) return undefined;
  const u = unreviewed(ws);
  if (!u || !u.due || reviewRunning(ws.db)) return undefined;
  const log = join(dirname(ws.db.db.filename), "logs", "code-review-trailing.log");
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    for (const command of commands) {
      // reason: its own process group, so the end of the session that ran canon brief does not stop it; no daemon: it ends with the review (BR-2316).
      const p = Bun.spawn(["sh", "-c", command], {
        cwd: ws.primary,
        stdout: fd,
        stderr: fd,
        stdin: "ignore",
        detached: true,
        env: { ...(process.env as Record<string, string>), CANON_BASE: u.reviewed, CANON_HEAD: u.head, CANON_CHANGE: "", CANON_CODE_REVIEW_NOWAIT: "1" },
      });
      p.unref();
    }
  } finally {
    closeSync(fd);
  }
  say(`code-review: ${u.pending.landings.length} landing(s) not reviewed and none left to trigger it; reviewing them in the background (log: ${log})`);
  return log;
}
