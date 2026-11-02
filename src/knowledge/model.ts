/**
 * The knowledge model: four kinds of durable documents, each one Markdown file with YAML front matter,
 * living under `canon/` in the repository and changing through ordinary commits (design §1).
 *
 *   canon/product.md                       purpose, users, non-goals, promises
 *   canon/rules/<domain>/README.md         domain scope, code directories, Terms
 *   canon/rules/<domain>/BR-<n>.md         one rule per file: the current truth (P1)
 *   canon/decisions/D-<n>-<slug>.md        why a non-trivial choice was made (P2)
 *   canon/changes/C-<n>-<slug>.md          one unit of intended work (P3)
 *   canon/notes/N-<n>-<slug>.md            research, retros, references
 *
 * One file per document so concurrent sessions only conflict when they edit the same document
 * (prototype: one file per rule 0% false conflicts vs 53% for a shared append-only file).
 * Ids are allocated by the coordination DB, never by a file in the repo.
 */
export type Kind = "rule" | "decision" | "change" | "note";

export const ID_PREFIX: Record<Kind, string> = { rule: "BR", decision: "D", change: "C", note: "N" };

/** Matches any document id anywhere in text: BR-12, D-3, C-40, N-7. */
export const ID_PATTERN = /\b(BR|D|C|N)-(\d+)\b/g;

export type RuleStatus = "active" | "retired";
export type DecisionStatus = "proposed" | "accepted" | "superseded";
export type ChangeStatus = "open" | "done" | "dropped";

interface Base {
  readonly id: string;
  readonly title: string;
  /** Repo-relative path of the file. */
  readonly path: string;
  readonly body: string;
}

export interface Rule extends Base {
  readonly kind: "rule";
  readonly domain: string;
  readonly status: RuleStatus;
  /** Present when the rule deliberately has no test; the reason is required. */
  readonly untested?: string;
}

export interface Decision extends Base {
  readonly kind: "decision";
  readonly status: DecisionStatus;
  readonly supersedes?: string;
}

export interface Change extends Base {
  readonly kind: "change";
  readonly status: ChangeStatus;
  /** Rule ids this change adds, edits or retires. */
  readonly rules: readonly string[];
}

export interface Note extends Base {
  readonly kind: "note";
}

export type Doc = Rule | Decision | Change | Note;

export interface Domain {
  readonly name: string;
  readonly path: string;
  /** Code directories this domain's rules govern; `canon context <path>` resolves through them. */
  readonly code: readonly string[];
  readonly body: string;
}

export interface Corpus {
  readonly docs: readonly Doc[];
  readonly domains: readonly Domain[];
}

export function kindOfId(id: string): Kind | undefined {
  const prefix = id.split("-")[0];
  return (Object.keys(ID_PREFIX) as Kind[]).find((k) => ID_PREFIX[k] === prefix);
}

/**
 * ASCII slug for file and branch names. A title with any non-ASCII character (e.g. Chinese) gets no slug,
 * so the name carries the id alone: a slug built from the ASCII fragments of a mixed title would mislead.
 */
export function slugify(title: string): string {
  if (/[^\x00-\x7F]/.test(title)) return "";
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Ids written as code (`BR-12`, or inside a fenced block) are examples, not references; this blanks them out. */
export function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}
