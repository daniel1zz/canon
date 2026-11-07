import { git } from "../../../kernel/git.ts";
import type { Say, Workspace } from "../../workspace.ts";
import { changeIdsOnBranches } from "../../session/inflight.ts";
import { readConfig } from "../../../invocation/config.ts";
import { backlogNotes, check, noteLine, staleReportNotes, type Finding } from "../../../knowledge/check/check.ts";
import { reportsFor } from "../../verify/changes.ts";
import { backlogAt } from "../../../knowledge/documents/backlog.ts";
import { httpFetch, OPTIONS_SECTION, sources, verify, type Fetcher } from "../../../knowledge/check/sources.ts";
import { testFilesFor } from "../../../knowledge/check/tests.ts";
import { runHooks } from "../../hooks/hooks.ts";
import { changePort } from "../../hooks/ports.ts";
import { type Doc } from "../../../knowledge/documents/model.ts";
import { findDoc } from "../../../knowledge/query/query.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { reviewPrompts, runReview, runReviews, splitNote } from "../../../knowledge/review/review.ts";
import { REVIEW_NONE, REVIEW_WAYS_OUT } from "../../../knowledge/review/config-keys.ts";
import { landingReleases } from "../../../knowledge/releases/landing.ts";
import { landingExecution, unconfirmedWording, wordingMessage } from "../../execution/landing.ts";
import { noticeProposedDecisions } from "./proposed.ts";
import { reviewTree } from "./review-tree.ts";
import { architectureOf, couldNotRun, duplicateReviewPrompt, reviewScope, reviewSettingsOn, standingTouched } from "./review-scope.ts";
import type { LandOptions, LandOutcome, Running } from "../outcome.ts";
import { checksAddedAndReviewed, checksAddedAndReviewedMessage, keysAddedAndUsed, keysAddedAndUsedMessage } from "./config-first.ts";

/** Per-kind counts and the files involved, so `canon stats` can tell which checks are precise (BR-2094, P6). */
export function findingDetail(findings: readonly Finding[]): { findings: Record<string, number>; paths: string[] } {
  const kinds: Record<string, number> = {};
  for (const f of findings) kinds[f.rule] = (kinds[f.rule] ?? 0) + 1;
  return { findings: kinds, paths: [...new Set(findings.map((f) => f.path))].sort().slice(0, 50) };
}

/** Why one change's own landing steps refused it: the refusal reason, message and canon check findings. */
export interface StepFailure {
  readonly ok: false;
  readonly reason: Extract<LandOutcome, { kind: "refused" }>["reason"];
  readonly message: string;
  readonly findings?: readonly Finding[];
}
export type Steps = { readonly ok: true; readonly reviewNotes: { reviewed: string[]; notes: readonly string[] } | undefined } | StepFailure;

/**
 * One change's own landing steps before the floor (BR-2014), on the checkout `wt` at `head` (main or the batch chain at
 * `base` below it): canon check, decision sources, the rule and duplicate reviews, before_land (BR-2016,
 * BR-2009, BR-2111, BR-2143, BR-2057). A solo landing runs them in its worktree; a batch, per change (BR-2172).
 */
type ChangeInput = { wt: string; base: string; main: string; head: string; before: string; subject: string | null; branch: string; running: Running };
export async function verifyChange(ws: Workspace, opts: LandOptions, say: Say, v: ChangeInput): Promise<Steps> {
  // reason: the review commands run in one temporary worktree at main's commit, so the change cannot edit its own reviewer (BR-2216, #115);
  // it is removed after every outcome, and a removal that fails is an environment problem, never a verdict turned ok
  const tree = reviewTree(ws, v.running, v.main);
  let steps: Steps;
  try {
    steps = await verifySteps(ws, opts, say, v, tree);
  } catch (e) {
    tree.release();
    throw e;
  }
  const gone = tree.release();
  if (gone.ok) return steps;
  return steps.ok ? { ok: false, reason: "environment", message: gone.error.message } : { ...steps, message: `${steps.message}\n${gone.error.message}` };
}

async function verifySteps(ws: Workspace, opts: LandOptions, say: Say, v: ChangeInput, tree: ReturnType<typeof reviewTree>): Promise<Steps> {
  const { wt, subject } = v;
  const base = { value: v.base };
  const head = { value: v.head };
  const refuse = (reason: StepFailure["reason"], message: string, findings?: readonly Finding[]): StepFailure => ({ ok: false, reason, message, ...(findings ? { findings } : {}) });
  // A config key or check name added to canon's code and used in canon/config.yaml in one landing breaks every older canon (BR-2248).
  const added = keysAddedAndUsed(wt, v.main, v.head);
  if (!added.ok) return refuse("environment", added.error.message);
  const dated = checksAddedAndReviewed(wt, v.main, v.head);
  if (!dated.ok) return refuse("environment", dated.error.message);
  // reason: the same check as a new config key, since an older canon rejects both alike; one reason, one message per kind (BR-2248)
  const unknown = [...(added.value.length > 0 ? [keysAddedAndUsedMessage(added.value, v.main)] : []), ...(dated.value.length > 0 ? [checksAddedAndReviewedMessage(dated.value, v.main)] : [])];
  if (unknown.length > 0) return refuse("config-key", unknown.join("\n"));
  const read = readCorpus(wt, ws.config.types, ws.config);
  const testsFound = testFilesFor(wt, ws.config);
  if (!testsFound.ok) return refuse("check", testsFound.error.message);
  const tests = testsFound.value;
  // reason: the config of the tree that is landing decides which commands and tests apply to it (BR-2005)
  const landing = readConfig(wt);
  if (!landing.ok) return refuse("check", `canon check: cannot read canon/config.yaml of the landing tree: ${landing.error.message}`);
  const onBranches = changeIdsOnBranches(ws);
  if (!onBranches.ok) return refuse("environment", onBranches.error.message);
  // reason: only the landing that adds a dangling backlog id is refused for it; one main already lists is a note (BR-2150, #112)
  const listed = backlogAt(wt, v.main, ws.config.types);
  if (!listed.ok) return refuse("environment", listed.error.message);
  const reports = reportsFor(ws.db, wt, landing.value, read.corpus, tests);
  if (!reports.ok) return refuse("environment", reports.error.message);
  const input = { root: wt, ...read, testFiles: tests, reports: reports.value, branchChanges: onBranches.value, backlogBase: new Set(listed.value.map((e) => e.id)), architecture: { refs: [v.base], since: v.base } };
  const findings = check(input);
  for (const n of backlogNotes(input)) say(noteLine(n));
  for (const n of staleReportNotes(input)) say(noteLine(n));
  if (findings.length > 0) return refuse("check", `canon check: ${findings.length} finding(s)`, findings);
  // Execution records (D-32): planned rules made active by their change only, pass records written only by canon, and
  // still matching their rules after the rebase (BR-2240, BR-2242, BR-2244).
  const execution = landingExecution({ db: ws.db, config: landing.value, wt, base: base.value, head: head.value, before: v.before, corpus: read.corpus, subject, main: ws.config.main });
  if (!execution.ok) return refuse(execution.reason, execution.message);
  // A release becomes shipped only through `canon release ship`, and stays shipped (BR-2332, D-61).
  const releases = landingReleases({ primary: ws.primary, timing: ws.config.floorTiming, db: ws.db, wt, base: base.value, head: head.value, corpus: read.corpus, subject });
  if (!releases.ok) return refuse("release", releases.message);

  // Every added, edited or deleted file under canon/rules, canon/decisions or canon/releases is reviewed (BR-2009): rule,
  // release and decision documents by their new text, deleted ones by the text they had on main, domain READMEs whole.
  const scope = reviewScope(wt, base.value, head.value, read.corpus);
  const { entries, changedDocs, deleted, readmes, deletedReadmes, reviewed } = scope;
  if (scope.renamed.length > 0) say(`review: ${scope.renamed.length} file(s) only moved, not reviewed`);
  // Sources new to main are checked once, here, on the tree that becomes main (BR-2111).
  const sourceFailures = await checkSources(wt, base.value, entries, read.corpus.docs, opts.fetcher ?? httpFetch);
  if (sourceFailures.length > 0) return refuse("source", `decision sources do not hold:\n${sourceFailures.map((f) => `  - ${f}`).join("\n")}`);
  let reviewNotes: { reviewed: string[]; notes: readonly string[] } | undefined;
  // reason: how a landing is reviewed (the command, its limit, the standing instruction list) comes from main's already-landed
  // config, never from the change's own tree: a change that swaps the reviewer would otherwise review itself (BR-2074, #115)
  const mainAt = v.main; // the review results below are also named v
  const trusted = reviewSettingsOn(wt, v.main);
  if (!trusted.ok) return refuse("environment", `canon/config.yaml on main cannot be read for the review settings: ${trusted.error.message}`);
  const onMain = trusted.value;
  // reason: `review: none` turns the reviews off on purpose; unset refuses, so they are never skipped silently (BR-2074, D-51)
  const reviewer = onMain.review === REVIEW_NONE ? undefined : onMain.review;
  const limits = { timeoutMs: onMain.reviewTimeoutMs, track: (r: { kill(): void } | undefined) => (v.running.review = r) };
  // Standing instructions added or edited by this landing are reviewed for requirements stated twice (BR-2143), by main's list.
  const standing = standingTouched(wt, base.value, head.value, onMain.instructions);
  // reason: a wording-only record needs the review's judgement even when no rule file changed in this landing (BR-2239)
  if (execution.wording.length > 0 && !reviewer) return refuse("review", wordingMessage(execution.wording.map((q) => q.id), undefined, false));
  const needs = [...reviewed, ...standing];
  if (needs.length > 0) {
    // reason: the text landing together with turning the review off is exactly what nobody would review (BR-2295)
    const next = landing.value.review;
    if ((next === undefined || next === REVIEW_NONE) && next !== onMain.review) return refuse("review", turnedOffMessage(needs, onMain.review, next));
    if (!onMain.review) return refuse("review", unconfiguredMessage(needs, next));
  }
  if (reviewed.length > 0 || execution.wording.length > 0) {
    if (!reviewer) {
      say(`review: ${REVIEW_NONE} — ${reviewed.join(", ")} land without a rule review`);
      ws.db.event(ws.actor, "review.skip", subject, { docs: reviewed });
    } else {
      say(`review: ${[...reviewed, ...execution.wording.map((q) => `${q.id} (wording judgement)`)].join(", ")}`);
      const at = tree.get();
      if (!at.ok) return refuse("environment", at.error.message);
      const overview = architectureOf(wt, base.value, head.value);
      if (!overview.ok) return refuse("environment", overview.error.message);
      const architecture = overview.value;
      const prompts = reviewPrompts(wt, read.corpus, changedDocs, { deleted, readmes, deletedReadmes, change: subject ? findDoc(read.corpus, subject) : undefined, wording: execution.wording, ...(architecture ? { architecture } : {}) }, onMain.reviewMaxPromptBytes);
      if (!prompts.ok) return refuse("review", prompts.error.message);
      const split = splitNote(prompts.value);
      if (split) say(`review: ${split}`);
      const v = await runReviews(reviewer, at.value, prompts.value, limits);
      if (!v.ok) return refuse("review", couldNotRun("rule", v.error.message, at.value, mainAt));
      ws.db.event(ws.actor, `review.${v.value.verdict}`, subject, { docs: reviewed, findings: v.value.findings, commit: head.value, ...(execution.wording.length > 0 ? { wording: v.value.wording ?? {} } : {}) });
      if (v.value.verdict === "block") return refuse("review", `rule review blocked:\n${v.value.findings.map((f) => `  - ${f}`).join("\n")}`);
      const unconfirmed = unconfirmedWording(execution.wording, v.value.wording);
      if (unconfirmed.length > 0) return refuse("review", wordingMessage(unconfirmed, v.value.wording, true));
      for (const f of v.value.findings) say(`review note: ${f}`);
      // reason: notes do not block and are not changes of their own; they wait on the document they name (BR-2145, D-21)
      reviewNotes = { reviewed: [...changedDocs.map((d) => d.id), ...deleted.map((d) => d.id)], notes: v.value.findings };
      if (v.value.findings.length > 0) say("review notes do not block and are not changes of their own: canon context shows them to whoever next changes these documents, who handles them then");
    }
  }
  if (standing.length > 0) {
    if (!reviewer) {
      say(`review: ${REVIEW_NONE} — ${standing.join(", ")} land without a duplicate review`);
      ws.db.event(ws.actor, "review.skip", subject, { docs: standing });
    } else {
      say(`review: standing instructions ${standing.join(", ")}`);
      const at = tree.get();
      if (!at.ok) return refuse("environment", at.error.message);
      const prompt = duplicateReviewPrompt(wt, base.value, head.value, standing, onMain.instructions, opts.guide);
      if (!prompt.ok) return refuse("environment", prompt.error.message);
      const v = await runReview(reviewer, at.value, prompt.value, limits);
      if (!v.ok) return refuse("review", couldNotRun("duplicate", v.error.message, at.value, mainAt));
      ws.db.event(ws.actor, `review.${v.value.verdict}`, subject, { docs: standing, findings: v.value.findings, commit: head.value });
      if (v.value.verdict === "block") return refuse("review", `duplicate review blocked:\n${v.value.findings.map((f) => `  - ${f}`).join("\n")}`);
      for (const f of v.value.findings) say(`review note: ${f}`);
    }
  }
  // reason: the review is over, so the temporary worktree goes before before_land runs, not after it (BR-2216)
  const gone = tree.release();
  if (!gone.ok) return refuse("environment", gone.error.message);
  // before_land: after floor, canon check and the built-in review, on the exact tree that becomes main (BR-2057).
  const hookEnv = { CANON_BASE: base.value, CANON_HEAD: head.value, CANON_BRANCH: v.branch };
  const failed = await runHooks({ db: ws.db, actor: ws.actor, event: "before_land", change: subject, cwd: wt, env: hookEnv, port: changePort(ws, subject) }, ws.config.hooks.before_land, say, true);
  if (failed) return refuse("hook", `before_land \`${failed.command}\` exited ${failed.exit}\n${failed.output}`);
  // reason: a notice, never a refusal: subagents land decisions proposed by design (BR-2355)
  const proposed = noticeProposedDecisions(ws, say, { wt, base: base.value, head: head.value, subject, corpus: read.corpus });
  if (!proposed.ok) return refuse("environment", proposed.error.message);
  return { ok: true, reviewNotes };
}

/** Why a landing that needs a review is refused while main sets no `review`, even when this landing sets one (BR-2074, BR-2143, #115). */
function unconfiguredMessage(docs: readonly string[], next: string | undefined): string {
  return [
    `review: not configured — ${docs.join(", ")} need a review and canon/config.yaml on main sets no \`review\``,
    `  ${next ? `this landing sets \`review\`, but the reviewer comes from main: ` : ""}land a change that only sets \`review\` first, by itself, then land these changes`,
    ...REVIEW_WAYS_OUT,
  ].join("\n");
}

/** Why a landing that turns the review off, or removes it, may not carry text the review would read (BR-2295). */
function turnedOffMessage(docs: readonly string[], before: string | undefined, now: string | undefined): string {
  const was = before === undefined ? "unset" : JSON.stringify(before);
  const is = now === undefined ? "removes `review`" : `sets \`review: ${now}\``;
  return [`review: this landing ${is} (main has ${was}) and also changes ${docs.join(", ")}, which would then land unreviewed`, ...REVIEW_WAYS_OUT].join("\n");
}

/**
 * BR-2111: a decision added by this landing cites at least one source under its options, and every source
 * line not already on main (in that decision) is verified against what it names. A source that cannot be
 * fetched fails too: an unverified quote never reaches main.
 */
async function checkSources(wt: string, base: string, entries: readonly { status: string; path: string }[], docs: readonly Doc[], fetcher: Fetcher): Promise<string[]> {
  const failures: string[] = [];
  const touched = new Map(entries.filter((e) => e.status !== "D" && e.path.startsWith("canon/decisions/")).map((e) => [e.path, e.status]));
  for (const d of docs) {
    if (d.kind !== "decision" || !touched.has(d.path)) continue;
    const now = sources(d.body).sources;
    if (touched.get(d.path) === "A" && now.length === 0) {
      failures.push(`${d.id} is new and cites no source under ${OPTIONS_SECTION} (来源：<URL or repository path> “<quote>”)`);
      continue;
    }
    const old = git(wt, "show", `${base}:${d.path}`);
    const before = new Set(old.ok ? sources(old.value).sources.map((s) => `${s.target} ${s.quote}`) : []);
    for (const f of await verify(wt, now.filter((s) => !before.has(`${s.target} ${s.quote}`)), fetcher)) failures.push(`${d.id}: ${f}`);
  }
  return failures;
}
