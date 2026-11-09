import type { Corpus, Doc } from "../documents/model.ts";
import { idPattern, type DocType } from "../documents/types.ts";
import { referencedIds } from "./query.ts";

/**
 * The active rules and accepted decisions outside a document's domain that share identifiers with it (BR-2387, #165):
 * the documents that state the same behaviour from another side, so a session sees them before the landing review does.
 * A hint only, never complete: it finds what shares a name, not what means the same thing.
 */

/** An identifier in more of the corpus's live documents than this says nothing about one behaviour (`canon check`, `--json`). */
export const COMMON_IN = 10;
/** At most this many related documents are listed per document; the rest are counted. */
export const RELATED_LIMIT = 10;

const CODE_SPAN = /`([^`\n]+)`/g;
const FENCE = /^```[\s\S]*?^```/gm;

export interface Related {
  readonly doc: Doc;
  /** The identifiers both documents have, rarest first. */
  readonly shared: readonly string[];
}

export interface RelatedList {
  readonly related: readonly Related[];
  /** How many more were found than listed. */
  readonly more: number;
}

const live = (d: Doc): boolean => (d.kind === "rule" && d.status !== "retired") || (d.kind === "decision" && d.status === "accepted");

/**
 * What a document names: the text of its code spans (field names, event names, config keys, commands), and the rule
 * and decision ids it refers to. A code span that is only an id is an example (CLAUDE.md), not a name, and is left out.
 */
export function identifiersOf(doc: Doc, types: readonly DocType[]): Set<string> {
  const ids = idPattern(types);
  const out = new Set<string>();
  for (const m of doc.body.replace(FENCE, "").matchAll(CODE_SPAN)) {
    const span = m[1]!.trim();
    if (span.length < 3) continue;
    if (span.replace(ids, "").trim() === "") continue;
    out.add(span);
  }
  for (const id of referencedIds(doc, types)) out.add(id);
  return out;
}

/** The top-level domain of a rule; decisions belong to none. */
const topOf = (d: Doc): string | undefined => (d.kind === "rule" ? d.domain.split("/")[0] : undefined);

/** Related documents of `doc` outside its top-level domain (BR-2387): sharing at least one identifier that is not common. */
export function relatedElsewhere(corpus: Corpus, doc: Doc): RelatedList {
  const pool = corpus.docs.filter((d) => live(d) && d.id !== doc.id);
  const names = new Map(pool.map((d) => [d.id, identifiersOf(d, corpus.types)]));
  const frequency = new Map<string, number>();
  for (const set of names.values()) for (const n of set) frequency.set(n, (frequency.get(n) ?? 0) + 1);
  const mine = identifiersOf(doc, corpus.types);
  const top = topOf(doc);
  const found: Related[] = [];
  for (const other of pool) {
    // reason: the landing review already reads the whole top-level domain of a changed rule (BR-2036), so only the rest is news
    if (top !== undefined && topOf(other) === top) continue;
    const theirs = names.get(other.id)!;
    // reason: a document this one names, or that names this one, is related by that name too (BR-2387)
    const shared = [...mine].filter((n) => (theirs.has(n) || n === other.id) && (frequency.get(n) ?? 0) <= COMMON_IN);
    if (theirs.has(doc.id) && !shared.includes(doc.id)) shared.push(doc.id);
    if (shared.length === 0) continue;
    shared.sort((a, b) => (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0) || a.localeCompare(b));
    found.push({ doc: other, shared });
  }
  found.sort((a, b) => b.shared.length - a.shared.length || a.doc.id.localeCompare(b.doc.id, undefined, { numeric: true }));
  return { related: found.slice(0, RELATED_LIMIT), more: Math.max(0, found.length - RELATED_LIMIT) };
}

/** The lines of a related list for `doc`, empty when nothing is related (BR-2387). */
export function relatedLines(doc: Doc, list: RelatedList): string[] {
  if (list.related.length === 0) return [];
  const shown = (s: readonly string[]) => s.slice(0, 3).map((n) => (/^[A-Z][A-Z0-9]*-\d+$/.test(n) ? n : `\`${n}\``)).join(", ") + (s.length > 3 ? ", …" : "");
  return [
    `Related to ${doc.id} in other domains (shared names; check they do not contradict it):`,
    ...list.related.map((r) => `  ${r.doc.id} ${r.doc.title}  (${shown(r.shared)})`),
    ...(list.more > 0 ? [`  … and ${list.more} more`] : []),
  ];
}
