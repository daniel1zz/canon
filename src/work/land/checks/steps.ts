import type { Say, Workspace } from "../../workspace.ts";
import { changeIdsOnBranches } from "../../session/inflight.ts";
import { readConfig } from "../../../config/config.ts";
import { backlogNotes, check, noteLine, type Finding } from "../../../knowledge/check/check.ts";
import { backlogAt } from "../../../knowledge/documents/backlog.ts";
import { httpFetch, OPTIONS_SECTION, sources, verify, type Fetcher } from "../../../knowledge/check/sources.ts";
import { testFilesFor } from "../../../knowledge/check/tests.ts";
import { runHooks } from "../../../config/hooks.ts";
import { changePort } from "../../../config/ports.ts";
import { type Doc } from "../../../knowledge/documents/model.ts";
import { findDoc } from "../../../knowledge/query/query.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { git } from "../../../kernel/git.ts";
import { duplicatePrompt, reviewPrompt, runReview, SKILL_FILE, standingText, type DeletedDoc } from "../../../knowledge/review/review.ts";
import { readReview, REVIEW_NONE, REVIEW_WAYS_OUT } from "../../../knowledge/review/config-keys.ts";
import { landingExecution, unconfirmedWording, wordingMessage } from "../../execution/landing.ts";
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
export async function verifyChange(ws: Workspace, opts: LandOptions, say: Say, v: { wt: string; base: string; main: string; head: string; before: string; subject: string | null; branch: string; running: Running }): Promise<Steps> {
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
  const input = { root: wt, ...read, testFiles: tests, floorSkipPaths: landing.value.floorSkipPaths, branchChanges: onBranches.value, backlogBase: new Set(listed.value.map((e) => e.id)) };
  const findings = check(input);
  for (const n of backlogNotes(input)) say(noteLine(n));
  if (findings.length > 0) return refuse("check", `canon check: ${findings.length} finding(s)`, findings);
  // Execution records (D-32): planned rules made active by their change only, pass records written only by canon, and
  // still matching their rules after the rebase (BR-2240, BR-2242, BR-2244).
  const execution = landingExecution({ db: ws.db, config: landing.value, wt, base: base.value, head: head.value, before: v.before, corpus: read.corpus, subject, main: ws.config.main });
  if (!execution.ok) return refuse(execution.reason, execution.message);

  // Every added, edited or deleted file under canon/rules or canon/decisions is reviewed (BR-2009): rule and
  // decision documents by their new text, deleted ones by the text they had on main, domain READMEs whole.
  // core.quotePath=false: git otherwise prints non-ASCII paths quoted and octal-escaped, which match no document.
  // A file only moved, with identical content, is neither changed nor deleted: moving 74 rules into
  // subdomains must not re-review all of them (BR-2009). git pairs exact renames; the blobs are compared too.
  const knowledge = git(wt, "-c", "core.quotePath=false", "diff", "--name-status", "--find-renames=100%", base.value, head.value, "--", "canon/rules", "canon/decisions");
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
  // reason: the tree that becomes main decides whether and how to review, not the config this worktree read before the rebase (BR-2074)
  const cfg = landing.value;
  // reason: `review: none` turns the reviews off on purpose; unset refuses, so they are never skipped silently (BR-2074, D-51)
  const reviewer = cfg.review === REVIEW_NONE ? undefined : cfg.review;
  const limits = { timeoutMs: cfg.reviewTimeoutMs, track: (r: { kill(): void } | undefined) => (v.running.review = r) };
  // Standing instructions added or edited by this landing are reviewed for requirements stated twice (BR-2143).
  const touched = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=d", base.value, head.value);
  const standing = (touched.ok && touched.value !== "" ? touched.value.split("\n") : []).filter((p) => cfg.instructions.includes(p) || SKILL_FILE.test(p));
  // reason: a wording-only record needs the review's judgement even when no rule file changed in this landing (BR-2239)
  if (execution.wording.length > 0 && !reviewer) return refuse("review", wordingMessage(execution.wording.map((q) => q.id), undefined, false));
  const needs = [...reviewed, ...standing];
  if (needs.length > 0) {
    const before = reviewOn(wt, v.main);
    // reason: the text landing together with turning the review off is exactly what nobody would review (BR-2295)
    if ((cfg.review === undefined || cfg.review === REVIEW_NONE) && cfg.review !== before) return refuse("review", turnedOffMessage(needs, before, cfg.review));
    if (!cfg.review) return refuse("review", unconfiguredMessage(needs));
  }
  if (reviewed.length > 0 || execution.wording.length > 0) {
    if (!reviewer) {
      say(`review: ${REVIEW_NONE} — ${reviewed.join(", ")} land without a rule review`);
      ws.db.event(ws.actor, "review.skip", subject, { docs: reviewed });
    } else {
      say(`review: ${[...reviewed, ...execution.wording.map((q) => `${q.id} (wording judgement)`)].join(", ")}`);
      const v = await runReview(reviewer, wt, reviewPrompt(wt, read.corpus, changedDocs, { deleted, readmes, deletedReadmes, change: subject ? findDoc(read.corpus, subject) : undefined, wording: execution.wording }), limits);
      if (!v.ok) return refuse("review", `the rule review could not run: ${v.error.message}`);
      ws.db.event(ws.actor, `review.${v.value.verdict}`, subject, { docs: reviewed, findings: v.value.findings, ...(execution.wording.length > 0 ? { wording: v.value.wording ?? {} } : {}) });
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
      const v = await runReview(reviewer, wt, duplicatePrompt(standing, standingText(wt, cfg.instructions), opts.guide), limits);
      if (!v.ok) return refuse("review", `the duplicate review could not run: ${v.error.message}`);
      ws.db.event(ws.actor, `review.${v.value.verdict}`, subject, { docs: standing, findings: v.value.findings });
      if (v.value.verdict === "block") return refuse("review", `duplicate review blocked:\n${v.value.findings.map((f) => `  - ${f}`).join("\n")}`);
      for (const f of v.value.findings) say(`review note: ${f}`);
    }
  }
  // before_land: after floor, canon check and the built-in review, on the exact tree that becomes main (BR-2057).
  const hookEnv = { CANON_BASE: base.value, CANON_HEAD: head.value, CANON_BRANCH: v.branch };
  const failed = await runHooks({ db: ws.db, actor: ws.actor, event: "before_land", change: subject, cwd: wt, env: hookEnv, port: changePort(ws, subject) }, ws.config.hooks.before_land, say, true);
  if (failed) return refuse("hook", `before_land \`${failed.command}\` exited ${failed.exit}\n${failed.output}`);
  return { ok: true, reviewNotes };
}

/** Why a landing that needs a review is refused while `review` is unset (BR-2074, BR-2143). */
function unconfiguredMessage(docs: readonly string[]): string {
  return [`review: not configured — ${docs.join(", ")} need a review and canon/config.yaml sets no \`review\``, ...REVIEW_WAYS_OUT].join("\n");
}

/** Why a landing that turns the review off, or removes it, may not carry text the review would read (BR-2295). */
function turnedOffMessage(docs: readonly string[], before: string | undefined, now: string | undefined): string {
  const was = before === undefined ? "unset" : JSON.stringify(before);
  const is = now === undefined ? "removes `review`" : `sets \`review: ${now}\``;
  return [`review: this landing ${is} (main has ${was}) and also changes ${docs.join(", ")}, which would then land unreviewed`, ...REVIEW_WAYS_OUT].join("\n");
}

/** The `review` value canon/config.yaml has at `rev`; undefined when it has none or the file is missing or unreadable. */
function reviewOn(wt: string, rev: string): string | undefined {
  const text = git(wt, "show", `${rev}:canon/config.yaml`);
  if (!text.ok) return undefined;
  try {
    const raw = parse(text.value) as Record<string, unknown> | null;
    const r = readReview(raw?.["review"] ?? null);
    return r.ok ? r.value : undefined;
  } catch {
    // reason: main's config that does not parse sets no reviewer; the landing tree's own config was already validated
    return undefined;
  }
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
