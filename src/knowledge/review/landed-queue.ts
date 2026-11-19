import { git } from "../../kernel/git.ts";
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
import { SKILL_FILE, Slots } from "./review.ts";
import { standingInstructions } from "../../kernel/agent.ts";
import { reviewSettingsOn } from "../../work/land/checks/review-scope.ts";
import { corpusOf } from "../../work/session/session.ts";
import { reviewedBy, reviewedKeys } from "../links/reviewed.ts";

/**
 * The queue of landed reviews (BR-2441, D-89): a landing that changed rules, decisions, releases or standing instructions,
 * with a reviewer on main, queues one review of the commit it put on main and starts the reviewer unless one is alive. The
 * reviewer runs the queued reviews in queue order, up to `landed_review_parallel` at once with their calls within
 * `review_parallel`, reviews of the same files one after another (BR-2487, D-121), and ends when none is left; only one
 * reviewer runs per clone (the `landed_reviewer` row). A review left `running` by a reviewer that died is run again by the
 * next one, so a queued review is never dropped.
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
  /** The main commit whose review command runs this review; null: the landing's base (BR-2074), set only by --again (BR-2449). */
  readonly reviewer: string | null;
}

const COLS = "id, entry, change, base, head, landed, log, state, reviewer";

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
  return { id, entry: l.entry, change: l.subject, base: l.base, head: l.head, landed: l.landed, log, state: "queued", reviewer: null };
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
  // reason: the reviewer is infrastructure, not part of the change judged: a rerun after a failure uses main's current review
  // command, so one fixed since the landing can review it; the documents still come from the landing (BR-2449, #215)
  const now = git(ws.primary, "rev-parse", "--verify", `${ws.config.main}^{commit}`);
  if (!now.ok) return err("io", `main (${ws.config.main}) cannot be read for its review command: ${now.error.message}`);
  const id = Number(
    ws.db.db.query("INSERT INTO landed_reviews(entry, change, base, head, landed, log, state, queued_at, reviewer) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)").run(entry, change, d.base, d.sha, landing.id, log, new Date().toISOString(), now.value).lastInsertRowid,
  );
  say(`review: the review after ${change}'s landing of ${d.sha.slice(0, 9)} on ${d.base.slice(0, 9)} is queued ${last ? "again after it failed" : "(none was queued for it)"}, with main's review command at ${now.value.slice(0, 9)} (log: ${log}); canon work after-land --wait ${change} reports it`);
  ensureLandedReviewer(ws, say);
  return ok({ id, entry, change, base: d.base, head: d.sha, landed: landing.id, log, state: "queued", reviewer: now.value });
}

interface ReviewerRow {
  readonly pid: number;
  readonly pid_start: string;
}

/** Whether a reviewer is recorded and its process is not provably gone (an unreadable process table counts as alive, D-11). */
/** One line per failed landed review not superseded by a later done one of the same head, with the way out (BR-2449, #196). */
export function failedReviewNotice(db: CoordDb): string[] {
  const rows = db.db.query<{ change: string | null; head: string; state: string; log: string }, []>("SELECT change, head, state, log FROM landed_reviews").all();
  const done = new Set(rows.filter((r) => r.state === "done").map((r) => r.head));
  return rows
    .filter((r) => r.state === "failed" && !done.has(r.head))
    .map((r) => `main: the review after the landing of ${r.change ?? r.head.slice(0, 9)} failed (log: ${r.log}): canon work review-landed --again ${r.change ?? "<C-n>"}`);
}

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

/** The paths a landed review reads that another review may write findings about: what it changed under canon/ and in the standing instructions (BR-2487). */
function pathsOf(ws: Workspace, job: Job, standing: readonly string[]): ReadonlySet<string> {
  const diff = git(ws.primary, "diff", "--name-only", "--no-renames", job.base, job.head);
  // reason: when the diff cannot be read, the review overlaps everything, so it keeps queue order with every other (BR-2487)
  if (!diff.ok) return new Set(["*"]);
  // reason: every file the duplicate review reads counts, as standingTouched picks them: the configured instructions, the root
  // instruction files (AGENTS.md and the rest) and every SKILL.md (BR-2143, BR-2487, #230)
  const reviewed = new Set(standingInstructions(standing));
  return new Set(diff.value.split("\n").filter((p) => p !== "" && (p.startsWith("canon/") || reviewed.has(p) || SKILL_FILE.test(p))));
}

const overlaps = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.has("*") || b.has("*") || [...a].some((p) => b.has(p));

/**
 * The next queued review that may start now, marked running: the first in queue order that shares no path with an earlier
 * review still queued or running (BR-2487). With none queued and none running here, the reviewer's place is given up in the
 * same transaction, so a review queued just after is seen either here or by the reviewer its landing starts (BR-2441).
 */
function nextOrRelease(db: CoordDb, self: Proc, active: number, paths: (job: Job) => ReadonlySet<string>): Job | "wait" | undefined {
  return db.db
    .transaction((): Job | "wait" | undefined => {
      // reason: only this reviewer runs reviews, so with none running here one still `running` was left by a reviewer that died (BR-2441)
      if (active === 0) db.db.query("UPDATE landed_reviews SET state = 'queued' WHERE state = 'running'").run();
      const open = db.db.query<Job, []>(`SELECT ${COLS} FROM landed_reviews WHERE state IN ('queued', 'running') ORDER BY id`).all();
      if (open.length === 0 && active === 0) {
        db.db.query("DELETE FROM landed_reviewer WHERE id = 1 AND pid = ? AND pid_start = ?").run(self.pid, self.start);
        return undefined;
      }
      const before: ReadonlySet<string>[] = [];
      for (const job of open) {
        const mine = paths(job);
        if (job.state === "queued" && !before.some((p) => overlaps(p, mine))) {
          db.db.query("UPDATE landed_reviews SET state = 'running' WHERE id = ?").run(job.id);
          return { ...job, state: "running" };
        }
        before.push(mine);
      }
      return "wait";
    })
    .immediate();
}

/** Writes the `link.reviewed` records one finished review implies, skipping those already there (BR-2539); returns how many it wrote. */
function recordReviewed(ws: Workspace, base: string, head: string, sameTop: boolean): number {
  const before = corpusOf(ws, base);
  if (!before.ok) throw new Error(before.error.message);
  const after = corpusOf(ws, head);
  if (!after.ok) throw new Error(after.error.message);
  const have = reviewedKeys(ws.primary);
  let n = 0;
  for (const r of reviewedBy(before.value, after.value, sameTop)) {
    if (have.has(`${r.from}>${r.to}>${r.fingerprint}`)) continue;
    ws.db.event(ws.actor, "link.reviewed", r.from, { ...r, head });
    n++;
  }
  return n;
}

/**
 * Once per repository: the references the reviews finished before BR-2539 imply. Those reviews gave the changed rule's
 * whole top-level domain, so only referrers that are rules in that domain count (BR-2539). Undefined when already done.
 */
function backfillReviewed(ws: Workspace): number | undefined {
  if (ws.db.db.query("SELECT 1 FROM events WHERE kind = 'link.reviewed.backfill' LIMIT 1").get()) return undefined;
  const rows = ws.db.db.query<{ base: string; head: string }, []>("SELECT base, head FROM landed_reviews WHERE state = 'done' ORDER BY id").all();
  let n = 0;
  for (const r of rows) n += recordReviewed(ws, r.base, r.head, true);
  ws.db.event(ws.actor, "link.reviewed.backfill", null, { reviews: rows.length, references: n });
  return n;
}

function finish(db: CoordDb, id: number, state: "done" | "failed"): void {
  db.db.query("UPDATE landed_reviews SET state = ?, finished_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
}

/** How many reviews run at once and how many calls they share, from main's canon/config.yaml; 1 and 1 when it cannot be read. */
function concurrency(ws: Workspace): { reviews: number; calls: number; standing: readonly string[] } {
  const s = reviewSettingsOn(ws.primary, ws.config.main);
  // reason: a config that cannot be read fails each review with its reason (reviewLanded); here it only falls back to running them one at a time (BR-2487)
  return s.ok ? { reviews: s.value.landedReviewParallel, calls: s.value.reviewParallel, standing: s.value.instructions } : { reviews: 1, calls: 1, standing: [] };
}

/**
 * `canon work review-landed` (BR-2441, BR-2487): unless another reviewer is alive, runs the queued reviews until none is
 * left, up to `landed_review_parallel` at once (read from main before each start), their calls together within
 * `review_parallel`; a review starts only when no earlier review still queued or running shares a path with it. Each review
 * writes its lines to its own log, which `canon work after-land` prints; one that cannot run is marked failed with the reason
 * (`review.fail`), never retried silently.
 */
export async function runLandedReviews(ws: Workspace, say: Say, guide: string | undefined): Promise<Result<number>> {
  const self = selfProcess();
  if (!self) return err("io", "cannot read this process's start time from ps, so this reviewer cannot record itself");
  if (!claimReviewer(ws.db, self)) {
    say("review: another reviewer is running the queued reviews");
    return ok(0);
  }
  const active = new Map<number, { job: Job; running: Running; done: Promise<void> }>();
  const onSignal = (signal: NodeJS.Signals) => {
    for (const { job, running } of active.values()) {
      running.review?.kill();
      if (running.reviewTree !== undefined) removeReviewTree(ws, running.reviewTree);
      if (running.readTree !== undefined) removeReviewTree(ws, running.readTree);
      // reason: the review it was running stays `running`; the next reviewer runs it again (BR-2441)
      appendFileSync(job.log, `review: stopped by ${signal}; the next reviewer runs it again\n`);
    }
    ws.db.db.query("DELETE FROM landed_reviewer WHERE id = 1 AND pid = ? AND pid_start = ?").run(self.pid, self.start);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const pathCache = new Map<number, ReadonlySet<string>>();
  let n = 0;
  let { reviews, calls, standing } = concurrency(ws);
  const slots = new Slots(calls);
  const runOne = async (job: Job, running: Running): Promise<void> => {
    mkdirSync(dirname(job.log), { recursive: true });
    const line = (text: string) => {
      appendFileSync(job.log, `${text}\n`);
      // reason: reviews running at once write to one reviewer log, so each line says whose it is (BR-2487)
      say(reviews > 1 ? `[${job.change ?? job.head.slice(0, 9)}] ${text}` : text);
    };
    line(`review of ${job.change ?? job.head.slice(0, 9)}: landed ${job.head.slice(0, 9)} on ${job.base.slice(0, 9)}`);
    let r: Result<void>;
    try {
      r = await reviewLanded(ws, job, line, guide, running, slots);
    } catch (e) {
      r = err("io", (e as Error).message);
    }
    if (r.ok) {
      // reason: the finished review saw every live document naming what this landing changed, so those references count as reviewed (BR-2539);
      // written before the row is done, since canon work after-land prints the log as soon as it is
      try {
        const n = recordReviewed(ws, job.base, job.head, false);
        if (n > 0) line(`review: ${n} reference(s) to the changed documents recorded as reviewed`);
        const back = backfillReviewed(ws);
        if (back !== undefined) line(`review: ${back} reference(s) recorded as reviewed from the earlier finished reviews (once)`);
      } catch (e) {
        line(`review: references not recorded as reviewed: ${(e as Error).message}`);
      }
      line("review: done");
      finish(ws.db, job.id, "done");
    } else {
      ws.db.event(ws.actor, "review.fail", job.change, { landed: job.landed, commit: job.head, message: r.error.message.slice(0, 2000) });
      finish(ws.db, job.id, "failed");
      line(`review: could not run: ${r.error.message}`);
    }
    n++;
  };
  try {
    for (;;) {
      ({ reviews, calls, standing } = concurrency(ws));
      slots.resize(calls);
      let next: Job | "wait" | undefined = "wait";
      while (active.size < reviews) {
        next = nextOrRelease(ws.db, self, active.size, (job) => {
          let p = pathCache.get(job.id);
          if (!p) pathCache.set(job.id, (p = pathsOf(ws, job, standing)));
          return p;
        });
        if (next === undefined || next === "wait") break;
        const job = next;
        const running: Running = {};
        const done = runOne(job, running).finally(() => active.delete(job.id));
        active.set(job.id, { job, running, done });
      }
      if (next === undefined && active.size === 0) return ok(n);
      // reason: with nothing running here every open review is queued, and the first of them always may start (BR-2487)
      if (active.size === 0) throw new Error("the landed review queue has open reviews but none could start; this is a canon bug");
      await Promise.race([...active.values()].map((a) => a.done));
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
