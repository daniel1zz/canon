import { relatedElsewhere, relatedLines } from "../query/related.ts";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { git, gitEnv } from "../../kernel/git.ts";
import { ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../../work/workspace.ts";
import { claimOfWorktree } from "../../work/claims/claims.ts";
import { architectureOf, couldNotRun, duplicateReviewPrompt, reviewScope, reviewSettingsOn, standingTouched } from "../../work/land/checks/review-scope.ts";
import { reviewTree } from "../../work/land/checks/review-tree.ts";
import type { Running } from "../../work/land/outcome.ts";
import { readCorpus } from "../documents/read.ts";
import { findDoc } from "../query/query.ts";
import { REVIEW_NONE } from "./config-keys.ts";
import { passedReview, reviewKey } from "../../work/land/checks/review-reuse.ts";
import type { Doc, Corpus } from "../documents/model.ts";
import { planClose, wordingQuestions } from "../../work/execution/landing.ts";
import { reviewCalls, type ReviewExtras, runReview, runReviews, type ReviewVerdict } from "./review.ts";

/** What `canon work review` found, as the command turns it into text and an exit code (BR-2358). */
export type PreviewOutcome =
  | { readonly kind: "ok" | "block"; readonly findings: readonly { readonly review: "rule" | "duplicate"; readonly text: string }[]; readonly reviewed: readonly string[]; readonly behind: number; readonly main: string; readonly reusedFrom?: number; readonly related: readonly string[]; readonly wording: readonly { readonly id: string; readonly answer: string | undefined }[] }
  | { readonly kind: "off"; readonly behind: number; readonly main: string; readonly related: readonly string[]; readonly wording: readonly string[] }
  | { readonly kind: "nothing"; readonly behind: number; readonly main: string }
  | { readonly kind: "unconfigured"; readonly needs: readonly string[]; readonly main: string }
  | { readonly kind: "usage" | "failed"; readonly message: string };

/**
 * The tree of everything in `root` as it is now: committed, uncommitted and untracked files, made with a scratch index so
 * the worktree's own index and files stay as they are. Files git ignores are not in it, as they are not in a commit.
 */
function currentTree(root: string): Result<string> {
  const scratch = mkdtempSync(join(tmpdir(), "canon-review-tree-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    const own = git(root, "rev-parse", "--git-path", "index");
    if (!own.ok) return own;
    const path = isAbsolute(own.value) ? own.value : join(root, own.value);
    if (existsSync(path)) copyFileSync(path, env.GIT_INDEX_FILE);
    else {
      const r = gitEnv(root, env, "read-tree", "HEAD");
      if (!r.ok) return r;
    }
    const added = gitEnv(root, env, "add", "-A");
    if (!added.ok) return added;
    return gitEnv(root, env, "write-tree");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The documents this work changes, found exactly as the landing's review finds them: the diff of main's merge base with the
 * tree of everything in the worktree now (BR-2375, BR-2358). Undefined in the primary checkout and when the work changes no
 * reviewed document, which count 0.
 */
export function thisWorkChanges(ws: Workspace, corpus: Corpus): Result<{ readonly changed: readonly Doc[]; readonly extras: ReviewExtras } | undefined> {
  if (ws.root === ws.primary) return ok(undefined);
  const main = git(ws.root, "rev-parse", "--verify", `${ws.config.main}^{commit}`);
  if (!main.ok) return main;
  const base = git(ws.root, "merge-base", "HEAD", main.value);
  if (!base.ok) return ok(undefined);
  const head = currentTree(ws.root);
  if (!head.ok) return head;
  const scope = reviewScope(ws.root, base.value, head.value, corpus);
  if (scope.reviewed.length === 0) return ok(undefined);
  const architecture = architectureOf(ws.root, base.value, head.value);
  if (!architecture.ok) return architecture;
  const subject = claimOfWorktree(ws.db, ws.root)?.subject ?? null;
  const change = subject === null ? undefined : findDoc(corpus, subject);
  return ok({ changed: scope.changedDocs, extras: { deleted: scope.deleted, readmes: scope.readmes, deletedReadmes: scope.deletedReadmes, change, ...(architecture.value ? { architecture: architecture.value } : {}) } });
}

/**
 * The landing's rule review and duplicate review, run on this worktree's current text with main's reviewer, limit and
 * instruction list, in a temporary worktree at main's commit, from the same code the landing uses (BR-2358, BR-2216).
 * It records `review.preview`, never a landing's review result, and attaches no note to any document (D-21).
 */
export async function previewReview(ws: Workspace, guide: string | undefined): Promise<PreviewOutcome> {
  const usage = (message: string): PreviewOutcome => ({ kind: "usage", message });
  if (ws.root === ws.primary) return usage(`canon work review runs in a change's worktree, not in the primary checkout (${ws.root})`);
  const subject = claimOfWorktree(ws.db, ws.root)?.subject ?? null;
  if (subject === null) return usage(`canon work review runs in a change's worktree; ${ws.root} is not one (canon work start <C-n> makes one)`);
  const main = git(ws.root, "rev-parse", "--verify", `${ws.config.main}^{commit}`);
  if (!main.ok) return { kind: "failed", message: main.error.message };
  const base = git(ws.root, "merge-base", "HEAD", main.value);
  if (!base.ok) return { kind: "failed", message: base.error.message };
  const ahead = git(ws.root, "rev-list", "--count", `${base.value}..${main.value}`);
  if (!ahead.ok) return { kind: "failed", message: ahead.error.message };
  const behind = Number(ahead.value);
  const head = currentTree(ws.root);
  if (!head.ok) return { kind: "failed", message: head.error.message };

  const settings = reviewSettingsOn(ws.root, main.value);
  if (!settings.ok) return { kind: "failed", message: `canon/config.yaml on ${ws.config.main} cannot be read for the review settings: ${settings.error.message}` };
  const onMain = settings.value;
  const read = readCorpus(ws.root, ws.config.types, ws.config);
  const scope = reviewScope(ws.root, base.value, head.value, read.corpus);
  const standing = standingTouched(ws.root, base.value, head.value, onMain.instructions);
  // The rules the close commit would record as wording-only edits, judged here as the landing will (BR-2358, BR-2239, #166).
  const wording = previewWording(ws, read.corpus, subject);
  if (!wording.ok) return { kind: "failed", message: `the rules the close commit would record as wording-only edits cannot be computed: ${wording.error}` };
  const needs = [...new Set([...scope.reviewed, ...wording.questions.map((q) => q.id), ...standing])];
  if (needs.length === 0) return { kind: "nothing", behind, main: main.value };
  if (!onMain.review) return { kind: "unconfigured", needs, main: main.value };
  // Other domains' rules and decisions sharing names with the changed ones: a hint, never part of the verdict (BR-2387).
  const related = scope.changedDocs.filter((d) => d.kind === "rule" || d.kind === "decision").flatMap((d) => relatedLines(d, relatedElsewhere(read.corpus, d)));
  if (onMain.review === REVIEW_NONE) return { kind: "off", behind, main: main.value, related, wording: wording.questions.map((q) => q.id) };

  const running: Running = {};
  const tree = reviewTree(ws, running, main.value);
  // reason: a signal must stop the reviewer and remove the temporary worktree, as it does for a landing (BR-2296, BR-2216)
  const onSignal = (signal: NodeJS.Signals) => {
    running.review?.kill();
    tree.release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const limits = { timeoutMs: onMain.reviewTimeoutMs, kind: "preview" as const, track: (r: { kill(): void } | undefined) => (running.review = r) };
  const findings: { review: "rule" | "duplicate"; text: string }[] = [];
  let blocked = false;
  let reusedFrom: number | undefined;
  let rule: { hash: string; verdict: "ok" | "block"; findings: readonly string[]; wording?: Readonly<Record<string, string>> } | undefined;
  try {
    if (scope.reviewed.length > 0 || wording.questions.length > 0) {
      const architecture = architectureOf(ws.root, base.value, head.value);
      if (!architecture.ok) return { kind: "failed", message: architecture.error.message };
      const calls = reviewCalls(ws.root, read.corpus, scope.changedDocs, { deleted: scope.deleted, readmes: scope.readmes, deletedReadmes: scope.deletedReadmes, change: findDoc(read.corpus, subject), wording: wording.questions, ...(architecture.value ? { architecture: architecture.value } : {}) }, onMain.reviewMaxPromptBytes);
      if (!calls.ok) return { kind: "failed", message: calls.error.message };
      const prompts = calls.value.prompts;
      // reason: a preview reuses only a passing preview of the same prompts, command and budget, never a landing's pass: the reviewer may be another model for a preview (BR-2361, D-70)
      const hash = reviewKey("preview", onMain.review, onMain.reviewMaxPromptBytes, prompts);
      const earlier = passedReview(ws.db, "preview", hash);
      let v: ReviewVerdict;
      if (earlier) {
        ws.db.event(ws.actor, "review.reused", subject, { review: "preview", docs: scope.reviewed, hash, from: earlier.event, tree: head.value });
        reusedFrom = earlier.event;
        v = { verdict: "ok", findings: earlier.findings, ...(earlier.wording ? { wording: earlier.wording } : {}) };
      } else {
        const at = tree.get();
        if (!at.ok) return { kind: "failed", message: at.error.message };
        const run = await runReviews(onMain.review, at.value, prompts, limits, calls.value.scopes);
        if (!run.ok) return { kind: "failed", message: couldNotRun("rule", run.error.message, at.value, main.value) };
        v = run.value;
      }
      rule = { hash, verdict: v.verdict, findings: v.findings, ...(wording.questions.length > 0 ? { wording: v.wording ?? {} } : {}) };
      findings.push(...v.findings.map((text) => ({ review: "rule" as const, text })));
      blocked ||= v.verdict === "block";
    }
    if (standing.length > 0) {
      const prompt = duplicateReviewPrompt(ws.root, base.value, head.value, standing, onMain.instructions, guide);
      if (!prompt.ok) return { kind: "failed", message: prompt.error.message };
      const at = tree.get();
      if (!at.ok) return { kind: "failed", message: at.error.message };
      const v = await runReview(onMain.review, at.value, prompt.value, limits);
      if (!v.ok) return { kind: "failed", message: couldNotRun("duplicate", v.error.message, at.value, main.value) };
      findings.push(...v.value.findings.map((text) => ({ review: "duplicate" as const, text })));
      blocked ||= v.value.verdict === "block";
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    const gone = tree.release();
    if (!gone.ok) console.error(`canon: ${gone.error.message}`);
  }
  const verdict = blocked ? "block" : "ok";
  ws.db.event(ws.actor, "review.preview", subject, { verdict, findings: findings.length, docs: scope.reviewed, standing, tree: head.value, main: main.value, ...(rule ? { hash: rule.hash, rule: rule.verdict, ruleFindings: rule.findings, ...(rule.wording ? { wording: rule.wording } : {}) } : {}) });
  const answers = wording.questions.map((q) => ({ id: q.id, answer: rule?.wording?.[q.id] }));
  return { kind: verdict, findings, reviewed: needs, behind, main: main.value, related, wording: answers, ...(reusedFrom !== undefined ? { reusedFrom } : {}) };
}

/**
 * The wording questions of the records the close commit would write now (BR-2358): the change's evidence plan on this
 * worktree's commits, as `canon work land --finish` computes it before its close commit (BR-2241, BR-2243). None for a
 * change that is not open.
 */
function previewWording(ws: Workspace, corpus: Corpus, subject: string): { ok: true; questions: ReturnType<typeof wordingQuestions> } | { ok: false; error: string } {
  const change = findDoc(corpus, subject);
  if (change?.kind !== "change" || change.status !== "open") return { ok: true, questions: [] };
  const planned = planClose(ws.db, ws.config, ws.root, ws.config.main, corpus, change);
  if ("error" in planned) return { ok: false, error: planned.error };
  const head = git(ws.root, "rev-parse", "HEAD");
  if (!head.ok) return { ok: false, error: head.error.message };
  return { ok: true, questions: wordingQuestions(ws.root, head.value, corpus, change.id, planned.records) };
}
