#!/usr/bin/env bun
/**
 * Post-land consistency check for `hooks.after_land` (C-54, D-43): do the tests cover both sides of each rule's
 * examples, and does the code do what the rules say? Not enabled by default: every run is an AI call per domain
 * and it writes to GitHub. To enable, add to canon/config.yaml:
 *
 *   hooks:
 *     after_land:
 *       - "bun scripts/consistency-review.ts --max-domains 1"
 *
 * Options: --max-domains <n> (default 1), --max-bytes <n> (default 150000), --min-closed <n> (default 10),
 * --min-precision <0..1> (default 0.5), --precision (print the precision and exit).
 * Environment: CANON_BASE and CANON_HEAD (set by canon), CANON_CHANGE (optional),
 * CANON_CONSISTENCY_AI (default `claude -p --output-format text`), CANON_GH (default `gh`).
 */
import { consistencyReview, DEFAULT_LIMITS, precision, type Limits } from "../src/knowledge/review/consistency.ts";

// reason: every line starts with `code-review:` so canon work after-land copies it like the code review's (BR-2166, D-43)
const PREFIX = "code-review: consistency:";
const usage = (message: string): never => {
  console.error(`${PREFIX} ${message}`);
  process.exit(2);
};

const limits: { -readonly [K in keyof Limits]: Limits[K] } = { ...DEFAULT_LIMITS };
let onlyPrecision = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--precision") {
    onlyPrecision = true;
    continue;
  }
  const value = args[i + 1];
  const whole = (name: string) => {
    const n = Number(value);
    if (value === undefined || !Number.isInteger(n) || n <= 0) usage(`${name} must be a whole number greater than 0`);
    i++;
    return n;
  };
  if (a === "--max-domains") limits.maxDomains = whole(a);
  else if (a === "--max-bytes") limits.maxBytes = whole(a);
  else if (a === "--min-closed") limits.minClosed = whole(a);
  else if (a === "--min-precision") {
    const n = Number(value);
    if (value === undefined || value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) usage("--min-precision must be a number from 0 to 1");
    limits.minPrecision = n;
    i++;
  } else usage(`unknown argument ${a} (known: --max-domains, --max-bytes, --min-closed, --min-precision, --precision)`);
}

const env = {
  cwd: process.cwd(),
  base: process.env["CANON_BASE"] ?? "",
  head: process.env["CANON_HEAD"] ?? "",
  change: process.env["CANON_CHANGE"] ?? "",
  ai: process.env["CANON_CONSISTENCY_AI"] || "claude -p --output-format text",
  gh: process.env["CANON_GH"] || "gh",
  say: (line: string) => console.log(`${PREFIX} ${line}`),
};

if (onlyPrecision) {
  const p = precision(env);
  if (!p.ok) {
    console.error(`${PREFIX} ${p.error.message}`);
    process.exit(1);
  }
  env.say(`precision ${p.value.completed}/${p.value.closed}, ${p.value.open} open`);
  process.exit(0);
}
if (!env.base || !env.head) usage("CANON_BASE and CANON_HEAD are required (run it as an after_land hook)");
const r = consistencyReview(env, limits);
if (!r.ok) {
  console.error(`${PREFIX} ${r.error.message}`);
  process.exit(1);
}
