#!/usr/bin/env bun
/**
 * Post-land code review for `hooks.after_land` (C-2). Not enabled by default: it writes to GitHub.
 * To enable, add to canon/config.yaml:
 *
 *   hooks:
 *     after_land:
 *       - "bun run build"
 *       - "bun scripts/code-review.ts"
 *
 * It reviews in batches (D-59, BR-2314): the landings since refs/canon/code-reviewed wait until `review_max_unreviewed`
 * are in or the oldest is `review_max_age_minutes` old, then one review covers them all.
 *
 * Environment: CANON_BASE and CANON_HEAD (set by canon), CANON_CHANGE (unused, the batch names its changes),
 * CANON_CODE_REVIEW_AI (default `claude -p --output-format text`), CANON_GH (default `gh`),
 * CANON_CODE_REVIEW_FORCE=1 (review everything waiting now; CANON_BASE and CANON_HEAD then default to the reviewed
 * ref and main's tip), CANON_CODE_REVIEW_WAITER=0 (a deferred review starts no background wait), CANON_NOW (an ISO
 * date replacing the clock, for tests).
 *
 * A deferred review starts this script with `--wait` in the background (D-68): it sleeps until the batch is due,
 * reviews it and ends, so the last landings of a session are reviewed on time with no later landing to trigger it.
 */
import { openWorkspace } from "../src/work/workspace.ts";
import { git } from "../src/kernel/git.ts";
import { landedEvents, readReviewedRef, reviewBatch, startReviewWaiter, waitThenReview } from "../src/knowledge/review/code-review-batch.ts";

const force = process.env["CANON_CODE_REVIEW_FORCE"] === "1";
const ws = openWorkspace(process.cwd());
if (!ws.ok) {
  console.error(`code-review: ${ws.error.message}`);
  process.exit(1);
}
const ai = process.env["CANON_CODE_REVIEW_AI"] || "claude -p --output-format text";
const gh = process.env["CANON_GH"] || "gh";
const limits = { maxUnreviewed: ws.value.config.reviewMaxUnreviewed, maxAgeMs: ws.value.config.reviewMaxAgeMs };
const say = (line: string) => console.log(`code-review: ${line}`);
if (process.argv.includes("--wait")) {
  const w = await waitThenReview({ cwd: ws.value.primary, db: ws.value.db, main: ws.value.config.main, ai, gh, limits, say, sleep: (ms) => Bun.sleep(Math.max(ms, 0)) });
  if (!w.ok) {
    console.error(`code-review: ${w.error.message}`);
    process.exit(1);
  }
  process.exit(0);
}
const tip = git(ws.value.primary, "rev-parse", "--verify", `refs/heads/${ws.value.config.main}`);
const base = process.env["CANON_BASE"] || (force ? (readReviewedRef(ws.value.primary) ?? undefined) : undefined);
const head = process.env["CANON_HEAD"] || (force && tip.ok ? tip.value : undefined);
if (!head || (!base && !force)) {
  console.error("code-review: CANON_BASE and CANON_HEAD are required (run it as an after_land hook)");
  process.exit(2);
}
const r = await reviewBatch({
  cwd: ws.value.primary,
  db: ws.value.db,
  base,
  head,
  ai,
  gh,
  landed: landedEvents(ws.value.db),
  limits,
  force,
  noWait: process.env["CANON_CODE_REVIEW_NOWAIT"] === "1",
  say,
  onDeferred: () => {
    if (process.env["CANON_CODE_REVIEW_WAITER"] !== "0") startReviewWaiter(ws.value, [process.execPath, import.meta.path, "--wait"], say);
  },
});
if (!r.ok) {
  console.error(`code-review: ${r.error.message}`);
  process.exit(1);
}
