import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus, Doc, Rule } from "../../documents/model.ts";
import { RULE_SECTION, section } from "../../documents/templates.ts";
import { SOURCE_MARK } from "../sources.ts";

/**
 * Sentences in a rule or decision that restate another rule's behaviour instead of only naming it (BR-2401, D-84).
 * The test is textual: a sentence that names `BR-x` and shares at least `MIN_SHARED` runs of `GRAM` tokens with BR-x's
 * 规则 section, not counting runs that are common across the rules. It finds copies and close paraphrases; a restatement
 * in quite other words is left to the rule review (BR-2405).
 */

/** Tokens per run: a CJK character or an ASCII word is one token. */
export const GRAM = 4;
/** Shared runs from which a sentence counts as a restatement (BR-2401). */
export const MIN_SHARED = 10;
/** The longest sentence excerpt a finding shows. */
const EXCERPT = 80;

export interface Restatement {
  /** Repository path of the document the sentence is in. */
  readonly path: string;
  /** 1-based line the sentence starts on. */
  readonly line: number;
  readonly id: string;
  /** The rule the sentence restates. */
  readonly cited: string;
  /** Runs it shares with that rule's 规则 section. */
  readonly shared: number;
  readonly sentence: string;
}

export interface RestatementIndex {
  /** Each active or planned rule's runs of its 规则 section. */
  readonly rules: ReadonlyMap<string, ReadonlySet<string>>;
  /** Runs in more rules than a phrase of the project's own vocabulary would be: never counted. */
  readonly common: ReadonlySet<string>;
}

const ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const RULE_ID = /\bBR-\d+\b/g;
const TOKEN = /[A-Za-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

function grams(text: string): Set<string> {
  const tokens = (text.replace(ID, " ").match(TOKEN) ?? []).map((t) => t.toLowerCase());
  const out = new Set<string>();
  for (let i = 0; i + GRAM <= tokens.length; i++) out.add(tokens.slice(i, i + GRAM).join(" "));
  return out;
}

const live = (d: Doc): d is Rule => d.kind === "rule" && d.status !== "retired";

/** The runs of every active and planned rule's 规则 section, and the ones too common to count (BR-2401). */
export function restatementIndex(corpus: Corpus): RestatementIndex {
  const rules = new Map<string, Set<string>>();
  for (const r of corpus.docs.filter(live)) rules.set(r.id, grams(section(r.body, RULE_SECTION) ?? ""));
  const seen = new Map<string, number>();
  for (const g of rules.values()) for (const x of g) seen.set(x, (seen.get(x) ?? 0) + 1);
  // reason: a run in more than 2% of the rules (at least 3) is the project's vocabulary, not a copied statement (BR-2401)
  const limit = Math.max(3, Math.ceil(rules.size * 0.02));
  const common = new Set([...seen].filter(([, n]) => n > limit).map(([x]) => x));
  return { rules, common };
}

/** The lines of a rule's 规则 section, or of a decision's body, with their 1-based numbers in the file. */
function scanned(doc: Doc, file: string): { no: number; text: string }[] {
  const lines = file.split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    start = end < 0 ? 0 : end + 1;
  }
  let body = lines.map((text, i) => ({ no: i + 1, text })).slice(start);
  if (doc.kind === "rule") {
    const at = body.findIndex((l) => l.text.trim() === RULE_SECTION);
    if (at < 0) return [];
    body = body.slice(at + 1);
    const end = body.findIndex((l) => /^##\s/.test(l.text));
    body = end < 0 ? body : body.slice(0, end);
  }
  return body;
}

/** Sentences of the scanned lines, each with the lines it spans: a paragraph (wrapped lines) is split after 。；！？ or `. ; ! ?` before a space. */
function sentences(lines: readonly { no: number; text: string }[]): { text: string; lines: number[] }[] {
  const out: { text: string; lines: number[] }[] = [];
  let para: { no: number; text: string }[] = [];
  const flush = () => {
    let cur = "";
    let nos: number[] = [];
    for (const l of para) {
      if (!nos.includes(l.no)) nos.push(l.no);
      for (const part of l.text.split(/(?<=[。；！？])|(?<=[.;!?])(?=\s)/)) {
        if (cur === "" && nos.length === 0) nos = [l.no];
        cur += part;
        if (/[。；！？.;!?]\s*$/.test(part)) {
          if (cur.trim() !== "") out.push({ text: cur.trim(), lines: nos });
          cur = "";
          nos = [];
        }
      }
    }
    if (cur.trim() !== "") out.push({ text: cur.trim(), lines: nos });
    para = [];
  };
  for (const l of lines) {
    // reason: a decision's source line quotes its target word for word on purpose (BR-2110); it is not a restatement (BR-2401)
    if (l.text.trim() === "" || /^#/.test(l.text) || l.text.includes(SOURCE_MARK)) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s/.test(l.text)) flush();
    para.push(l);
  }
  flush();
  return out;
}

/**
 * The restatements in `doc`, whose file text is `file`; with `added`, only sentences on at least one of those lines
 * (BR-2402, BR-2403). Sorted by shared runs, most first.
 */
export function restatementsIn(index: RestatementIndex, doc: Doc, file: string, added?: ReadonlySet<number>): Restatement[] {
  if (doc.kind !== "rule" && doc.kind !== "decision") return [];
  const out: Restatement[] = [];
  for (const s of sentences(scanned(doc, file))) {
    if (added && !s.lines.some((n) => added.has(n))) continue;
    const cited = new Set(s.text.match(RULE_ID) ?? []);
    cited.delete(doc.id);
    if (cited.size === 0) continue;
    const mine = grams(s.text);
    for (const id of cited) {
      const theirs = index.rules.get(id);
      if (!theirs) continue;
      let shared = 0;
      for (const g of mine) if (theirs.has(g) && !index.common.has(g)) shared++;
      if (shared >= MIN_SHARED) out.push({ path: doc.path, line: s.lines[0]!, id: doc.id, cited: id, shared, sentence: s.text });
    }
  }
  return out.sort((a, b) => b.shared - a.shared || a.line - b.line);
}

/** The lines of `head` (1-based) whose text is not a line of `base`, each base line matching once; every line when there is no base. */
export function addedLines(head: string, base: string | undefined): Set<number> {
  const lines = head.split("\n");
  if (base === undefined) return new Set(lines.map((_, i) => i + 1));
  const left = new Map<string, number>();
  for (const l of base.split("\n")) left.set(l, (left.get(l) ?? 0) + 1);
  const out = new Set<number>();
  lines.forEach((l, i) => {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else out.add(i + 1);
  });
  return out;
}

/** Every restatement in the current rules (not retired) and decisions (not superseded), most shared first (BR-2401). */
export function corpusRestatements(root: string, corpus: Corpus, index = restatementIndex(corpus)): Restatement[] {
  const docs = corpus.docs.filter((d) => live(d) || (d.kind === "decision" && d.status !== "superseded"));
  return docs.flatMap((d) => restatementsIn(index, d, readFileSync(join(root, d.path), "utf8"))).sort((a, b) => b.shared - a.shared || a.path.localeCompare(b.path) || a.line - b.line);
}

/** One finding as canon prints it: where, what it restates, the excerpt and what to do (BR-2401). */
export function restatementLine(r: Restatement): string {
  const excerpt = r.sentence.length > EXCERPT ? `${r.sentence.slice(0, EXCERPT)}…` : r.sentence;
  return `${r.path}:${r.line}: ${r.id} restates ${r.cited} (${r.shared} runs shared with its 规则 section): "${excerpt}"; keep what ${r.id} adds and name ${r.cited} for the rest`;
}
