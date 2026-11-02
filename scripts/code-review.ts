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
 * Environment: CANON_BASE and CANON_HEAD (set by canon), CANON_CHANGE (optional),
 * CANON_CODE_REVIEW_AI (default `claude -p --output-format text`), CANON_GH (default `gh`).
 */
import { codeReview } from "../src/review/code-review.ts";

const base = process.env["CANON_BASE"];
const head = process.env["CANON_HEAD"];
if (!base || !head) {
  console.error("code-review: CANON_BASE and CANON_HEAD are required (run it as an after_land hook)");
  process.exit(2);
}
const r = codeReview({
  cwd: process.cwd(),
  base,
  head,
  change: process.env["CANON_CHANGE"] ?? "",
  ai: process.env["CANON_CODE_REVIEW_AI"] || "claude -p --output-format text",
  gh: process.env["CANON_GH"] || "gh",
  say: (line) => console.log(`code-review: ${line}`),
});
if (!r.ok) {
  console.error(`code-review: ${r.error.message}`);
  process.exit(1);
}
