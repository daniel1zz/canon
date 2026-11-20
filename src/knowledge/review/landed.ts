import { readFileSync } from "node:fs";
import { namedTests } from "./named-tests.ts";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Say, Workspace } from "../../work/workspace.ts";
import type { Running } from "../../work/land/outcome.ts";
import { readCorpus } from "../documents/read.ts";
import type { Doc } from "../documents/model.ts";
import { findDoc } from "../query/query.ts";
import { changeBasis, partsNote, reviewPromptParts, runReviews, splitNote, type ReviewLimits, type ReviewVerdict, onlyChangedBlock, type Slots } from "./review.ts";
import { reviewBudget } from "./budget.ts";
import { REVIEW_NONE } from "./config-keys.ts";
import { reviewTree } from "../../work/land/checks/review-tree.ts";
import { architectureOf, couldNotRun, duplicateReviewPrompt, reviewScope, reviewSettingsOn, standingTouched, type ReviewSettings } from "../../work/land/checks/review-scope.ts";
import { docsKey, passedDocs, passedReview, reviewKey } from "../../work/land/checks/review-reuse.ts";
import { landedSince } from "../../work/land/checks/landed-since.ts";
import { findingOf, recordFindings, sameDocsOpen } from "./findings/findings.ts";
import { judgeLandedWording, landedWordingQuestions } from "./landed-wording.ts";

/**
 * The rule review and the duplicate review of one landed commit, run after the landing in the background (D-89, BR-2441):
 * the documents and standing instructions the landing changed between `base` (main before it) and `head` (the commit it put on
 * main) are reviewed by the reviewer configured on `base` (BR-2074), in a temporary worktree at `base` (BR-2216); the
 * documents are read from a temporary worktree at `head`. Blocking findings are all recorded as open findings for the main
 * agent to settle (BR-2442, BR-2434, D-99); notes stay on the review's event (BR-2145).
 */
export interface LandedJob {
  readonly id: number;
  readonly change: string | null;
  readonly base: string;
  readonly head: string;
  /** The landing's land.ok event. */
  readonly landed: number;
  /** The main commit whose review command runs it; null or absent: the landing's base (BR-2074, BR-2449). */
  readonly reviewer?: string | null;
  /** The review's log; a failed call keeps its prompt and output next to it (BR-2482). */
  readonly log?: string;
}

/** Reviews one landed commit; an error means a review could not run and the job failed (BR-2441). */
export async function reviewLanded(ws: Workspace, job: LandedJob, say: Say, guide: string | undefined, running: Running, slots?: Slots): Promise<Result<void>> {
  const by = job.reviewer ?? job.base;
  if (job.reviewer) say(`review: run again with main's review command at ${job.reviewer.slice(0, 9)}, not the one at ${job.base.slice(0, 9)} before the landing (BR-2449)`);
  const settings = reviewSettingsOn(ws.primary, by);
  if (!settings.ok) return err("invalid", `canon/config.yaml at ${by.slice(0, 9)} cannot be read for the review settings: ${settings.error.message}`);
  const headRunning: Running = {};
  const at = reviewTree(ws, headRunning, job.head);
  const run = reviewTree(ws, running, by);
  try {
    const dir = at.get();
    if (!dir.ok) return dir;
    // reason: the signal handler removes this tree too, so a stopped reviewer leaves no worktree behind (BR-2441)
    running.readTree = dir.value;
    return await reviewIn(ws, job, say, guide, running, settings.value, dir.value, run, slots);
  } finally {
    const a = at.release();
    running.readTree = undefined;
    const b = run.release();
    if (!a.ok) say(`review: ${a.error.message}`);
    if (!b.ok) say(`review: ${b.error.message}`);
  }
}

async function reviewIn(ws: Workspace, job: LandedJob, say: Say, guide: string | undefined, running: Running, s: ReviewSettings, wt: string, tree: ReturnType<typeof reviewTree>, slots: Slots | undefined): Promise<Result<void>> {
  const { base, head, change } = job;
  const read = readCorpus(wt, ws.config.types, ws.config);
  const scope = reviewScope(wt, base, head, read.corpus);
  const standing = standingTouched(wt, base, head, s.instructions);
  const { changedDocs, deleted, readmes, deletedReadmes, reviewed } = scope;
  // reason: the close commit's wording-only records are judged here, after the landing, never in it (BR-2239, D-141)
  const wording = landedWordingQuestions(wt, base, head, read.corpus, change);
  if (reviewed.length === 0 && standing.length === 0 && wording.length === 0) {
    say("review: no rules, decisions, releases or standing instructions changed; nothing to review");
    return ok(undefined);
  }
  // reason: the landing only queues a review when main had a reviewer; one removed since is said, never skipped silently (BR-2441, D-51)
  if (s.review === undefined || s.review === REVIEW_NONE) {
    const why = s.review === undefined ? "not configured" : REVIEW_NONE;
    const docs = [...new Set([...reviewed, ...standing, ...wording.map((q) => q.id)])];
    say(`review: ${why} at ${base.slice(0, 9)} — ${docs.join(", ")} landed without a review${wording.length > 0 ? `; the wording-only records of ${wording.map((q) => q.id).join(", ")} were not judged` : ""}`);
    ws.db.event(ws.actor, "review.skip", change, { docs, landed: job.landed, reason: s.review === undefined ? "unconfigured" : "none" });
    return ok(undefined);
  }
  const reviewer = s.review;
  const limits: ReviewLimits = { timeoutMs: s.reviewTimeoutMs, kind: "land", track: (r) => (running.review = r), ...(job.log ? { keep: job.log.replace(/\.log$/, "") } : {}), ...(slots ? { slots } : {}) };
  const docIds = [...changedDocs.map((d) => d.id), ...deleted.map((d) => d.id)];
  // reason: a finding naming no document is attached to every reviewed one; a review of README text only has its domains (BR-2434)
  const attachTo = docIds.length > 0 ? docIds : readmes;
  let rulePrompts: readonly string[] = [];
  let runRule: (() => Promise<Result<unknown>>) | undefined;
  if (reviewed.length > 0) {
    say(`review: ${reviewed.join(", ")}`);
    const overview = architectureOf(wt, base, head);
    if (!overview.ok) return overview;
    const architecture = overview.value;
    const extras = { tests: namedTests(ws.db, wt, ws.config, changedDocs.filter((d) => d.kind === "rule").map((d) => d.id)), deleted, readmes, deletedReadmes, change: change ? findDoc(read.corpus, change) : undefined, added: scope.added, namedInAdded: scope.namedInAdded, restatements: scope.restatements, activated: scope.activated, ...(architecture ? { architecture } : {}) };
    const parted = reviewPromptParts(wt, read.corpus, changedDocs, extras, s.reviewMaxPromptBytes);
    if (!parted.ok) return err("invalid", parted.error.message);
    const prompts = parted.value.prompts;
    const byDocs = partsNote(parted.value.parts);
    if (byDocs) say(`review: ${byDocs}`);
    const split = splitNote(prompts);
    if (split) say(`review: ${split}`);
    // reason: the same prompts, command and budget that already passed get the same answer without another model call (BR-2361, D-70)
    const hash = reviewKey("land", reviewer, s.reviewMaxPromptBytes, prompts);
    const reused = passedReview(ws.db, "land", hash);
    // The changed documents' own key: the same text that passed a full review needs only what landed on main since (BR-2396, D-81).
    const basis = extras.change ? changeBasis(extras.change) : undefined;
    const readmePaths = new Set(readmes.map((name) => read.corpus.domains.find((d) => d.name === name)?.path).filter((p): p is string => p !== undefined));
    const docs_hash = docsKey(reviewer, s.reviewMaxPromptBytes, {
      // reason: the change's 方案依据 is reviewed text too, so a new basis is never answered by an older passing review (BR-2493)
      live: [
        ...[...changedDocs.map((d) => d.path), ...readmePaths].map((path) => ({ path, text: readFileSync(join(wt, path), "utf8") })),
        ...(basis !== undefined && extras.change ? [{ path: `${extras.change.path}#方案依据`, text: basis }] : []),
        // reason: which rule this landing activates, and its declared targets' text, are reviewed too, so an older pass of the same documents is not reused for them (BR-2496)
        ...scope.activated.map((a) => ({ path: `${a.id}#activated`, text: a.targets.map((t) => { const doc = read.corpus.docs.find((d) => d.id === t); return `${t}\n${doc ? readFileSync(join(wt, doc.path), "utf8") : ""}`; }).join("\n") })),
      ],
      deleted: [...deleted, ...deletedReadmes].map((d) => ({ path: d.path, text: d.text })),
      architectureDiff: architecture?.diff ?? "",
    });
    const usable = reused ? undefined : passedDocs(ws.db, change, docs_hash);
    const since = usable ? landedSince(wt, usable.base, base, read.corpus, new Set(changedDocs.map((d) => d.path))) : undefined;
    const common = { landed: job.landed, docs: reviewed, reviewed: docIds, commit: head, base };
    let incremental: { from: number; added: string[] } | undefined;
    if (!reused && !(usable && since && since.length === 0)) {
      rulePrompts = prompts;
      if (usable && since) {
        say(`review: the changed documents are the ones that passed review event ${usable.event}; reviewing them only against what landed on main since: ${since.map((d) => d.id).join(", ")}`);
        // reason: an activated rule's declared targets are compared in the small review too, so they stay in its corpus (BR-2496)
        const targets = new Set(scope.activated.flatMap((a) => a.targets));
        const keep = new Set<Doc>([...changedDocs, ...since, ...read.corpus.docs.filter((d) => targets.has(d.id))]);
        // reason: retain added lines so old restatements cannot block an incremental review (BR-2405, D-84).
        const small = reviewPromptParts(wt, { ...read.corpus, docs: read.corpus.docs.filter((d) => keep.has(d)) }, changedDocs, { tests: namedTests(ws.db, wt, ws.config, changedDocs.filter((d) => d.kind === "rule").map((d) => d.id)), deleted, readmes, deletedReadmes, change: extras.change, added: scope.added, namedInAdded: scope.namedInAdded, activated: scope.activated, incremental: { from: usable.event, added: since } }, s.reviewMaxPromptBytes);
        if (!small.ok) return err("invalid", small.error.message);
        const smallParts = partsNote(small.value.parts);
        if (smallParts) say(`review: ${smallParts}`);
        rulePrompts = small.value.prompts;
        incremental = { from: usable.event, added: since.map((d) => d.id) };
      }
    }
    // reason: defer both calls and reuse events until the complete plan passes its budget (BR-2490).
    runRule = async () => {
      if (reused) {
        say(`review: reused the passing review of the same prompts (event ${reused.event}, hash ${hash.slice(0, 12)}); the review command was not run`);
        ws.db.event(ws.actor, "review.reused", change, { review: "land", ...common, notes: reused.findings, hash, from: reused.event });
        for (const f of reused.findings) say(`review note: ${f}`);
      } else if (usable && since && since.length === 0) {
        say(`review: the changed documents are the ones that passed review event ${usable.event}, and no rule or decision landed on main since; the review command was not run`);
        ws.db.event(ws.actor, "review.reused", change, { review: "land", by: "docs", ...common, notes: usable.findings, docs_hash, from: usable.event });
        for (const f of usable.findings) say(`review note: ${f}`);
      } else {
        const at = tree.get();
        if (!at.ok) return at;
        const r = await runReviews(reviewer, at.value, rulePrompts, limits, s.reviewParallel);
        if (!r.ok) return err("io", couldNotRun("rule", r.error.message, at.value, job.reviewer ?? base, job.reviewer ? "main" : "before"));
        // reason: incremental reviews keep the earlier passing notes (BR-2145).
        const verdict = onlyChangedBlock(incremental && usable ? { verdict: r.value.verdict, findings: [...usable.findings, ...r.value.findings] } : r.value, new Set(docIds));
        return settle(ws, job, say, verdict, attachTo, "rule", { ...common, docs_hash, ...(incremental ? { incremental } : { hash }) });
      }
      return ok(undefined);
    };
  }
  let duplicate: string | undefined;
  if (standing.length > 0) {
    const prompt = duplicateReviewPrompt(wt, base, head, standing, s.instructions, guide);
    if (!prompt.ok) return prompt;
    duplicate = prompt.value;
  }
  const budget = reviewBudget(ws.db, ws.actor, { kind: "land", subject: change ?? head, reviewer: job.reviewer ?? base, command: reviewer, maxCalls: s.reviewMaxCalls, maxBytes: s.reviewMaxTotalPromptBytes, prompts: [...rulePrompts, ...(duplicate !== undefined ? [duplicate] : [])] });
  if (!budget.ok) return budget;
  if (!budget.value.allowed) return err("refused", budget.value.message);
  if (wording.length > 0) {
    const judged = await judgeLandedWording(ws, { change, head, reviewerAt: job.reviewer ?? base, at: job.reviewer ? "main" : "before" }, say, reviewer, limits, tree, wording);
    if (!judged.ok) return judged;
  }
  if (runRule) {
    const done = await runRule();
    if (!done.ok) return done;
  }
  if (duplicate !== undefined) {
    say(`review: standing instructions ${standing.join(", ")}`);
    const at = tree.get();
    if (!at.ok) return at;
    // reason: through runReviews so the call takes one of the slots shared with the reviews running at once (BR-2487)
    const v = await runReviews(reviewer, at.value, [duplicate], limits, 1);
    if (!v.ok) return err("io", couldNotRun("duplicate", v.error.message, at.value, job.reviewer ?? base, job.reviewer ? "main" : "before"));
    const done = settle(ws, job, say, v.value, standing, "duplicate", { landed: job.landed, docs: standing, reviewed: standing, commit: head, base });
    if (!done.ok) return done;
  }
  return ok(undefined);
}

/**
 * The end of one review: the review event written with every finding and the notes, then every blocking finding recorded as
 * an open finding on that event (BR-2442, BR-2434), each said in the log with how the main agent settles it (BR-2453, D-99).
 */
function settle(ws: Workspace, job: LandedJob, say: Say, verdict: ReviewVerdict, attachTo: readonly string[], review: "rule" | "duplicate", detail: Record<string, unknown>): Result<readonly number[]> {
  const findings = verdict.findings;
  const blocking = findings.filter((f) => findingOf(f).criterion !== "note");
  const notes = findings.filter((f) => findingOf(f).criterion === "note");
  // reason: an answer in the format before BR-2367 decides its own verdict; its findings name no criterion, so none is recorded (D-74)
  const kind = verdict.verdict === "block" ? "review.block" : "review.ok";
  const event = ws.db.event(ws.actor, kind, job.change, { review, ...detail, findings, notes });
  const recorded = blocking.length > 0 ? recordFindings(ws.db, { findings: blocking.map(findingOf), reviewed: attachTo, change: job.change, event, sha: job.head }) : ok({ opened: [], existing: [] });
  if (!recorded.ok) return err("invalid", `the ${review} review's findings could not be recorded: ${recorded.error.message}`);
  const ids = [...recorded.value.opened, ...recorded.value.existing];
  for (const f of blocking) say(`review finding: ${f}`);
  // reason: a mechanical hint only; whether the pair is really opposed is the review's call in canon finding reconcile (BR-2461, D-103)
  for (const n of recorded.value.opened) for (const old of sameDocsOpen(ws.db, n)) say(`review: #${old} and #${n} name the same documents; if they pull opposite ways, run canon finding reconcile ${old} ${n}`);
  // reason: an answer in the old format blocks by its own verdict with findings that name no criterion: said, never recorded (D-74)
  const legacy = verdict.verdict === "block" && blocking.length === 0;
  for (const n of notes) say(legacy ? `review finding (old answer format with no criterion, so not recorded as an open finding): ${n}` : `review note: ${n}`);
  if (notes.length > 0 && !legacy) say("review notes do not block and are not changes of their own: canon context shows them to whoever next changes these documents, who handles them then");
  if (blocking.length > 0)
    say(
      `review: ${blocking.length} blocking finding(s) recorded as open review findings (${ids.map((i) => `#${i}`).join(", ")}) on the documents they name; settle each now: fix a real one and canon finding close <n> --fixed <commit> --reason "<why>", or canon finding close <n> --spurious "<quote from a document it names>" --reason "<why>" when it does not hold; a fix never drops, narrows or widens a goal or commitment the owner set: when the only fix would, ask the owner (canon human ask) instead; canon context <id> lists them`,
    );
  else say(`review: ${review} review ${legacy ? "blocked in the old answer format" : "ok"}`);
  return ok(ids);
}
