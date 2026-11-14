#!/usr/bin/env bun
/**
 * canon's release, run from `hooks.after_green` in a checkout of the tested commit (D-31, BR-2222, D-91):
 *   1. the release check: every shipped canon-* SKILL.md and the workflow guide, reviewed together for duplication (BR-2411);
 *      the same texts are reviewed once, a later run reuses the recorded verdict; only a duplicate touching text changed since
 *      the last release blocks (D-107), and a publish records its commit and guide as the next baseline (`release.published`);
 *   2. on ok, publishes `dist/canon` and `dist/skills` into the primary checkout from this commit (BR-2412);
 *   on block, publishes nothing, prints the findings, names them on GitHub (one open `canon-review` issue) and exits 1.
 *
 * Environment: CANON_GREEN and CANON_PRIMARY (set by canon for after_green), CANON_GH (default `gh`),
 * CANON_RELEASE_BUILD=fake (tests: write a stand-in file instead of compiling canon).
 * `--check`: only the release check, in the current checkout; prints the verdict, exits 1 on block; publishes and files nothing.
 * Exit codes: 0 published (or a newer release is already there), 1 blocked, 2 usage, 4 environment (review command, git, gh, build).
 */
import { buildDefine } from "../src/kernel/build.ts";
import { writeFileSync } from "node:fs";
import { openWorkspace } from "../src/work/workspace.ts";
import { git } from "../src/kernel/git.ts";
import { err, ok, type Result } from "../src/kernel/result.ts";
import { reviewSettingsOn } from "../src/work/land/checks/review-scope.ts";
import { WORKFLOW_GUIDE } from "../src/invocation/guide.ts";
import { loadBaseline, releaseCheck, reportBlock, shippedTexts, type EarlierVerdict } from "../src/knowledge/review/release-review.ts";
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
  const d = JSON.parse(row.detail) as { verdict: "ok" | "block"; findings: string[] };
  return { verdict: d.verdict, findings: d.findings };
}
const PUBLISHED = "release.published";
// reason: the last release is the baseline: only a duplicate touching text changed since then blocks (D-107, BR-2411)
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
say(`check ${c.verdict}${c.unchanged ? ` (the same texts as the release ${baseline.value?.commit.slice(0, 9)}: nothing changed, the review command did not run)` : c.reused ? " (these texts were checked before: verdict reused, the review command did not run)" : ` (${c.calls} call(s))`}`);
if (c.verdict === "ok") for (const f of c.findings) say(`note: ${f}`);
if (c.verdict === "block") {
  console.error(`release: blocked, nothing published; dist/ keeps the previous release. Shipped texts repeat a requirement:\n${c.findings.map((f) => `  - ${f}`).join("\n")}`);
  // reason: a reused block was named when it was first found; naming it again on every green run would only add noise (BR-2411)
  if (!checkOnly && !c.reused) {
    const named = reportBlock(cwd, process.env["CANON_GH"] || "gh", green, c.findings);
    if (!named.ok) fail(4, `blocked, and naming it on GitHub failed: ${named.error.message}`);
    console.error(`release: findings filed on ${named.value}`);
  }
  process.exit(1);
}
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
