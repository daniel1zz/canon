import type { Workspace } from "../workspace.ts";
import { batchState, renderAfterLand, settleBackgroundHooks, type BackgroundBatch, type BatchState } from "./hooks.ts";
import { ensureLandedReviewer, landedReview, type Job } from "../../knowledge/review/landed-queue.ts";
import { CLEAN_DONE, latestCleanup, readCleanAfterLanding } from "../session/clean-after-land.ts";

/**
 * What `canon work after-land` reports for one landing (BR-2166, BR-2441): its background after_land commands and the review
 * of the commit it put on main. The review is the one of the same landing (queue entry) as the batch; a project with no
 * after_land commands gets the latest review of the change (or of all).
 */
export interface AfterLand {
  readonly batch: BackgroundBatch | undefined;
  readonly review: (Job & { readonly lines: readonly string[] }) | undefined;
  /** The removal of the landed worktree started by land --finish (BR-2486), when one was started. */
  readonly clean?: ReturnType<typeof readCleanAfterLanding>;
}

export function readAfterLand(ws: Workspace, change: string | undefined, log?: string, job?: number): AfterLand {
  const batch = settleBackgroundHooks(ws.db, ws.actor, change, log);
  const review = job !== undefined ? landedReview(ws.db, { id: job }) : batch ? (batch.entry !== null ? landedReview(ws.db, { entry: batch.entry }) : undefined) : landedReview(ws.db, change !== undefined ? { change } : {});
  // reason: a landing with no after_land commands and no review still has its worktree removal to report (BR-2486)
  const subject = change ?? batch?.change ?? review?.change ?? latestCleanup(ws.db);
  const clean = subject ? readCleanAfterLanding(ws.db, subject) : undefined;
  return { batch, review, ...(clean ? { clean } : {}) };
}

const reviewState = (j: Job): BatchState => (j.state === "done" ? "ok" : j.state === "failed" ? "failed" : "running");

/** One failure fails the whole; then a missing log; then anything still running or queued (BR-2166). */
export function afterLandState(r: AfterLand): BatchState {
  const states = [...(r.batch ? [batchState(r.batch)] : []), ...(r.review ? [reviewState(r.review)] : []), ...(r.clean && !r.clean.done ? ["running" as const] : [])];
  for (const s of ["failed", "unknown", "running"] as const) if (states.includes(s)) return s;
  return "ok";
}

/**
 * Reads until the batch's commands and the review have all finished, the log is gone or `timeoutMs` passes (BR-2167). It
 * stays on what it read first, and starts the reviewer when a review waits with none alive, so a queued review is never left
 * behind (BR-2441).
 */
export async function waitAfterLand(ws: Workspace, change: string | undefined, timeoutMs: number, pollMs = 1000): Promise<AfterLand> {
  const deadline = Date.now() + timeoutMs;
  let log: string | undefined;
  let job: number | undefined;
  for (;;) {
    const r = readAfterLand(ws, change, log, job);
    log = r.batch?.log;
    job = r.review?.id;
    if (r.review && reviewState(r.review) === "running") ensureLandedReviewer(ws, () => {});
    const batchDone = !r.batch || !r.batch.logFound || r.batch.commands.every((c) => c.exit !== null);
    const reviewDone = !r.review || reviewState(r.review) !== "running";
    const cleanDone = !r.clean || r.clean.done;
    if ((batchDone && reviewDone && cleanDone) || Date.now() >= deadline) return r;
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** The batch's report (BR-2166), then the review's state and its log's lines (BR-2441). */
export function renderAfterLandAll(r: AfterLand): string {
  const out: string[] = [];
  if (r.batch) out.push(renderAfterLand(r.batch));
  if (r.review) {
    const what = { queued: "queued, not started yet", running: "running", done: "finished", failed: "could not run" }[r.review.state];
    out.push(`review after the landing${r.review.change ? ` of ${r.review.change}` : ""} (log: ${r.review.log}): ${what}`, ...r.review.lines.map((l) => `  ${l}`));
  }
  if (r.clean) out.push(`removal of the landed worktree (log: ${r.clean.log}): ${r.clean.done ? "finished" : "running"}`, ...r.clean.lines.filter((l) => l !== CLEAN_DONE).map((l) => `  ${l}`));
  return out.join("\n");
}
