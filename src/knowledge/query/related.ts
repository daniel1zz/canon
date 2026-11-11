import type { Corpus, Doc } from "../documents/model.ts";
import { idPattern, type DocType } from "../documents/types.ts";
import { bm25, textIndex, tokens, type TextIndex } from "./bigrams.ts";
import { referencedIds } from "./query.ts";

/**
 * The documents most related to a rule or decision (BR-2387, D-90): three rankings fused by reciprocal rank. The
 * reference graph (what it names, what names it, one and two hops), its text against theirs (BM25 over character pairs)
 * and the identifiers they share. Same domain or not. A hint only, never complete: two rules that neither name each
 * other nor share words are not found.
 */

/** An identifier in more of the corpus's live documents than this says nothing about one behaviour (`canon check`, `--json`); a document linked with more is no stepping stone. */
export const COMMON_IN = 10;
/** `canon context` and `canon work review` list this many (BR-2387); the edit hook lists `HOOK_LIMIT` (BR-2421). */
export const RELATED_LIMIT = 10;
export const HOOK_LIMIT = 5;
/** Reciprocal rank fusion's usual constant: a document's share from one ranking is 1 / (K + its rank there). */
export const RRF_K = 60;

const CODE_SPAN = /`([^`\n]+)`/g;
const FENCE = /^```[\s\S]*?^```/gm;

export interface Related {
  readonly doc: Doc;
  /** It names the asked document by id. */
  readonly namesIt: boolean;
  /** The asked document names it by id. */
  readonly namedByIt: boolean;
  /** A live document both are linked with, when they are two hops apart and not one. */
  readonly via?: string;
  /** The identifiers both documents have, rarest first. */
  readonly shared: readonly string[];
  /** The text terms both have, the ones adding most to the text score first. */
  readonly words: readonly string[];
  /** Its first sentence naming the asked document, a shared identifier or one of the first shared terms. */
  readonly sentence?: string;
}

/** Rules not retired (active and planned) and accepted decisions: what a session must stay consistent with. */
export const live = (d: Doc): boolean => (d.kind === "rule" && d.status !== "retired") || (d.kind === "decision" && d.status === "accepted");

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

/** The corpus-wide part of the ranking: built once per corpus, reused for every document asked about. */
export interface RelatedIndex {
  readonly pool: readonly Doc[];
  readonly byId: ReadonlyMap<string, Doc>;
  readonly names: ReadonlyMap<string, Set<string>>;
  readonly frequency: ReadonlyMap<string, number>;
  /** The live documents each live document names, and those that name it. */
  readonly out: ReadonlyMap<string, Set<string>>;
  readonly in: ReadonlyMap<string, Set<string>>;
  readonly text: TextIndex;
}

// reason: section headings (## 规则, ## 例子, ## 背景) are the same template in every document and say nothing about it (BR-2387)
const textOf = (d: Doc): string => `${d.title}\n${d.body.replace(/^\s*#.*$/gm, "")}`;

export function relatedIndex(corpus: Corpus): RelatedIndex {
  const pool = corpus.docs.filter(live);
  const byId = new Map(pool.map((d) => [d.id, d]));
  const names = new Map(pool.map((d) => [d.id, identifiersOf(d, corpus.types)]));
  const frequency = new Map<string, number>();
  for (const set of names.values()) for (const n of set) frequency.set(n, (frequency.get(n) ?? 0) + 1);
  const out = new Map<string, Set<string>>();
  const into = new Map<string, Set<string>>(pool.map((d) => [d.id, new Set<string>()]));
  for (const d of pool) {
    const named = new Set([...referencedIds(d, corpus.types)].filter((id) => id !== d.id && byId.has(id)));
    out.set(d.id, named);
    for (const id of named) into.get(id)!.add(d.id);
  }
  return { pool, byId, names, frequency, out, in: into, text: textIndex(new Map(pool.map((d) => [d.id, textOf(d)]))) };
}

/** Competition ranks (1, 2, 2, 4) of the keys by score, highest first: equal scores share a rank, so no id order sneaks in. */
function ranks(scores: ReadonlyMap<string, number>): Map<string, number> {
  const sorted = [...scores].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  const out = new Map<string, number>();
  sorted.forEach(([key, s], i) => out.set(key, i > 0 && sorted[i - 1]![1] === s ? out.get(sorted[i - 1]![0])! : i + 1));
  return out;
}

const byIdNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** The `limit` live documents most related to `doc`, most related first (BR-2387). `doc` itself may be any rule or decision, live or not. */
export function relatedTo(corpus: Corpus, doc: Doc, limit: number, index: RelatedIndex = relatedIndex(corpus)): Related[] {
  const me = doc.id;
  // The asked document's own links, read from its current text (it may be new, edited, or not live).
  const namedByMe = new Set([...referencedIds(doc, corpus.types)].filter((id) => id !== me && index.byId.has(id)));
  const namingMe = new Set([...(index.in.get(me) ?? [])].filter((id) => id !== me));
  if (!index.byId.has(me)) for (const d of index.pool) if (index.out.get(d.id)!.has(me)) namingMe.add(d.id);
  const direct = new Set([...namedByMe, ...namingMe]);
  const neighbours = (id: string) => new Set([...index.out.get(id)!, ...index.in.get(id)!]);

  // Graph: one hop first, then two hops by how many stepping stones lead there.
  const graph = new Map<string, number>();
  const via = new Map<string, string>();
  for (const id of direct) graph.set(id, 1000);
  for (const m of [...direct].sort(byIdNumber)) {
    const around = neighbours(m);
    // reason: a document linked with most of a domain would make all of them two hops apart (D-90, BR-2387)
    if (around.size > COMMON_IN) continue;
    for (const c of around) {
      if (c === me || direct.has(c)) continue;
      graph.set(c, (graph.get(c) ?? 0) + 1);
      if (!via.has(c)) via.set(c, m);
    }
  }

  // Text: BM25 of each live document against this one's terms.
  const text = bm25(index.text, tokens(textOf(doc)));
  text.delete(me);

  // Shared identifiers, as BR-2387 always counted them: not common, and a link between the two counts as one.
  const mine = identifiersOf(doc, corpus.types);
  const ownNames = index.names.get(me);
  // reason: how common a name is counts the documents other than the asked one (BR-2387)
  const others = (n: string) => (index.frequency.get(n) ?? 0) - (ownNames?.has(n) ? 1 : 0);
  const sharedOf = new Map<string, string[]>();
  for (const other of index.pool) {
    if (other.id === me) continue;
    const theirs = index.names.get(other.id)!;
    const shared = [...mine].filter((n) => (theirs.has(n) || n === other.id) && others(n) <= COMMON_IN);
    if (theirs.has(me) && !shared.includes(me)) shared.push(me);
    if (shared.length === 0) continue;
    shared.sort((a, b) => others(a) - others(b) || a.localeCompare(b));
    sharedOf.set(other.id, shared);
  }

  const fused = new Map<string, number>();
  for (const r of [ranks(graph), ranks(new Map([...text].map(([k, v]) => [k, v.score]))), ranks(new Map([...sharedOf].map(([k, v]) => [k, v.length])))]) {
    for (const [key, rank] of r) fused.set(key, (fused.get(key) ?? 0) + 1 / (RRF_K + rank));
  }
  return [...fused]
    .sort((a, b) => b[1] - a[1] || byIdNumber(a[0], b[0]))
    .slice(0, limit)
    .map(([id]) => {
      const other = index.byId.get(id)!;
      const shared = sharedOf.get(id) ?? [];
      const words = text.get(id)?.shared ?? [];
      const sentence = firstOverlap(other, me, shared, words.slice(0, 3));
      return {
        doc: other,
        namesIt: namingMe.has(id),
        namedByIt: namedByMe.has(id),
        ...(via.has(id) ? { via: via.get(id)! } : {}),
        shared,
        words,
        ...(sentence ? { sentence } : {}),
      };
    });
}

const SENTENCE_MAX = 120;

/** The first sentence of `doc`'s body naming `id`, one of `shared` or one of `words`; headings are not sentences. */
function firstOverlap(doc: Doc, id: string, shared: readonly string[], words: readonly string[]): string | undefined {
  const idRe = new RegExp(`\\b${id}\\b`);
  const sentences = doc.body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .flatMap((l) => l.split(/(?<=[。！？；])/))
    .map((s) => s.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
  const hit = sentences.find((s) => idRe.test(s) || shared.some((n) => s.includes(n)) || words.some((w) => tokens(s).includes(w)));
  if (hit === undefined) return undefined;
  return hit.length > SENTENCE_MAX ? `${hit.slice(0, SENTENCE_MAX - 1)}…` : hit;
}

const isId = (n: string) => /^[A-Z][A-Z0-9]*-\d+$/.test(n);

/** Why a related document is listed: its links with the asked one, then up to 3 shared identifiers and 3 shared terms. */
export function reasons(r: Related, of: string): string {
  const parts: string[] = [];
  if (r.namesIt) parts.push(`names ${of}`);
  if (r.namedByIt) parts.push(`named by ${of}`);
  if (r.via) parts.push(`via ${r.via}`);
  const names = r.shared.filter((n) => n !== of && n !== r.doc.id);
  if (names.length) parts.push(names.slice(0, 3).map((n) => (isId(n) ? n : `\`${n}\``)).join(", ") + (names.length > 3 ? ", …" : ""));
  if (r.words.length) parts.push(`words ${r.words.slice(0, 3).join(" ")}`);
  return parts.join("; ");
}

/** The lines `canon context` and `canon work review` print for `doc`, empty when nothing is related (BR-2387). */
export function relatedLines(doc: Doc, related: readonly Related[]): string[] {
  if (related.length === 0) return [];
  return [
    `Related to ${doc.id} (references both ways, shared text and names; check they do not contradict it):`,
    ...related.flatMap((r) => [`  ${r.doc.id} ${r.doc.title}  (${reasons(r, doc.id)})`, ...(r.sentence ? [`      ${r.sentence}`] : [])]),
  ];
}
