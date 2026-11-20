import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import { typeNameOf, type Corpus, type Doc } from "../model.ts";
import { section } from "../templates.ts";
import type { DocType } from "../types.ts";
import type { ItemDeclaration, ReadItem } from "./model.ts";
import { readSectionItems } from "./read.ts";

/**
 * What a document's declarations read (BR-2549, BR-2550): the sections with items and how `canon check` treats a
 * mismatch, the `item-mismatch` findings for all documents, and the notes for the documents this work changed.
 */

export interface SectionItems {
  readonly section: string;
  readonly declaration: ItemDeclaration;
  readonly items: readonly ReadItem[];
}

/** Every declared section of a document's type, read by BR-2547; a section the document lacks has no items. */
export function sectionItems(doc: Doc, types: readonly DocType[]): SectionItems[] {
  const type = types.find((t) => t.name === typeNameOf(doc));
  if (type === undefined) return [];
  const out: SectionItems[] = [];
  for (const [name, declaration] of Object.entries(type.items)) {
    const text = section(doc.body, `## ${name}`) ?? "";
    out.push({ section: name, declaration, items: readSectionItems(text, declaration) });
  }
  return out;
}

/** What `canon show --json` lists under `items`: the declared section → items it read (BR-2550). */
export function itemsJson(doc: Doc, types: readonly DocType[]): Record<string, readonly ReadItem[]> {
  return Object.fromEntries(sectionItems(doc, types).map((s) => [s.section, s.items]));
}

interface Problem {
  readonly section: string;
  readonly item: ReadItem;
}

/** Unknown items and items that lack a required slot, children included (BR-2547, BR-2549). */
function problems(items: readonly ReadItem[], sectionName: string): Problem[] {
  const out: Problem[] = [];
  for (const item of items) {
    if (item.problem !== undefined) out.push({ section: sectionName, item });
    out.push(...problems(item.children, sectionName));
  }
  return out;
}

/** The message BR-2549 writes for a note and an `item-mismatch` finding: section, item excerpt, reason. */
export function itemMessage(sectionName: string, item: ReadItem): string {
  // reason: the excerpt is the item's first 40 characters, by code point, so a long item does not flood the line (BR-2549)
  const excerpt = [...item.raw].slice(0, 40).join("");
  return `${sectionName} item ${JSON.stringify(excerpt)} ${item.problem} (BR-2549)`;
}

export interface ItemFinding {
  readonly path: string;
  readonly message: string;
}

/** Every `item-mismatch` finding: the declarations that say `finding`, over every document (BR-2549). */
export function itemFindings(corpus: Corpus): ItemFinding[] {
  const out: ItemFinding[] = [];
  for (const doc of corpus.docs) {
    for (const declared of sectionItems(doc, corpus.types)) {
      if (declared.declaration.onMismatch !== "finding") continue;
      for (const problem of problems(declared.items, declared.section)) out.push({ path: doc.path, message: itemMessage(problem.section, problem.item) });
    }
  }
  return out;
}

/**
 * The notes BR-2549 prints on stderr: the declarations that say `note`, over the documents this work changed — the
 * working tree and untracked files against `base`, and none in the primary checkout.
 */
export function itemNotes(root: string, base: string, corpus: Corpus): Result<string[]> {
  const changed = changedPaths(root, base);
  if (!changed.ok) return changed;
  const out: string[] = [];
  for (const doc of corpus.docs) {
    if (!changed.value.has(doc.path)) continue;
    for (const declared of sectionItems(doc, corpus.types)) {
      if (declared.declaration.onMismatch !== "note") continue;
      for (const problem of problems(declared.items, declared.section)) out.push(`note: ${doc.path}: ${itemMessage(problem.section, problem.item)}`);
    }
  }
  return ok(out);
}

/**
 * The paths under canon/ that differ from `base` or are untracked: the worktree's changes, not only the committed ones
 * (BR-2549). `core.quotePath=false` keeps non-ASCII paths as they are written, so they match document paths.
 */
function changedPaths(root: string, base: string): Result<Set<string>> {
  const diff = git(root, "-c", "core.quotePath=false", "diff", "--name-only", base, "--", "canon");
  if (!diff.ok) return err("io", `the changed documents cannot be listed: ${diff.error.message}`);
  const untracked = git(root, "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--", "canon");
  if (!untracked.ok) return err("io", `the untracked documents cannot be listed: ${untracked.error.message}`);
  const paths = new Set<string>();
  for (const text of [diff.value, untracked.value]) {
    for (const line of text.split("\n")) if (line !== "") paths.add(line);
  }
  return ok(paths);
}
