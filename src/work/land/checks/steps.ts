import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { git } from "../../../kernel/git.ts";
import { duplicatePrompt, reviewPrompt, runReview, SKILL_FILE, standingText, type DeletedDoc } from "../../../knowledge/review/review.ts";
import { REVIEW_NONE, REVIEW_WAYS_OUT, reviewKeys } from "../../../knowledge/review/config-keys.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import { landingReleases } from "../../../knowledge/releases/landing.ts";
import { landingExecution, unconfirmedWording, wordingMessage } from "../../execution/landing.ts";
import { reviewTree } from "./review-tree.ts";
import type { LandOptions, LandOutcome, Running } from "../outcome.ts";
import { parse } from "yaml";
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
 * One change's own landing steps after the floor, on the checkout `wt` at `head` (main or the batch chain at
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
  const tests = testFilesFor(wt, ws.config);
  // reason: the tree that is landing decides which paths may skip the floor (BR-2164), so it decides which test reads matter (BR-2181)
  const landing = readConfig(wt);
  if (!landing.ok) return refuse("check", `canon check: cannot read canon/config.yaml of the landing tree: ${landing.error.message}`);
  const onBranches = changeIdsOnBranches(ws);
  if (!onBranches.ok) return refuse("environment", onBranches.error.message);
  // reason: only the landing that adds a dangling backlog id is refused for it; one main already lists is a note (BR-2150, #112)
  const listed = backlogAt(wt, v.main, ws.config.types);
  if (!listed.ok) return refuse("environment", listed.error.message);
  const reports = reportsFor(ws.db, wt, landing.value, read.corpus, tests);
  if (!reports.ok) return refuse("environment", reports.error.message);
  const input = { root: wt, ...read, testFiles: tests, reports: reports.value, floorSkipPaths: landing.value.floorSkipPaths, branchChanges: onBranches.value, backlogBase: new Set(listed.value.map((e) => e.id)) };
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
  // core.quotePath=false: git otherwise prints non-ASCII paths quoted and octal-escaped, which match no document.
  // A file only moved, with identical content, is neither changed nor deleted: moving 74 rules into
  // subdomains must not re-review all of them (BR-2009). git pairs exact renames; the blobs are compared too.
  const knowledge = git(wt, "-c", "core.quotePath=false", "diff", "--name-status", "--find-renames=100%", base.value, head.value, "--", "canon/rules", "canon/decisions", "canon/releases");
  const entries: { status: string; path: string }[] = [];
  const renamed: string[] = [];
  for (const l of knowledge.ok && knowledge.value !== "" ? knowledge.value.split("\n") : []) {
    const [status, from, to] = l.split("\t") as [string, string, string | undefined];
    if (status[0] !== "R" || to === undefined) entries.push({ status: status[0]!, path: from });
    else if (sameBlob(wt, `${base.value}:${from}`, `${head.value}:${to}`)) renamed.push(`${from} → ${to}`);
    else entries.push({ status: "D", path: from }, { status: "A", path: to });
  }
  if (renamed.length > 0) say(`review: ${renamed.length} file(s) only moved, not reviewed`);
  const live = new Set(entries.filter((e) => e.status !== "D").map((e) => e.path));
  const changedDocs = read.corpus.docs.filter((d) => live.has(d.path));
  const deleted: DeletedDoc[] = entries
    .filter((e) => e.status === "D" && e.path.endsWith(".md") && !e.path.endsWith("/README.md"))
    .map((e) => {
      const old = git(wt, "show", `${base.value}:${e.path}`);
      const id = e.path.split("/").pop()!.match(/^[A-Z][A-Z0-9]*-\d+/)?.[0] ?? e.path;
      return { id, path: e.path, text: old.ok ? old.value : "" };
    });
  // Sources new to main are checked once, here, on the tree that becomes main (BR-2111).
  const sourceFailures = await checkSources(wt, base.value, entries, read.corpus.docs, opts.fetcher ?? httpFetch);
  if (sourceFailures.length > 0) return refuse("source", `decision sources do not hold:\n${sourceFailures.map((f) => `  - ${f}`).join("\n")}`);
  const readmes = read.corpus.domains.filter((dom) => live.has(dom.path)).map((dom) => dom.name);
  const deletedReadmes = entries.filter((e) => e.status === "D" && e.path.endsWith("/README.md")).map((e) => {
    const old = git(wt, "show", `${base.value}:${e.path}`);
    return { path: e.path, text: old.ok ? old.value : "" }; // the text on main, like a deleted rule's (BR-2009)
  });
  const reviewed = [...changedDocs.map((d) => d.id), ...deleted.map((d) => `${d.id} (deleted)`), ...readmes.map((n) => `${n} README`), ...deletedReadmes.map((r) => `${r.path} (deleted)`)];
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
  const touched = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=d", base.value, head.value);
  const standing = (touched.ok && touched.value !== "" ? touched.value.split("\n") : []).filter((p) => onMain.instructions.includes(p) || SKILL_FILE.test(p));
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
      const v = await runReview(reviewer, at.value, reviewPrompt(wt, read.corpus, changedDocs, { deleted, readmes, deletedReadmes, change: subject ? findDoc(read.corpus, subject) : undefined, wording: execution.wording }), limits);
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
      const diffs: { path: string; diff: string }[] = [];
      for (const path of standing) {
        const d = git(wt, "-c", "core.quotePath=false", "diff", "--no-color", base.value, head.value, "--", path);
        if (!d.ok) return refuse("environment", d.error.message);
        diffs.push({ path, diff: d.value });
      }
      const v = await runReview(reviewer, at.value, duplicatePrompt(standing, standingText(wt, onMain.instructions), opts.guide, standing.filter((p) => SKILL_FILE.test(p)).map((path) => ({ path, text: readFileSync(join(wt, path), "utf8") })), diffs), limits);
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

/** The review settings canon/config.yaml has at `rev` (main), each read as canon reads it; defaults when it has no config (#115). */
function reviewSettingsOn(wt: string, rev: string): Result<{ review: string | undefined; reviewTimeoutMs: number; instructions: readonly string[] }> {
  const text = git(wt, "show", `${rev}:canon/config.yaml`);
  let raw: Record<string, unknown> = {};
  if (text.ok) {
    try {
      const parsed = parse(text.value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch (e) {
      return err("invalid", `not valid YAML: ${(e as Error).message}`);
    }
  }
  const ctx = { root: wt, raw };
  const field = <T>(k: { key: string; default: T; read: (value: unknown, c: typeof ctx) => Result<T> }): Result<T> => (raw[k.key] === undefined ? ok(k.default) : k.read(raw[k.key], ctx));
  const review = field(reviewKeys.review);
  if (!review.ok) return review;
  const reviewTimeoutMs = field(reviewKeys.reviewTimeoutMs);
  if (!reviewTimeoutMs.ok) return reviewTimeoutMs;
  const instructions = field(reviewKeys.instructions);
  if (!instructions.ok) return instructions;
  return ok({ review: review.value, reviewTimeoutMs: reviewTimeoutMs.value, instructions: instructions.value });
}

/** Whether two `<rev>:<path>` objects are the same blob, i.e. the same bytes. */
function sameBlob(wt: string, a: string, b: string): boolean {
  const x = git(wt, "rev-parse", a);
  const y = git(wt, "rev-parse", b);
  return x.ok && y.ok && x.value === y.value;
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

/** Why a review that could not run refused the landing, and what its directory lacks (BR-2216). */
function couldNotRun(kind: "rule" | "duplicate", error: string, dir: string, main: string): string {
  return [
    `the ${kind} review could not run: ${error}`,
    // reason: the review runs in a checkout of main's commit, so a command that needs git-ignored files fails there (BR-2216, D-51)
    `  the review command ran in a temporary worktree at main's commit ${main.slice(0, 9)} (${dir}, removed afterwards), which holds only committed files: git-ignored files such as node_modules, .env or *.local.json are not there, so the command must not depend on them`,
  ].join("\n");
}
