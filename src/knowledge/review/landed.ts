import { readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Say, Workspace } from "../../work/workspace.ts";
import type { Running } from "../../work/land/outcome.ts";
import { readCorpus } from "../documents/read.ts";
import type { Corpus, Doc } from "../documents/model.ts";
import { findDoc } from "../query/query.ts";
import { CRITERION_TEXT, partsNote, reviewPromptParts, runJsonCommand, runReview, runReviews, splitNote, type ReviewLimits, type ReviewVerdict } from "./review.ts";
import { REVIEW_NONE } from "./config-keys.ts";
import { reviewTree } from "../../work/land/checks/review-tree.ts";
import { architectureOf, couldNotRun, duplicateReviewPrompt, reviewScope, reviewSettingsOn, standingTouched, type ReviewSettings } from "../../work/land/checks/review-scope.ts";
import { docsKey, passedDocs, passedReview, reviewKey } from "../../work/land/checks/review-reuse.ts";
import { landedSince } from "../../work/land/checks/landed-since.ts";
import { closeNoLongerHolds, findingOf, namedIds, openFindings, recordFindings, type Finding } from "./findings/findings.ts";

/**
 * The rule review and the duplicate review of one landed commit, run after the landing in the background (D-89, BR-2441):
 * the documents and standing instructions the landing changed between `base` (main before it) and `head` (the commit it put on
 * main) are reviewed by the reviewer configured on `base` (BR-2074), in a temporary worktree at `base` (BR-2216); the
 * documents are read from a temporary worktree at `head`. Blocking findings go to the verifier and those that hold are
 * recorded as open findings (BR-2442, BR-2434); notes stay on the review's event (BR-2145).
 */
export interface LandedJob {
  readonly id: number;
  readonly change: string | null;
  readonly base: string;
  readonly head: string;
  /** The landing's land.ok event. */
  readonly landed: number;
}

/** What one verification of a blocking finding said (BR-2442): holds, does not hold, or null when it was not verified. */
export interface Verified {
  readonly finding: string;
  readonly holds: boolean | null;
  readonly reason: string;
}

/** Reviews one landed commit; an error means a review could not run and the job failed (BR-2441). */
export async function reviewLanded(ws: Workspace, job: LandedJob, say: Say, guide: string | undefined, running: Running): Promise<Result<void>> {
  const settings = reviewSettingsOn(ws.primary, job.base);
  if (!settings.ok) return err("invalid", `canon/config.yaml at ${job.base.slice(0, 9)} cannot be read for the review settings: ${settings.error.message}`);
  const headRunning: Running = {};
  const at = reviewTree(ws, headRunning, job.head);
  const run = reviewTree(ws, running, job.base);
  try {
    const dir = at.get();
    if (!dir.ok) return dir;
    // reason: the signal handler removes this tree too, so a stopped reviewer leaves no worktree behind (BR-2441)
    running.readTree = dir.value;
    return await reviewIn(ws, job, say, guide, running, settings.value, dir.value, run);
  } finally {
    const a = at.release();
    running.readTree = undefined;
    const b = run.release();
    if (!a.ok) say(`review: ${a.error.message}`);
    if (!b.ok) say(`review: ${b.error.message}`);
  }
}

async function reviewIn(ws: Workspace, job: LandedJob, say: Say, guide: string | undefined, running: Running, s: ReviewSettings, wt: string, tree: ReturnType<typeof reviewTree>): Promise<Result<void>> {
  const { base, head, change } = job;
  const read = readCorpus(wt, ws.config.types, ws.config);
  const scope = reviewScope(wt, base, head, read.corpus);
  const standing = standingTouched(wt, base, head, s.instructions);
  const { changedDocs, deleted, readmes, deletedReadmes, reviewed } = scope;
  if (reviewed.length === 0 && standing.length === 0) {
    say("review: no rules, decisions, releases or standing instructions changed; nothing to review");
    return ok(undefined);
  }
  // reason: the landing only queues a review when main had a reviewer; one removed since is said, never skipped silently (BR-2441, D-51)
  if (s.review === undefined || s.review === REVIEW_NONE) {
    const why = s.review === undefined ? "not configured" : REVIEW_NONE;
    say(`review: ${why} at ${base.slice(0, 9)} — ${[...reviewed, ...standing].join(", ")} landed without a review`);
    ws.db.event(ws.actor, "review.skip", change, { docs: [...reviewed, ...standing], landed: job.landed, reason: s.review === undefined ? "unconfigured" : "none" });
    return ok(undefined);
  }
  const reviewer = s.review;
  const limits: ReviewLimits = { timeoutMs: s.reviewTimeoutMs, kind: "land", track: (r) => (running.review = r) };
  const docIds = [...changedDocs.map((d) => d.id), ...deleted.map((d) => d.id)];
  // reason: a finding naming no document is attached to every reviewed one; a review of README text only has its domains (BR-2434)
  const attachTo = docIds.length > 0 ? docIds : readmes;
  if (reviewed.length > 0) {
    say(`review: ${reviewed.join(", ")}`);
    const overview = architectureOf(wt, base, head);
    if (!overview.ok) return overview;
    const architecture = overview.value;
    const extras = { deleted, readmes, deletedReadmes, change: change ? findDoc(read.corpus, change) : undefined, added: scope.added, restatements: scope.restatements, ...(architecture ? { architecture } : {}) };
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
    const readmePaths = new Set(readmes.map((name) => read.corpus.domains.find((d) => d.name === name)?.path).filter((p): p is string => p !== undefined));
    const docs_hash = docsKey(reviewer, s.reviewMaxPromptBytes, {
      live: [...changedDocs.map((d) => d.path), ...readmePaths].map((path) => ({ path, text: readFileSync(join(wt, path), "utf8") })),
      deleted: [...deleted, ...deletedReadmes].map((d) => ({ path: d.path, text: d.text })),
      architectureDiff: architecture?.diff ?? "",
    });
    const usable = reused ? undefined : passedDocs(ws.db, change, docs_hash);
    const since = usable ? landedSince(wt, usable.base, base, read.corpus, new Set(changedDocs.map((d) => d.path))) : undefined;
    const common = { landed: job.landed, docs: reviewed, reviewed: docIds, commit: head, base };
    if (reused) {
      say(`review: reused the passing review of the same prompts (event ${reused.event}, hash ${hash.slice(0, 12)}); the review command was not run`);
      ws.db.event(ws.actor, "review.reused", change, { review: "land", ...common, notes: reused.findings, hash, from: reused.event });
      for (const f of reused.findings) say(`review note: ${f}`);
    } else if (usable && since && since.length === 0) {
      say(`review: the changed documents are the ones that passed review event ${usable.event}, and no rule or decision landed on main since; the review command was not run`);
      ws.db.event(ws.actor, "review.reused", change, { review: "land", by: "docs", ...common, notes: usable.findings, docs_hash, from: usable.event });
      for (const f of usable.findings) say(`review note: ${f}`);
    } else {
      let verdict: ReviewVerdict;
      let incremental: { from: number; added: string[] } | undefined;
      const at = tree.get();
      if (!at.ok) return at;
      if (usable && since) {
        say(`review: the changed documents are the ones that passed review event ${usable.event}; reviewing them only against what landed on main since: ${since.map((d) => d.id).join(", ")}`);
        const keep = new Set<Doc>([...changedDocs, ...since]);
        // reason: without its added lines a changed document already on main would read as new, so its old restatements could block (BR-2405, D-84)
        const small = reviewPromptParts(wt, { ...read.corpus, docs: read.corpus.docs.filter((d) => keep.has(d)) }, changedDocs, { deleted, readmes, deletedReadmes, change: extras.change, added: scope.added, incremental: { from: usable.event, added: since } }, s.reviewMaxPromptBytes);
        if (!small.ok) return err("invalid", small.error.message);
        const smallParts = partsNote(small.value.parts);
        if (smallParts) say(`review: ${smallParts}`);
        const r = await runReviews(reviewer, at.value, small.value.prompts, limits, s.reviewParallel);
        if (!r.ok) return err("io", couldNotRun("rule", r.error.message, at.value, base));
        // reason: the earlier pass's notes are kept with the new ones (BR-2145)
        verdict = { verdict: r.value.verdict, findings: [...usable.findings, ...r.value.findings] };
        incremental = { from: usable.event, added: since.map((d) => d.id) };
      } else {
        const r = await runReviews(reviewer, at.value, prompts, limits, s.reviewParallel);
        if (!r.ok) return err("io", couldNotRun("rule", r.error.message, at.value, base));
        verdict = r.value;
      }
      const done = await settle(ws, job, say, s, at.value, read.corpus, wt, verdict, attachTo, standing, "rule", { ...common, docs_hash, ...(incremental ? { incremental } : { hash }) });
      if (!done.ok) return done;
      await reask(ws, job, say, s, reviewer, at.value, read.corpus, wt, attachTo, done.value);
    }
  }
  if (standing.length > 0) {
    say(`review: standing instructions ${standing.join(", ")}`);
    const at = tree.get();
    if (!at.ok) return at;
    const prompt = duplicateReviewPrompt(wt, base, head, standing, s.instructions, guide);
    if (!prompt.ok) return prompt;
    const v = await runReview(reviewer, at.value, prompt.value, limits);
    if (!v.ok) return err("io", couldNotRun("duplicate", v.error.message, at.value, base));
    const done = await settle(ws, job, say, s, at.value, read.corpus, wt, v.value, standing, standing, "duplicate", { landed: job.landed, docs: standing, reviewed: standing, commit: head, base });
    if (!done.ok) return done;
    await reask(ws, job, say, s, reviewer, at.value, read.corpus, wt, standing, done.value);
  }
  return ok(undefined);
}

/**
 * The end of one review: its blocking findings verified (BR-2442), the review event written with every finding, the notes and
 * each verification, then the findings that hold or were not verified recorded as open findings on that event (BR-2434).
 */
async function settle(
  ws: Workspace,
  job: LandedJob,
  say: Say,
  s: ReviewSettings,
  cwd: string,
  corpus: Corpus,
  wt: string,
  verdict: ReviewVerdict,
  attachTo: readonly string[],
  standing: readonly string[],
  review: "rule" | "duplicate",
  detail: Record<string, unknown>,
): Promise<Result<readonly number[]>> {
  const findings = verdict.findings;
  const blocking = findings.filter((f) => findingOf(f).criterion !== "note");
  const notes = findings.filter((f) => findingOf(f).criterion === "note");
  const verified: Verified[] = [];
  for (const f of blocking) verified.push(await verifyOne(s, cwd, corpus, wt, findingOf(f), review === "duplicate" ? standing : attachTo));
  // reason: an answer in the format before BR-2367 decides its own verdict; its findings name no criterion, so none is recorded (D-74)
  const kind = verdict.verdict === "block" ? "review.block" : "review.ok";
  const event = ws.db.event(ws.actor, kind, job.change, { review, ...detail, findings, notes, verified, verifier: s.verify ?? null });
  const keep = verified.filter((v) => v.holds !== false);
  const recorded = keep.length > 0 ? recordFindings(ws.db, { findings: keep.map((v) => findingOf(v.finding)), reviewed: attachTo, change: job.change, event, sha: job.head }) : ok({ opened: [], existing: [] });
  if (!recorded.ok) return err("invalid", `the ${review} review's findings could not be recorded: ${recorded.error.message}`);
  const ids = [...recorded.value.opened, ...recorded.value.existing];
  for (const v of verified) {
    if (v.holds === false) say(`review finding rejected by review_verify (${v.reason}): ${v.finding}`);
    else say(`review finding ${v.holds === null ? `not verified (${v.reason})` : `verified (${v.reason})`}: ${v.finding}`);
  }
  // reason: an answer in the old format blocks by its own verdict with findings that name no criterion: said, never recorded (D-74)
  const legacy = verdict.verdict === "block" && blocking.length === 0;
  for (const n of notes) say(legacy ? `review finding (old answer format with no criterion, so not recorded as an open finding): ${n}` : `review note: ${n}`);
  if (notes.length > 0 && !legacy) say("review notes do not block and are not changes of their own: canon context shows them to whoever next changes these documents, who handles them then");
  if (keep.length > 0) say(`review: ${keep.length} blocking finding(s) recorded as open review findings (${ids.map((i) => `#${i}`).join(", ")}) on the documents they name: canon context <id> lists them; fix the real ones in a change of their own`);
  else say(`review: ${review} review ${blocking.length > 0 ? "found only findings the verifier rejected" : legacy ? "blocked in the old answer format" : "ok"}`);
  return ok(ids);
}

/**
 * After a review that ran: each open finding attached to a document it reviewed, other than the ones it just recorded, is asked
 * again whether it still holds for the landed text (BR-2450, D-89), by `review_verify`, or by `review` when no verifier is set.
 * Each answer is a `review.reask` event; a finding that no longer holds is closed by that event (BR-2439).
 */
async function reask(ws: Workspace, job: LandedJob, say: Say, s: ReviewSettings, reviewer: string, cwd: string, corpus: Corpus, wt: string, docs: readonly string[], recorded: readonly number[]): Promise<void> {
  const skip = new Set(recorded);
  const command = s.verify ?? reviewer;
  for (const f of openFindings(ws.db, docs).filter((x) => !skip.has(x.id))) {
    const v = await holds(command, s, cwd, corpus, wt, { criterion: f.criterion, text: f.text }, f.docs);
    const event = ws.db.event(ws.actor, "review.reask", job.change, { finding: f.id, holds: v.holds, reason: v.reason, asker: command, landed: job.landed, commit: job.head });
    if (v.holds === false) {
      const closed = closeNoLongerHolds(ws.db, f.id, event);
      say(closed.ok ? `review: open finding #${f.id} no longer holds (${v.reason}): closed` : `review: open finding #${f.id} no longer holds (${v.reason}), but could not be closed: ${closed.error.message}`);
    } else say(`review: open finding #${f.id} ${v.holds === null ? `stays open, the re-ask did not answer (${v.reason})` : `still holds (${v.reason})`}: ${f.text}`);
  }
}

/** The documents a finding is checked against: the ones it names, else the ones it is attached to; each with its full text at the landed commit (BR-2442). */
function documentsOf(corpus: Corpus, wt: string, f: Finding, attachTo: readonly string[]): string[] {
  const named = namedIds(f.text);
  const ids = named.length > 0 ? named : attachTo;
  return ids.map((id) => {
    const d = findDoc(corpus, id);
    const path = d?.path ?? id;
    try {
      return `## ${id} (${path})\n\n${readFileSync(join(wt, path), "utf8").trim()}\n`;
    } catch {
      return `## ${id}\n\n(not in the landed tree)\n`;
    }
  });
}

/** The verifier's prompt for one blocking finding (BR-2442). */
export function verifyPrompt(f: Finding, documents: readonly string[]): string {
  return [
    "A review of a project's rules, decisions and standing instructions gave the finding below. Decide whether it holds for the documents below, exactly as they are written. A finding that ignores a scope, an exception or a condition the text states does not hold; neither does one about text that is not there.",
    `The criterion it names: ${CRITERION_TEXT[f.criterion] ?? f.criterion}`,
    `The finding: ${f.text}`,
    'Answer with JSON only: {"holds":true|false,"reason":"<one sentence, in the language of the documents>"}',
    "",
    "# Documents",
    "",
    ...documents,
  ].join("\n");
}

async function verifyOne(s: ReviewSettings, cwd: string, corpus: Corpus, wt: string, f: Finding, attachTo: readonly string[]): Promise<Verified> {
  // reason: with no verifier the finding is recorded as it is and says so, never dropped (D-89, BR-2442)
  if (s.verify === undefined) return { finding: `[${f.criterion}] ${f.text}`, holds: null, reason: "no review_verify on main" };
  return holds(s.verify, s, cwd, corpus, wt, f, attachTo);
}

/** Asks `command` whether finding `f` holds for the landed text (BR-2442, BR-2450); `holds` is null when it gave no usable answer. */
async function holds(command: string, s: ReviewSettings, cwd: string, corpus: Corpus, wt: string, f: Finding, attachTo: readonly string[]): Promise<Verified> {
  const finding = `[${f.criterion}] ${f.text}`;
  const key = command === s.verify ? "review_verify" : "review";
  const v = await runJsonCommand(command, cwd, verifyPrompt(f, documentsOf(corpus, wt, f, attachTo)), { timeoutMs: s.reviewTimeoutMs, kind: "verify" });
  if (!v.ok) return { finding, holds: null, reason: `${key} could not run: ${v.error.message.replace(/^review /, "")}` };
  const a = v.value as { holds?: unknown; reason?: unknown } | null;
  if (a === null || typeof a !== "object" || typeof a.holds !== "boolean") return { finding, holds: null, reason: `${key} gave no "holds" true or false: ${JSON.stringify(v.value).slice(0, 200)}` };
  return { finding, holds: a.holds, reason: typeof a.reason === "string" && a.reason.trim() !== "" ? a.reason.trim() : "no reason given" };
}
