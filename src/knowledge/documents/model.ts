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
 * Ids are allocated by the coordination DB, never by a file in the repo. A project can declare more
 * types (./types.ts); each lives in `canon/<dir>/<PREFIX>-<n>-<slug>.md`.
 */
import type { DocType } from "./types.ts";

/** Built-in kinds; a document of a type declared in config (D-2 §2) has kind "extra" and names its type. */
export type Kind = "rule" | "decision" | "change" | "note" | "extra";

/** `planned`: designed, not yet executed; needs no test and blocks no landing (BR-2235, D-32). */
export type RuleStatus = "active" | "retired" | "planned";
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
  /** Code lists the rule names items of instead of copying them; `canon check` compares the two (BR-2180). */
  readonly lists?: readonly CodeList[];
}

/** A rule's `lists` entry: the constant `name` in `file` holds each of `items` as a string literal (BR-2180). */
export interface CodeList {
  readonly file: string;
  readonly name: string;
  readonly items: readonly string[];
}

export interface Decision extends Base {
  readonly kind: "decision";
  readonly status: DecisionStatus;
  readonly supersedes?: string;
  /** Decisions this one changes in part without replacing them (BR-2139). */
  readonly amends: readonly string[];
}

export interface Change extends Base {
  readonly kind: "change";
  readonly status: ChangeStatus;
  /** Rule ids this change adds, edits or retires. */
  readonly rules: readonly string[];
  /** Pass records the close commit wrote: rule id → behaviour hash and method (BR-2237, D-32). Empty when none. */
  readonly passes: Readonly<Record<string, PassRecord>>;
}

/** How a rule's execution was verified (BR-2237): a test the change touched, an acceptance line, or a test that existed at migration. */
export type PassMethod = "test" | "acceptance" | "migration";

/** One pass record: the rule's behaviour hash when it passed, the method, and whether the review judged the edit wording only (BR-2243). */
export interface PassRecord {
  readonly hash: string;
  readonly method: PassMethod;
  readonly wording: boolean;
}

export interface Note extends Base {
  readonly kind: "note";
}

/** A document of a type the project declared in `canon/config.yaml` (BR-2050). */
export interface Extra extends Base {
  readonly kind: "extra";
  /** The declared type's name, e.g. "spec". */
  readonly type: string;
  readonly status: string | undefined;
}

export type Doc = Rule | Decision | Change | Note | Extra;

/** The type name of a document: its kind for built-ins, the declared name otherwise. */
export const typeNameOf = (d: Doc): string => (d.kind === "extra" ? d.type : d.kind);

export interface Domain {
  /** Path under canon/rules with "/" between levels, e.g. "work" or "work/land" (a subdomain, BR-2113). */
  readonly name: string;
  /** The enclosing domain of a subdomain; undefined for a top-level domain. */
  readonly parent?: string;
  readonly path: string;
  /**
   * Code directories this domain's rules govern; `canon context <path>` resolves through them. With a code
   * root it is `<codeRoot>/<name>` by convention; without one, a top-level domain's README `code:` and
   * nothing for a subdomain (D-15).
   */
  readonly code: readonly string[];
  /** What the README's front matter `code:` lists, whether or not the layout allows it (BR-2117). */
  readonly declared: readonly string[];
  readonly body: string;
}

/** Where code lives relative to the domains (D-15): the config's `code_root` and `shared`. */
export interface Layout {
  readonly codeRoot: string | undefined;
  readonly shared: readonly string[];
}

export const NO_LAYOUT: Layout = { codeRoot: undefined, shared: [] };

export interface Corpus {
  readonly docs: readonly Doc[];
  readonly domains: readonly Domain[];
  /** The types the corpus was read with; ids, check and search all follow them. */
  readonly types: readonly DocType[];
  readonly layout: Layout;
  /**
   * The highest number each prefix carries in a file name under its type's directory, counting files that do not
   * parse: such a file still holds its number, so allocation must not hand it out again (BR-2002).
   */
  readonly numbers: Readonly<Record<string, number>>;
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

/**
 * For each line, whether it belongs to a fenced code block (CommonMark): a fence is three or more backticks or tildes;
 * it closes at a line of the same character at least as long, or at the end. A backtick fence whose info string holds
 * a backtick is no fence. Any indentation counts: a fence indented four spaces or more is an indented code block,
 * code either way (BR-2004, BR-2035, BR-2171).
 */
export function fencedLines(lines: readonly string[]): boolean[] {
  let open: { char: string; length: number } | undefined;
  return lines.map((line) => {
    const f = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (open === undefined) {
      if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) open = { char: f[1]![0]!, length: f[1]!.length };
      return open !== undefined;
    }
    if (f && f[1]![0] === open.char && f[1]!.length >= open.length && f[2]!.trim() === "") open = undefined;
    return true;
  });
}

/** The text with its fenced code blocks removed, one empty line per removed line. */
export function withoutFences(text: string): string {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  return lines.map((l, i) => (fenced[i] ? "" : l)).join("\n");
}

/**
 * A code span (CommonMark): a run of backticks, then text on the same line, then a run of exactly as many; so
 * `` a`b` `` is one span (BR-2004).
 */
const CODE_SPAN = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;

/** Ids written as code (`BR-12`, or inside a fenced block) are examples, not references; this blanks them out. */
export function stripCode(markdown: string): string {
  return withoutFences(markdown).replace(CODE_SPAN, " ");
}
