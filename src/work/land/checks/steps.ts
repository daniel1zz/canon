import { git } from "../../../kernel/git.ts";
import type { Say, Workspace } from "../../workspace.ts";
import { changeIdsOnBranches } from "../../session/inflight.ts";
import { readWorkConfig } from "../../workspace.ts";
import { backlogNotes, check, noteLine, staleReportNotes, type Finding } from "../../../knowledge/check/check.ts";
import { reportsFor } from "../../verify/changes.ts";
import { backlogAt } from "../../../knowledge/documents/backlog.ts";
import { httpFetch, OPTIONS_SECTION, sources, verify, type Fetcher } from "../../../knowledge/check/sources.ts";
import { testFilesFor } from "../../../knowledge/check/tests.ts";
import { testMergedFiles } from "./merged-tests.ts";
import { runHooks } from "../../hooks/hooks.ts";
import { changePort } from "../../hooks/ports.ts";
import { type Doc } from "../../../knowledge/documents/model.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { runReview, wordingPrompt } from "../../../knowledge/review/review.ts";
import { REVIEW_NONE } from "../../../knowledge/review/config-keys.ts";
import type { ReviewNeeds } from "../../../knowledge/review/landed-queue.ts";
import { landingReleases } from "../../../knowledge/releases/landing.ts";
import { landingExecution, unconfirmedWording, wordingMessage } from "../../execution/landing.ts";
import { landingAllocations } from "./allocated.ts";
import { noticeProposedDecisions } from "./proposed.ts";
import { reviewTree } from "./review-tree.ts";
import { passedWording, reviewKey } from "./review-reuse.ts";
import { couldNotRun, reviewScope, reviewSettingsOn, standingTouched } from "./review-scope.ts";
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
/** `retired`: the rules and decisions retired or superseded on the tree that lands, whose open findings the landing closes (BR-2435). */
/** `review`: what the reviews after the landing read and main's reviewer (BR-2441). */
export type Steps = { readonly ok: true; readonly review: ReviewNeeds; readonly retired: readonly string[] } | StepFailure;

/**
 * One change's own landing steps before the floor (BR-2014), on the checkout `wt` at `head` (main or the batch chain at
 * `base` below it): canon check, decision sources, the wording judgement, before_land (BR-2016, BR-2111,
 * BR-2239, BR-2057); the rule and duplicate reviews run after the landing (BR-2441, D-89). A solo landing runs them in
 * its worktree; a batch, per change (BR-2172).
 */
type ChangeInput = { wt: string; base: string; main: string; head: string; before: string; subject: string | null; branch: string; running: Running; worktree: string };
export async function verifyChange(ws: Workspace, opts: LandOptions, say: Say, v: ChangeInput): Promise<Steps> {
  // reason: the wording call runs in a temporary worktree at main's commit, so the change cannot edit its own reviewer (BR-2216, #115);
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
  const landing = readWorkConfig(wt);
  if (!landing.ok) return refuse("check", `canon check: cannot read canon/config.yaml of the landing tree: ${landing.error.message}`);
  const onBranches = changeIdsOnBranches(ws);
  if (!onBranches.ok) return refuse("environment", onBranches.error.message);
  // reason: only the landing that adds a dangling backlog id is refused for it; one main already lists is a note (BR-2150, #112)
  const listed = backlogAt(wt, v.main, ws.config.types);
  if (!listed.ok) return refuse("environment", listed.error.message);
  // reason: the rebase merged main's edits into a test file the change had tested; the landing tests the merged file itself instead of refusing it as unreported (BR-2381, #152)
  const merged = await testMergedFiles(ws, wt, landing.value.testCommand, tests, v.base, v.head, v.before);
  if (!merged.ok) return refuse("environment", merged.error.message);
  for (const m of merged.value) say(`tested ${m.file} after the rebase merged main's edits into it: ${m.exitCode === 0 ? "pass" : "fail"}`);
  const broken = merged.value.find((m) => m.exitCode !== 0);
  if (broken) return refuse("check", `canon check: ${broken.file} fails after the rebase merged main's edits into it (BR-2381); rebase onto main, fix it, run canon work test and land again:\n${broken.output.trimEnd().split("\n").slice(-20).join("\n")}`);
  const reports = reportsFor(ws.db, wt, landing.value, read.corpus, tests);
  if (!reports.ok) return refuse("environment", reports.error.message);
  const input = { root: wt, ...read, testFiles: tests, reports: reports.value, branchChanges: onBranches.value, backlogBase: new Set(listed.value.map((e) => e.id)), architecture: { refs: [v.base], since: v.base } };
  const findings = check(input);
  for (const n of backlogNotes(input)) say(noteLine(n));
  for (const n of staleReportNotes(input)) say(noteLine(n));
  if (findings.length > 0) return refuse("check", `canon check: ${findings.length} finding(s)`, findings);
  // An id the landing adds must not be one another change's worktree allocated (BR-2362, #140).
  const allocated = landingAllocations({ db: ws.db, primary: ws.primary, wt, worktree: v.worktree, base: base.value, head: head.value, corpus: read.corpus });
  if (!allocated.ok) return refuse(allocated.reason, allocated.message);
  // Execution records (D-32): planned rules made active by their change only, pass records written only by canon, and
  // still matching their rules after the rebase (BR-2240, BR-2242, BR-2244).
  const execution = landingExecution({ db: ws.db, config: landing.value, wt, base: base.value, head: head.value, before: v.before, corpus: read.corpus, subject, main: ws.config.main });
  if (!execution.ok) return refuse(execution.reason, execution.message);
  // A release becomes shipped only through `canon release ship`, and stays shipped (BR-2332, D-61).
  const releases = landingReleases({ primary: ws.primary, timing: ws.config.floorTiming, db: ws.db, wt, base: base.value, head: head.value, corpus: read.corpus, subject });
  if (!releases.ok) return refuse("release", releases.message);

  // Every added, edited or deleted file under canon/rules, canon/decisions or canon/releases is reviewed after the landing
  // (BR-2009, BR-2441): rule, release and decision documents by their new text, deleted ones by their text on main, domain READMEs whole.
  const scope = reviewScope(wt, base.value, head.value, read.corpus);
  const { entries } = scope;
  if (scope.renamed.length > 0) say(`review: ${scope.renamed.length} file(s) only moved, not reviewed`);
  if (scope.linksOnly.length > 0) say(`review: ${scope.linksOnly.length} file(s) only re-recorded references, not reviewed`);
  // Sources new to main are checked once, here, on the tree that becomes main (BR-2111).
  const sourceFailures = await checkSources(wt, base.value, entries, read.corpus.docs, opts.fetcher ?? httpFetch);
  if (sourceFailures.length > 0) return refuse("source", `decision sources do not hold:\n${sourceFailures.map((f) => `  - ${f}`).join("\n")}`);
  // reason: how a landing is reviewed (the command, its limit, the standing instruction list) comes from main's already-landed
  // config, never from the change's own tree: a change that swaps the reviewer would otherwise review itself (BR-2074, #115)
  const trusted = reviewSettingsOn(wt, v.main);
  if (!trusted.ok) return refuse("environment", `canon/config.yaml on main cannot be read for the review settings: ${trusted.error.message}`);
  const onMain = trusted.value;
  const reviewer = onMain.review === REVIEW_NONE ? undefined : onMain.review;
  // The rule and duplicate reviews run after the landing, in the background, on the commit it puts on main (BR-2441, D-89);
  // the landing only names what they will read. Standing instructions are found by main's list (BR-2143).
  // reason: the reviews after the landing read their settings at this change's own base, a batch member's at the commit below it (BR-2074)
  const below = v.base === v.main ? trusted : reviewSettingsOn(wt, v.base);
  if (!below.ok) return refuse("environment", `canon/config.yaml at ${v.base.slice(0, 9)} cannot be read for the review settings: ${below.error.message}`);
  const standing = standingTouched(wt, base.value, head.value, below.value.instructions);
  const review: ReviewNeeds = { docs: scope.reviewed, standing, reviewer: below.value.review };
  // reason: a wording-only record needs a judgement before the close commit lands, so this one model call stays in the landing (BR-2239, D-89)
  if (execution.wording.length > 0) {
    if (!reviewer) return refuse("review", wordingMessage(execution.wording.map((q) => q.id), undefined, false));
    say(`wording judgement: ${execution.wording.map((q) => q.id).join(", ")}`);
    const prompt = wordingPrompt(execution.wording);
    const hash = reviewKey("land", reviewer, 0, [prompt]);
    const earlier = passedWording(ws.db, hash);
    let answers: Readonly<Record<string, string>> | undefined;
    if (earlier && unconfirmedWording(execution.wording, earlier.wording).length === 0) {
      say(`wording judgement: reused event ${earlier.event} for the same question; the review command was not run`);
      answers = earlier.wording;
    } else {
      const at = tree.get();
      if (!at.ok) return refuse("environment", at.error.message);
      const limits = { timeoutMs: onMain.reviewTimeoutMs, kind: "land" as const, track: (r: { kill(): void } | undefined) => (v.running.review = r) };
      const run = await runReview(reviewer, at.value, prompt, limits);
      if (!run.ok) return refuse("review", couldNotRun("wording", run.error.message, at.value, v.main));
      answers = run.value.wording;
      ws.db.event(ws.actor, "review.wording", subject, { docs: execution.wording.map((q) => q.id), wording: answers ?? {}, hash, commit: head.value });
    }
    const unconfirmed = unconfirmedWording(execution.wording, answers);
    if (unconfirmed.length > 0) return refuse("review", wordingMessage(unconfirmed, answers, true));
  }
  // reason: the wording call is over, so the temporary worktree goes before before_land runs, not after it (BR-2216)
  const gone = tree.release();
  if (!gone.ok) return refuse("environment", gone.error.message);
  // before_land: after canon check and the built-in steps, on the exact tree that becomes main (BR-2057).
  const hookEnv = { CANON_BASE: base.value, CANON_HEAD: head.value, CANON_BRANCH: v.branch };
  const failed = await runHooks({ db: ws.db, actor: ws.actor, event: "before_land", change: subject, cwd: wt, env: hookEnv, port: changePort(ws, subject) }, ws.config.hooks.before_land, say, true);
  if (failed) return refuse("hook", `before_land \`${failed.command}\` exited ${failed.exit}\n${failed.output}`);
  // reason: a notice, never a refusal: subagents land decisions proposed by design (BR-2355)
  const proposed = noticeProposedDecisions(ws, say, { wt, base: base.value, head: head.value, subject, corpus: read.corpus });
  if (!proposed.ok) return refuse("environment", proposed.error.message);
  const retired = read.corpus.docs.filter((d) => (d.kind === "rule" && d.status === "retired") || (d.kind === "decision" && d.status === "superseded")).map((d) => d.id);
  return { ok: true, review, retired };
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
