import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { Corpus, Doc } from "../../../knowledge/documents/model.ts";
import { ARCHITECTURE_FILE, hasContent, overviewText } from "../../../knowledge/check/architecture.ts";
import { duplicatePrompt, SKILL_FILE, standingText, type AddedLines, type DeletedDoc } from "../../../knowledge/review/review.ts";
import { addedLines, restatementIndex, restatementsIn, type Restatement } from "../../../knowledge/check/restatement/restatement.ts";
import { textAt } from "../../../knowledge/check/restatement/work.ts";
import { reviewKeys } from "../../../knowledge/review/config-keys.ts";
import { parseDocFile } from "../../../knowledge/documents/docfile.ts";
import { shippedUnedited } from "../../../install/install.ts";

/**
 * What the rule review and the duplicate review read from a change: which rules, decisions, releases, domain READMEs and
 * standing instructions it adds, edits or deletes between `base` and `head` (any tree-ish). The landing and
 * `canon work review` both build their prompts from it, so the two see the same thing (BR-2009, BR-2143).
 */
export interface ReviewScope {
  /** Every added, edited or deleted file under canon/rules, canon/decisions and canon/releases, paired by exact rename. */
  readonly entries: readonly { status: string; path: string }[];
  /** Files only moved with identical content: not reviewed. */
  readonly renamed: readonly string[];
  /** Files whose only change is the `links` reference records (BR-2425): not reviewed (BR-2009). */
  readonly linksOnly: readonly string[];
  readonly changedDocs: readonly Doc[];
  readonly deleted: readonly DeletedDoc[];
  readonly readmes: readonly string[];
  readonly deletedReadmes: readonly { path: string; text: string }[];
  /** Names for the "review: ..." line. */
  readonly reviewed: readonly string[];
  /** The lines each changed rule or decision that existed at `base` adds or changes; a new one is not listed (BR-2405). */
  readonly added: readonly AddedLines[];
  /** The restatements the text test finds in those lines, and in new rules and decisions, as hints for the review (BR-2405). */
  readonly restatements: readonly Restatement[];
}

/**
 * Which files under canon/rules, canon/decisions and canon/releases a change between `base` and `head` adds, edits or deletes
 * for the review: files only moved with identical content and files whose only change is their `links` records are left out
 * (BR-2009). `canon accept` asks it per landed commit (BR-2462).
 */
export function reviewEntries(wt: string, base: string, head: string): { entries: { status: string; path: string }[]; renamed: string[]; linksOnly: string[] } {
  // core.quotePath=false: git otherwise prints non-ASCII paths quoted and octal-escaped, which match no document.
  // A file only moved, with identical content, is neither changed nor deleted: moving 74 rules into
  // subdomains must not re-review all of them (BR-2009). git pairs exact renames; the blobs are compared too.
  const knowledge = git(wt, "-c", "core.quotePath=false", "diff", "--name-status", "--find-renames=100%", base, head, "--", "canon/rules", "canon/decisions", "canon/releases");
  const entries: { status: string; path: string }[] = [];
  const renamed: string[] = [];
  for (const l of knowledge.ok && knowledge.value !== "" ? knowledge.value.split("\n") : []) {
    const [status, from, to] = l.split("\t") as [string, string, string | undefined];
    if (status[0] !== "R" || to === undefined) entries.push({ status: status[0]!, path: from });
    else if (sameBlob(wt, `${base}:${from}`, `${head}:${to}`)) renamed.push(`${from} → ${to}`);
    else entries.push({ status: "D", path: from }, { status: "A", path: to });
  }
  // reason: a reference record (`links`, BR-2425) is machine-written and checked by canon check, not judged by the rule
  // review; re-recording hundreds of confirmations must not re-review every touched document, like a pure move (BR-2009)
  const linksOnly: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.status === "M" && linksOnlyEdit(wt, base, head, e.path)) {
      linksOnly.push(e.path);
      entries.splice(i, 1);
    }
  }
  linksOnly.reverse();
  return { entries, renamed, linksOnly };
}

export function reviewScope(wt: string, base: string, head: string, corpus: Corpus): ReviewScope {
  const { entries, renamed, linksOnly } = reviewEntries(wt, base, head);
  const live = new Set(entries.filter((e) => e.status !== "D").map((e) => e.path));
  const changedDocs = corpus.docs.filter((d) => live.has(d.path));
  const deleted: DeletedDoc[] = entries
    .filter((e) => e.status === "D" && e.path.endsWith(".md") && !e.path.endsWith("/README.md"))
    .map((e) => {
      const old = git(wt, "show", `${base}:${e.path}`);
      const id = e.path.split("/").pop()!.match(/^[A-Z][A-Z0-9]*-\d+/)?.[0] ?? e.path;
      return { id, path: e.path, text: old.ok ? old.value : "" };
    });
  const readmes = corpus.domains.filter((dom) => live.has(dom.path)).map((dom) => dom.name);
  const deletedReadmes = entries.filter((e) => e.status === "D" && e.path.endsWith("/README.md")).map((e) => {
    const old = git(wt, "show", `${base}:${e.path}`);
    return { path: e.path, text: old.ok ? old.value : "" }; // the text on main, like a deleted rule's (BR-2009)
  });
  const reviewed = [...changedDocs.map((d) => d.id), ...deleted.map((d) => `${d.id} (deleted)`), ...readmes.map((n) => `${n} README`), ...deletedReadmes.map((r) => `${r.path} (deleted)`)];
  // reason: only a restatement in lines this landing adds or changes may block, so the review is told which lines those are (BR-2405, D-84)
  const index = restatementIndex(corpus);
  const added: AddedLines[] = [];
  const restatements: Restatement[] = [];
  for (const d of changedDocs.filter((x) => x.kind === "rule" || x.kind === "decision")) {
    const now = readFileSync(join(wt, d.path), "utf8");
    const before = textAt(wt, base, d.path);
    const lines = addedLines(now, before);
    if (before !== undefined) {
      const text = now.split("\n");
      added.push({ id: d.id, path: d.path, lines: [...lines].sort((a, b) => a - b).map((n) => ({ line: n, text: text[n - 1]! })).filter((l) => l.text.trim() !== "") });
    }
    restatements.push(...restatementsIn(index, d, now, lines));
  }
  return { entries, renamed, linksOnly, changedDocs, deleted, readmes, deletedReadmes, reviewed, added, restatements };
}

/**
 * The standing instructions (by main's list) and skills the change adds or edits, for the duplicate review (BR-2143);
 * not the skill files canon wrote and the project left as written (BR-2410).
 */
export function standingTouched(wt: string, base: string, head: string, instructions: readonly string[]): string[] {
  const touched = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=d", base, head);
  const shipped = shippedUnedited(wt);
  return (touched.ok && touched.value !== "" ? touched.value.split("\n") : []).filter((p) => (instructions.includes(p) || SKILL_FILE.test(p)) && !shipped.has(p));
}

/** The architecture overview and the diff the change makes to it, when the project has an overview with content (BR-2009, D-65). */
export function architectureOf(wt: string, base: string, head: string): Result<{ text: string; diff: string } | undefined> {
  // reason: the overview is read as context and never makes a landing that only touches it a review (BR-2009, D-65)
  const overview = overviewText(wt);
  const diff = overview !== undefined && hasContent(overview) ? git(wt, "diff", "--no-color", base, head, "--", ARCHITECTURE_FILE) : undefined;
  if (diff && !diff.ok) return err("io", diff.error.message);
  return ok(diff?.ok ? { text: overview!, diff: diff.value } : undefined);
}

/** The prompt of the duplicate review of `standing`, with the diff of each file (BR-2143). */
export function duplicateReviewPrompt(wt: string, base: string, head: string, standing: readonly string[], instructions: readonly string[], guide: string | undefined): Result<string> {
  const diffs: { path: string; diff: string }[] = [];
  for (const path of standing) {
    const d = git(wt, "-c", "core.quotePath=false", "diff", "--no-color", base, head, "--", path);
    if (!d.ok) return err("io", d.error.message);
    diffs.push({ path, diff: d.value });
  }
  return ok(duplicatePrompt(standing, standingText(wt, instructions), guide, standing.filter((p) => SKILL_FILE.test(p)).map((path) => ({ path, text: readFileSync(join(wt, path), "utf8") })), diffs));
}

/** The review settings canon/config.yaml has at `rev` (main), each read as canon reads it; defaults when it has no config (#115). */
export interface ReviewSettings {
  readonly review: string | undefined;
  /** The verifier of blocking findings after a landing (BR-2442); undefined when unset. */
  readonly reviewTimeoutMs: number;
  readonly reviewMaxPromptBytes: number;
  readonly reviewParallel: number;
  readonly instructions: readonly string[];
}

export function reviewSettingsOn(wt: string, rev: string): Result<ReviewSettings> {
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
  const reviewMaxPromptBytes = field(reviewKeys.reviewMaxPromptBytes);
  if (!reviewMaxPromptBytes.ok) return reviewMaxPromptBytes;
  const reviewParallel = field(reviewKeys.reviewParallel);
  if (!reviewParallel.ok) return reviewParallel;
  const instructions = field(reviewKeys.instructions);
  if (!instructions.ok) return instructions;
  return ok({ review: review.value, reviewTimeoutMs: reviewTimeoutMs.value, reviewMaxPromptBytes: reviewMaxPromptBytes.value, reviewParallel: reviewParallel.value, instructions: instructions.value });
}

/** Whether two `<rev>:<path>` objects are the same blob, i.e. the same bytes. */

/** True when `path` at `base` and `head` differ only in the front-matter `links` records: body and every other key equal. */
function linksOnlyEdit(wt: string, base: string, head: string, path: string): boolean {
  if (!path.endsWith(".md") || path.endsWith("/README.md")) return false;
  const a = git(wt, "show", `${base}:${path}`);
  const b = git(wt, "show", `${head}:${path}`);
  if (!a.ok || !b.ok) return false;
  const pa = parseDocFile(a.value, path);
  const pb = parseDocFile(b.value, path);
  if (!pa.ok || !pb.ok || pa.value.body !== pb.value.body) return false;
  const rest = (x: Record<string, unknown>) => JSON.stringify(Object.entries(x).filter(([k]) => k !== "links").sort((l, r) => (l[0] < r[0] ? -1 : 1)));
  return rest(pa.value.meta) === rest(pb.value.meta);
}

function sameBlob(wt: string, a: string, b: string): boolean {
  const x = git(wt, "rev-parse", a);
  const y = git(wt, "rev-parse", b);
  return x.ok && y.ok && x.value === y.value;
}

/** Why a review that could not run refused the landing, and what its directory lacks (BR-2216). */
export function couldNotRun(kind: "rule" | "duplicate" | "wording", error: string, dir: string, main: string): string {
  return [
    `the ${kind === "wording" ? "wording judgement" : `${kind} review`} could not run: ${error}`,
    // reason: the review runs in a checkout of main's commit, so a command that needs git-ignored files fails there (BR-2216, D-51)
    `  the review command ran in a temporary worktree at ${kind === "wording" ? "main's commit" : "the commit main was on before the landing"} ${main.slice(0, 9)} (${dir}, removed afterwards), which holds only committed files: git-ignored files such as node_modules, .env or *.local.json are not there, so the command must not depend on them`,
  ].join("\n");
}
