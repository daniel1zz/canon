import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CoordDb } from "../../work/db.ts";
import type { Say, Workspace } from "../../work/workspace.ts";
import type { Running } from "../../work/land/outcome.ts";
import { isGone, selfProcess, type Proc } from "../../work/claims/liveness.ts";
import { logFile } from "../../work/hooks/hooks.ts";
import { canonCommand } from "../../work/watch/watch.ts";
import { removeReviewTree } from "../../work/land/checks/review-tree.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { REVIEW_NONE, REVIEW_WAYS_OUT } from "./config-keys.ts";
import { reviewLanded } from "./landed.ts";

/**
 * The queue of landed reviews (BR-2441, D-89): a landing that changed rules, decisions, releases or standing instructions,
 * with a reviewer on main, queues one review of the commit it put on main and starts the reviewer unless one is alive. The
 * reviewer runs the queued reviews one at a time, in queue order, and ends when none is left; only one runs per clone (the
 * `landed_reviewer` row), so the reviews of a busy morning never run side by side (D-83). A review left `running` by a
 * reviewer that died is run again by the next one, so a queued review is never dropped.
 */

/** What a landing found for the reviews after it: what they read, and main's reviewer (BR-2441). */
export interface ReviewNeeds {
  /** The rules, decisions, releases and domain READMEs it changed, as the review line names them. */
  readonly docs: readonly string[];
  /** The standing instructions it changed, by main's `instructions` (BR-2143). */
  readonly standing: readonly string[];
  /** `review` on main: undefined when unset. */
  readonly reviewer: string | undefined;
}

/** The environment variable that, set to 0, queues reviews without starting the reviewer (tests start it themselves). */
export const NO_START_ENV = "CANON_LANDED_REVIEWER";

export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  readonly id: number;
  readonly entry: number;
  readonly change: string | null;
  readonly base: string;
  readonly head: string;
  readonly landed: number;
  readonly log: string;
  readonly state: JobState;
}

const COLS = "id, entry, change, base, head, landed, log, state";

/**
 * After a landing moved main (BR-2441): queues the review of `head` against `base` and starts the reviewer, or, with no reviewer
 * on main, records that the documents landed unreviewed (`review.skip`) and says so; nothing when it changed nothing reviewed.
 */
export function queueLandedReview(ws: Workspace, say: Say, l: { entry: number; subject: string | null; base: string; head: string; landed: number }, needs: ReviewNeeds): Job | undefined {
  const docs = [...needs.docs, ...needs.standing];
  if (docs.length === 0) return undefined;
  if (needs.reviewer === undefined || needs.reviewer === REVIEW_NONE) {
    // reason: no reviewer no longer refuses the landing; it lands unreviewed and says so, and acceptance fails on it instead (D-89, D-51)
    ws.db.event(ws.actor, "review.skip", l.subject, { docs, landed: l.landed, reason: needs.reviewer === undefined ? "unconfigured" : "none" });
    if (needs.reviewer === REVIEW_NONE) say(`review: ${REVIEW_NONE} — ${docs.join(", ")} landed without a review`);
    else say([`review: not configured — ${docs.join(", ")} landed without a review: canon/config.yaml on main sets no \`review\`; acceptance fails until they are reviewed`, ...REVIEW_WAYS_OUT].join("\n"));
    return undefined;
  }
  const log = logFile(ws.db, `landed-review-${l.entry}-${l.landed}.log`);
  const id = Number(
    ws.db.db.query("INSERT INTO landed_reviews(entry, change, base, head, landed, log, state, queued_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)").run(l.entry, l.subject, l.base, l.head, l.landed, log, new Date().toISOString()).lastInsertRowid,
  );
  say(`review: ${docs.join(", ")} are reviewed after the landing, in the background (log: ${log})${l.subject ? `; canon work after-land --wait ${l.subject} reports it` : ""}`);
  ensureLandedReviewer(ws, say);
  return { id, entry: l.entry, change: l.subject, base: l.base, head: l.head, landed: l.landed, log, state: "queued" };
}

/**
 * `canon work review-landed --again <C-n>` (BR-2449): queues the review after the change's latest landing again when the one
 * queued for it failed, or when none was queued (a landing reviewed before D-89, or one whose review row is gone), and starts
 * the reviewer. The review reads base and head from that landing's `land.ok`; its log is a new one.
 */
export function requeueLandedReview(ws: Workspace, say: Say, change: string): Result<Job> {
  const landing = ws.db.db.query<{ id: number; detail: string }, [string]>("SELECT id, detail FROM events WHERE kind = 'land.ok' AND subject = ? ORDER BY id DESC LIMIT 1").get(change);
  if (!landing) return err("not_found", `${change} has no landing (no land.ok event): there is no landed commit to review`);
  const d = JSON.parse(landing.detail) as { sha?: unknown; base?: unknown };
  // reason: a land.ok recorded after an interruption knows no base, so what the landing changed cannot be told (BR-2309)
  if (typeof d.sha !== "string" || typeof d.base !== "string") return err("refused", `${change}'s latest landing (event ${landing.id}) records no base commit (recovered after an interruption, BR-2309), so what it changed cannot be reviewed`);
  const last = ws.db.db.query<Job, [number]>(`SELECT ${COLS} FROM landed_reviews WHERE landed = ? ORDER BY id DESC LIMIT 1`).get(landing.id);
  if (last && last.state !== "failed") return err("conflict", `the review after ${change}'s latest landing (event ${landing.id}) is ${last.state === "done" ? "done" : `${last.state} already`} (log: ${last.log}); only a failed or missing review is run again`);
  const entry = last?.entry ?? ws.db.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE subject = ? AND state = 'landed' ORDER BY id DESC LIMIT 1").get(change)?.id;
  if (entry === undefined) return err("not_found", `${change}'s latest landing (event ${landing.id}) has no landed queue entry to file its review under`);
  const n = ws.db.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM landed_reviews WHERE landed = ?").get(landing.id)!.n;
  const log = logFile(ws.db, `landed-review-${entry}-${landing.id}${n > 0 ? `-again-${n}` : ""}.log`);
  const id = Number(
    ws.db.db.query("INSERT INTO landed_reviews(entry, change, base, head, landed, log, state, queued_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)").run(entry, change, d.base, d.sha, landing.id, log, new Date().toISOString()).lastInsertRowid,
  );
  say(`review: the review after ${change}'s landing of ${d.sha.slice(0, 9)} on ${d.base.slice(0, 9)} is queued ${last ? "again after it failed" : "(none was queued for it)"} (log: ${log}); canon work after-land --wait ${change} reports it`);
  ensureLandedReviewer(ws, say);
  return ok({ id, entry, change, base: d.base, head: d.sha, landed: landing.id, log, state: "queued" });
}

interface ReviewerRow {
  readonly pid: number;
  readonly pid_start: string;
}

/** Whether a reviewer is recorded and its process is not provably gone (an unreadable process table counts as alive, D-11). */
export function liveLandedReviewer(db: CoordDb): boolean {
  const row = db.db.query<ReviewerRow, []>("SELECT pid, pid_start FROM landed_reviewer WHERE id = 1").get();
  return row !== null && isGone({ pid: row.pid, start: row.pid_start }) !== true;
}

const waiting = (db: CoordDb): boolean => db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM landed_reviews WHERE state IN ('queued', 'running')").get()!.n > 0;

/**
 * Starts `canon work review-landed` in the background when a review is queued (or left running by a reviewer that died) and no
 * reviewer is alive (BR-2441). Never waits for it. A reviewer that cannot be started fails the command that starts it.
 */
export function ensureLandedReviewer(ws: Workspace, say: Say): void {
  if (process.env[NO_START_ENV] === "0") return;
  if (!waiting(ws.db) || liveLandedReviewer(ws.db)) return;
  const log = logFile(ws.db, "landed-reviewer.log");
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    // reason: its own process group, so a signal to the landing or the session that started it does not stop the review (BR-2441)
    const p = Bun.spawn([...canonCommand(), "work", "review-landed"], { cwd: ws.primary, stdout: fd, stderr: fd, stdin: "ignore", detached: true, env: { ...(process.env as Record<string, string>) } });
    p.unref();
  } catch (e) {
    throw new Error(`cannot start \`canon work review-landed\` in the background: ${(e as Error).message}`);
  } finally {
    closeSync(fd);
  }
  say(`review: started the background reviewer (log: ${log})`);
}

/** Becomes the one reviewer, taking over from one whose process is gone; false while another is alive (BR-2441). */
function claimReviewer(db: CoordDb, self: Proc): boolean {
  return db.db
    .transaction(() => {
      const row = db.db.query<ReviewerRow, []>("SELECT pid, pid_start FROM landed_reviewer WHERE id = 1").get();
      if (row && !(row.pid === self.pid && row.pid_start === self.start) && isGone({ pid: row.pid, start: row.pid_start }) !== true) return false;
      db.db.query("INSERT OR REPLACE INTO landed_reviewer(id, pid, pid_start, started_at) VALUES (1, ?, ?, ?)").run(self.pid, self.start, new Date().toISOString());
      // reason: only the reviewer runs reviews, so one still `running` now was left by a reviewer that died: it runs again (BR-2441)
      db.db.query("UPDATE landed_reviews SET state = 'queued' WHERE state = 'running'").run();
      return true;
    })
    .immediate();
}

/**
 * The next queued review, marked running; or, when none is left, the reviewer's place given up in the same transaction, so
 * a review queued just after is seen either here or by the reviewer its landing starts (BR-2441).
 */
function nextOrRelease(db: CoordDb, self: Proc): Job | undefined {
  return db.db
    .transaction((): Job | undefined => {
      const job = db.db.query<Job, []>(`SELECT ${COLS} FROM landed_reviews WHERE state = 'queued' ORDER BY id LIMIT 1`).get();
      if (!job) {
        db.db.query("DELETE FROM landed_reviewer WHERE id = 1 AND pid = ? AND pid_start = ?").run(self.pid, self.start);
        return undefined;
      }
      db.db.query("UPDATE landed_reviews SET state = 'running' WHERE id = ?").run(job.id);
      return { ...job, state: "running" };
    })
    .immediate();
}

function finish(db: CoordDb, id: number, state: "done" | "failed"): void {
  db.db.query("UPDATE landed_reviews SET state = ?, finished_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
}

/**
 * `canon work review-landed` (BR-2441): unless another reviewer is alive, runs the queued reviews one at a time until none is
 * left. Each review writes its lines to its own log, which `canon work after-land` prints; one that cannot run is marked failed
 * with the reason (`review.fail`), never retried silently.
 */
export async function runLandedReviews(ws: Workspace, say: Say, guide: string | undefined): Promise<Result<number>> {
  const self = selfProcess();
  if (!self) return err("io", "cannot read this process's start time from ps, so this reviewer cannot record itself");
  if (!claimReviewer(ws.db, self)) {
    say("review: another reviewer is running the queued reviews");
    return ok(0);
  }
  const running: Running = {};
  let current: Job | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    running.review?.kill();
    if (running.reviewTree !== undefined) removeReviewTree(ws, running.reviewTree);
    if (running.readTree !== undefined) removeReviewTree(ws, running.readTree);
    // reason: the review it was running stays `running`; the next reviewer runs it again (BR-2441)
    if (current) appendFileSync(current.log, `review: stopped by ${signal}; the next reviewer runs it again\n`);
    ws.db.db.query("DELETE FROM landed_reviewer WHERE id = 1 AND pid = ? AND pid_start = ?").run(self.pid, self.start);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  let n = 0;
  try {
    for (;;) {
      current = nextOrRelease(ws.db, self);
      if (!current) return ok(n);
      const job = current;
      mkdirSync(dirname(job.log), { recursive: true });
      const line = (text: string) => {
        appendFileSync(job.log, `${text}\n`);
        say(text);
      };
      line(`review of ${job.change ?? job.head.slice(0, 9)}: landed ${job.head.slice(0, 9)} on ${job.base.slice(0, 9)}`);
      let r: Result<void>;
      try {
        r = await reviewLanded(ws, job, line, guide, running);
      } catch (e) {
        r = err("io", (e as Error).message);
      }
      if (r.ok) {
        finish(ws.db, job.id, "done");
        line("review: done");
      } else {
        ws.db.event(ws.actor, "review.fail", job.change, { landed: job.landed, commit: job.head, message: r.error.message.slice(0, 2000) });
        finish(ws.db, job.id, "failed");
        line(`review: could not run: ${r.error.message}`);
      }
      n++;
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/**
 * The landed review `canon work after-land` reports (BR-2166): by job id, else the one of queue entry `entry`, else the
 * latest of `change` (or of all); with its log's lines.
 */
export function landedReview(db: CoordDb, by: { id?: number; entry?: number; change?: string }): (Job & { lines: string[] }) | undefined {
  const job =
    by.id !== undefined
      ? db.db.query<Job, [number]>(`SELECT ${COLS} FROM landed_reviews WHERE id = ?`).get(by.id)
      : by.entry !== undefined
        ? db.db.query<Job, [number]>(`SELECT ${COLS} FROM landed_reviews WHERE entry = ? ORDER BY id DESC LIMIT 1`).get(by.entry)
        : db.db.query<Job, [string | null]>(`SELECT ${COLS} FROM landed_reviews WHERE (?1 IS NULL OR change = ?1) ORDER BY entry DESC, id DESC LIMIT 1`).get(by.change ?? null);
  if (!job) return undefined;
  const lines = existsSync(job.log) ? readFileSync(job.log, "utf8").trimEnd().split("\n").filter((l) => l !== "") : [];
  return { ...job, lines };
}

/** The job as it is now, by id. */
export function jobState(db: CoordDb, id: number): JobState | undefined {
  return db.db.query<{ state: JobState }, [number]>("SELECT state FROM landed_reviews WHERE id = ?").get(id)?.state;
}
