/**
 * Word-free full text for a corpus written mostly in Chinese (D-90): a run of Han characters gives its overlapping
 * character pairs (a lone character gives itself), a run of Latin letters and digits gives one lowercase word.
 * Pairs need no dictionary and still match a phrase written with other words in between (规则的评审 vs 规则评审).
 */

const HAN = /\p{Script=Han}+/gu;
const WORD = /[a-z][a-z0-9_]*/g;

/** The tokens of a text, repeats kept (BR-2387, BR-2422). */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HAN)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  // reason: a Latin word of one letter says nothing, and digits alone are id numbers the reference graph already covers
  for (const m of text.toLowerCase().matchAll(WORD)) if (m[0].length >= 2) out.push(m[0]);
  return out;
}

/** Okapi BM25's usual constants. */
const K1 = 1.2;
const B = 0.75;

export interface TextIndex {
  /** Term frequencies per document key. */
  readonly tf: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly length: ReadonlyMap<string, number>;
  readonly df: ReadonlyMap<string, number>;
  readonly size: number;
  readonly avgLength: number;
}

export function textIndex(docs: ReadonlyMap<string, string>): TextIndex {
  const tf = new Map<string, Map<string, number>>();
  const length = new Map<string, number>();
  const df = new Map<string, number>();
  let total = 0;
  for (const [key, text] of docs) {
    const counts = new Map<string, number>();
    const ts = tokens(text);
    for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tf.set(key, counts);
    length.set(key, ts.length);
    total += ts.length;
  }
  return { tf, length, df, size: docs.size, avgLength: docs.size ? total / docs.size : 0 };
}

export const idf = (index: TextIndex, term: string): number => {
  const n = index.df.get(term) ?? 0;
  return Math.log(1 + (index.size - n + 0.5) / (n + 0.5));
};

export interface TextScore {
  readonly score: number;
  /** The query terms in the document, the ones adding most to the score first. */
  readonly shared: readonly string[];
}

/** BM25 of every indexed document against the distinct terms of `query`; documents sharing no term are left out. */
export function bm25(index: TextIndex, query: readonly string[]): Map<string, TextScore> {
  const terms = [...new Set(query)];
  const out = new Map<string, TextScore>();
  for (const [key, counts] of index.tf) {
    const norm = K1 * (1 - B + (B * index.length.get(key)!) / (index.avgLength || 1));
    const parts: [string, number][] = [];
    for (const t of terms) {
      const f = counts.get(t);
      if (f === undefined) continue;
      parts.push([t, (idf(index, t) * f * (K1 + 1)) / (f + norm)]);
    }
    if (parts.length === 0) continue;
    parts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.set(key, { score: parts.reduce((s, p) => s + p[1], 0), shared: parts.map((p) => p[0]) });
  }
  return out;
}
