#!/usr/bin/env bun
/**
 * canon's release, run from `hooks.after_green` in a checkout of the tested commit (D-31, BR-2222, D-91):
 *   1. the release check: every shipped canon-* SKILL.md and the workflow guide, reviewed together for duplication (BR-2411);
 *      the same texts are reviewed once, a later run reuses the recorded findings; a duplicate is printed as a note and never
 *      stops publishing (D-139), and a publish records its commit and guide as the next baseline (`release.published`);
 *   2. publishes `dist/canon` and `dist/skills` into the primary checkout from this commit (BR-2412).
 *   A setup problem (no review command, an unreadable skill, a failing review command) publishes nothing and exits 4.
 *
 * Environment: CANON_GREEN and CANON_PRIMARY (set by canon for after_green),
 * CANON_RELEASE_BUILD=fake (tests: write a stand-in file instead of compiling canon).
 * `--check`: only the release check, in the current checkout; prints the findings as notes; publishes nothing.
 * Exit codes: 0 checked or published (or a newer release is already there), 2 usage, 4 environment (review command, git, build).
 */
import { buildDefine } from "../src/kernel/build.ts";
import { writeFileSync } from "node:fs";
import { openWorkspace } from "../src/work/workspace.ts";
import { git } from "../src/kernel/git.ts";
import { err, ok, type Result } from "../src/kernel/result.ts";
import { reviewSettingsOn } from "../src/work/land/checks/review-scope.ts";
import { WORKFLOW_GUIDE } from "../src/invocation/guide.ts";
import { loadBaseline, releaseCheck, shippedTexts, type EarlierVerdict } from "../src/knowledge/review/release-review.ts";
import { publishRelease } from "../src/install/publish.ts";
import { logFile } from "../src/work/hooks/hooks.ts";

function say(line: string): void {
  console.log(`release: ${line}`);
}
function fail(code: number, message: string): never {
  console.error(`release: ${message}`);
  process.exit(code);
}

const checkOnly = process.argv.includes("--check");
const cwd = process.cwd();
let green = process.env["CANON_GREEN"] ?? "";
const primary = process.env["CANON_PRIMARY"] ?? "";
if (checkOnly) {
  const head = git(cwd, "rev-parse", "HEAD");
  if (!head.ok) fail(4, head.error.message);
  green = head.value;
} else if (green === "" || primary === "") fail(2, "CANON_GREEN and CANON_PRIMARY are required (run it as an after_green hook), or pass --check");

const ws = openWorkspace(checkOnly ? cwd : primary);
if (!ws.ok) fail(4, ws.error.message);
const w = ws.value;
const settings = reviewSettingsOn(cwd, "HEAD");
if (!settings.ok) fail(2, settings.error.message);
const s = settings.value;
const reviewer = s.review;
// reason: with no reviewer the check cannot run, and an unchecked release is what reached projects in #159 and #182; fail loud (BR-2411)
if (reviewer === undefined || reviewer === "none") fail(4, "canon/config.yaml sets no `review` command; the release check cannot run and nothing is published");

const KIND = "release.review";
function earlier(hash: string): EarlierVerdict | undefined {
  const row = w.db.db.query<{ detail: string }, [string, string]>("SELECT detail FROM events WHERE kind = ? AND json_extract(detail, '$.hash') = ? ORDER BY id DESC LIMIT 1").get(KIND, hash);
  if (!row) return undefined;
  const d = JSON.parse(row.detail) as { findings?: string[] };
  // reason: a verdict recorded when a duplicate still blocked is not a block now (D-139), so only its findings are reused
  return { findings: d.findings ?? [] };
}
const PUBLISHED = "release.published";
// reason: the last release is the baseline: a duplicate lying wholly in text it already shipped is marked `(already released) ` (D-107, BR-2411)
const baseline = loadBaseline(cwd, checkOnly ? w.primary : primary, shippedTexts(cwd), (commit) => {
  const row = w.db.db.query<{ detail: string }, [string, string]>("SELECT detail FROM events WHERE kind = ? AND json_extract(detail, '$.commit') = ? ORDER BY id DESC LIMIT 1").get(PUBLISHED, commit);
  return row ? (JSON.parse(row.detail) as { guide?: string }).guide : undefined;
});
if (!baseline.ok) fail(4, `the release check could not run: ${baseline.error.message}; nothing is published`);
if (baseline.value) say(`baseline: the release ${baseline.value.commit.slice(0, 9)}${baseline.value.guide === undefined ? " (it recorded no guide: the whole guide counts as changed)" : ""}`);
else say("baseline: none (nothing was released yet): every line counts as changed");
const check = await releaseCheck({
  cwd,
  reviewer,
  limits: { timeoutMs: s.reviewTimeoutMs, kind: "release", keep: logFile(w.db, `release-review-${green.slice(0, 12)}`) },
  budgetBytes: s.reviewMaxPromptBytes,
  parallel: s.reviewParallel,
  guide: WORKFLOW_GUIDE,
  baseline: baseline.value,
  earlier,
  record: (hash, v) => w.db.event(w.actor, KIND, null, { hash, verdict: v.verdict, findings: v.findings, commit: green }),
});
if (!check.ok) fail(4, `the release check could not run: ${check.error.message}; nothing is published`);
const c = check.value;
say(`check ok${c.unchanged ? ` (the same texts as the release ${baseline.value?.commit.slice(0, 9)}: nothing changed, the review command did not run)` : c.reused ? " (these texts were checked before: findings reused, the review command did not run)" : ` (${c.calls} call(s))`}`);
// reason: a duplicate in the shipped texts is a quality reminder, never a reason to keep the old release (D-139)
for (const f of c.findings) say(`note: ${f}`);
if (checkOnly) process.exit(0);

function build(outfile: string): Result<void> {
  if (process.env["CANON_RELEASE_BUILD"] === "fake") {
    writeFileSync(outfile, `fake canon ${green}\n`);
    return ok(undefined);
  }
  // reason: the published commit is embedded, so every event the binary writes says which canon wrote it (BR-2475, D-116)
  const r = Bun.spawnSync(["bun", "build", "--compile", ...buildDefine(green), "src/invocation/main.ts", "--outfile", outfile], { cwd, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? ok(undefined) : err("io", `bun build exited ${r.exitCode}: ${r.stderr.toString().trim().slice(0, 500)}`);
}
const published = publishRelease({ primary, cwd, green, build });
if (!published.ok) fail(4, `${published.error.message}; nothing is published`);
if (published.value.kind === "older") say(`${published.value.published.slice(0, 9)} is already published and is newer; nothing to do`);
else {
  w.db.event(w.actor, PUBLISHED, null, { commit: green, guide: WORKFLOW_GUIDE });
  say(`published dist/canon and dist/skills from ${green.slice(0, 9)}`);
}
