import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { stripCode, type Change, type Corpus, type Decision, type Doc, type Domain, type Extra, type Rule } from "../documents/model.ts";
import { idsIn, type DocType } from "../documents/types.ts";
import { tokens } from "./bigrams.ts";
import { businessListing } from "../domains/business.ts";

/** Plain scan over the files: the corpus is small enough that an index would only add a second source of truth. */
export interface Hit {
  readonly doc: Doc;
  readonly score: number;
  readonly line: string;
  /** How many of the query's words the document contains; equals `terms` for an id search (BR-2073). */
  readonly matched: number;
  readonly terms: number;
  /** How many of the query's words it contains as written, not only by most of their character pairs (BR-2422). */
  readonly exact: number;
}

/** The distinct character pairs and Latin words of a search word, when it has at least two (BR-2422). */
const pairsOf = (term: string): string[] => {
  const t = [...new Set(tokens(term))];
  return t.length >= 2 ? t : [];
};

export function search(corpus: Corpus, query: string, limit = 20): Hit[] {
  const q = query.trim();
  if (q === "") return [];
  const exactId = isIdQuery(corpus, q) ? q.toUpperCase() : undefined;
  const terms = [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))];
  const hits: Hit[] = [];
  for (const doc of corpus.docs) {
    const title = doc.title.toLowerCase();
    const body = doc.body.toLowerCase();
    let score = 0;
    if (exactId) {
      // An id matches whole ids only: BR-1 never matches BR-12 (BR-2008).
      if (doc.id === exactId) score += 100;
      if (referencedIds(doc, corpus.types).has(exactId) || new RegExp(`\\b${exactId}\\b`).test(doc.body)) score += 10;
      if (score > 0) hits.push({ doc, score, line: bestLine(doc.body, [exactId.toLowerCase()]), matched: 1, terms: 1, exact: 1 });
      continue;
    }
    let matched = 0;
    let exact = 0;
    let docPairs: Set<string> | undefined;
    const near: string[] = [];
    for (const t of terms) {
      if (doc.id.toLowerCase() === t) score += 100;
      if (title.includes(t)) score += 5;
      score += Math.min(count(body, t), 5);
      if (doc.id.toLowerCase() === t || title.includes(t) || body.includes(t)) {
        matched++;
        exact++;
        continue;
      }
      // reason: a Chinese phrase written with other words in between still matches by most of its character pairs (BR-2422, D-90)
      const pairs = pairsOf(t);
      if (pairs.length === 0) continue;
      docPairs ??= new Set(tokens(`${doc.title}\n${doc.body}`));
      const have = pairs.filter((p) => docPairs!.has(p));
      if (have.length * 2 <= pairs.length) continue;
      matched++;
      score += have.length;
      near.push(...have);
    }
    if (matched > 0) hits.push({ doc, score, line: bestLine(doc.body, terms, near), matched, terms: terms.length, exact });
  }
  // reason: documents with every word come first, then partial ones by words matched (BR-2073)
  // reason: among those, words found as written come before words found only by their character pairs (BR-2422)
  return hits.sort((a, b) => b.matched - a.matched || b.exact - a.exact || b.score - a.score || a.doc.id.localeCompare(b.doc.id)).slice(0, limit);
}

/** True when a query is a single document id, which gets no hint (BR-2133). */
export function isIdQuery(corpus: Corpus, query: string): boolean {
  const upper = query.trim().toUpperCase();
  return corpus.types.some((t) => new RegExp(`^${t.prefix}-\\d+$`).test(upper));
}

export const SEARCH_HINT = "no document contains every word: canon/ is written in Chinese, so try Chinese keywords (canon search 合入), or an id (canon search BR-12)";

/** Text lines of a search's output: partial hits marked with how many words they contain, the hint when nothing has every word (BR-2073, BR-2133). */
export function renderSearch(hits: readonly Hit[], idQuery: boolean): string[] {
  const out = hits.map((h) => `${h.doc.id.padEnd(8)} ${h.doc.title}${h.matched < h.terms ? `  [${h.matched}/${h.terms} words]` : ""}\n         ${h.line}`);
  if (hits.length === 0) out.push("(no match)");
  if (!idQuery && !hits.some((h) => h.matched === h.terms)) out.push(SEARCH_HINT);
  return out;
}

/** Every id a document points at: in its text and in its structured fields (a change's rules, a decision's supersedes). */
export function referencedIds(doc: Doc, types: readonly DocType[]): Set<string> {
  const ids = idsIn(types, stripCode(doc.body));
  if (doc.kind === "change") for (const r of doc.rules) ids.add(r);
  if (doc.kind === "decision") for (const s of doc.supersedes) ids.add(s);
  if (doc.kind === "decision") for (const a of doc.amends) ids.add(a);
  return ids;
}

/** Accepted decisions that list `id` in their `amends`: the ones a reader of `id` must also read (BR-2140). */
export function amendedBy(corpus: Corpus, id: string): Decision[] {
  return corpus.docs.filter((d): d is Decision => d.kind === "decision" && d.status === "accepted" && d.amends.includes(id));
}

function count(text: string, term: string): number {
  let n = 0;
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) n++;
  return n;
}

/** The first non-heading line holding the most of `pairs`, when one holds any (BR-2422). */
function mostPairs(lines: readonly string[], pairs: readonly string[]): string | undefined {
  let best: string | undefined;
  let most = 0;
  for (const l of lines) {
    if (/^\s*#/.test(l)) continue;
    const n = new Set(tokens(l).filter((p) => pairs.includes(p))).size;
    if (n > most) [best, most] = [l, n];
  }
  return best;
}

function bestLine(body: string, terms: string[], pairs: readonly string[] = []): string {
  const lines = body.split("\n");
  const line = lines.find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? mostPairs(lines, pairs);
  return (line ?? body.split("\n")[0] ?? "").trim().slice(0, 160);
}

export function findDoc(corpus: Corpus, id: string): Doc | undefined {
  const want = id.toUpperCase();
  return corpus.docs.find((d) => d.id === want);
}

/**
 * Whole, current context for a piece of work (design §5): the full domain README and every active rule of
 * each domain involved, plus the accepted decisions and open changes that mention those rules.
 * Target is a repo path (resolved through each domain's `code` directories), a domain name, or a change id.
 */
export interface Context {
  readonly domains: readonly Domain[];
  readonly rules: readonly Rule[];
  readonly decisions: readonly Doc[];
  readonly changes: readonly Change[];
  /** Documents of declared types that mention one of the rules (BR-2053), listed by title. */
  readonly extras: readonly Extra[];
  readonly target?: Doc;
  /** Subdomains of the returned top-level domains that were not returned, by name (BR-2120). */
  readonly others: readonly string[];
  /** For each listed decision (and a decision target) that accepted decisions amend, their ids (BR-2140). */
  readonly amended: ReadonlyMap<string, readonly string[]>;
}

export function contextFor(corpus: Corpus, target: string): Context {
  const t = target.replace(/^\.\//, "").replace(/\/$/, "");
  let domains: Domain[] = [];
  let targetDoc: Doc | undefined;
  const asDoc = findDoc(corpus, t);
  if (asDoc) {
    targetDoc = asDoc;
    const ruleIds = referencedIds(asDoc, corpus.types);
    const names = new Set(corpus.docs.filter((d): d is Rule => d.kind === "rule" && ruleIds.has(d.id)).map((r) => r.domain));
    if (asDoc.kind === "rule") names.add(asDoc.domain);
    domains = withAncestors(corpus, corpus.domains.filter((d) => names.has(d.name)));
  } else if (corpus.domains.some((d) => d.name === t)) {
    // A domain name: that domain with every subdomain under it, and the enclosing domains' READMEs (BR-2113).
    domains = withAncestors(corpus, corpus.domains.filter((d) => d.name === t || d.name.startsWith(`${t}/`)));
  } else {
    // A path: every domain or subdomain whose code covers it, plus the domains enclosing them (BR-2113).
    // A sibling subdomain is left out unless its own code covers the path, which is what makes this narrow.
    domains = withAncestors(corpus, corpus.domains.filter((d) => d.code.some((c) => isUnder(t, c) || isUnder(c, t))));
  }
  const names = new Set(domains.map((d) => d.name));
  // reason: a planned rule is part of the baseline that constrains execution, so it is listed with the active ones (BR-2007, BR-2238)
  const current = (d: Doc): d is Rule => d.kind === "rule" && d.status !== "retired";
  const active = (name: string) => corpus.docs.filter((d): d is Rule => current(d) && d.domain === name);
  const rules = corpus.docs.filter((d): d is Rule => current(d) && names.has(d.domain));
  const tops = new Set(domains.map((d) => d.name.split("/")[0]!));
  const others = corpus.domains.filter((d) => d.parent && tops.has(d.name.split("/")[0]!) && !names.has(d.name)).map((d) => d.name);
  const ruleIds = new Set(rules.map((r) => r.id));
  const mentions = (d: Doc) => [...referencedIds(d, corpus.types)].some((id) => ruleIds.has(id));
  const decisions = corpus.docs.filter((d) => d.kind === "decision" && d.status === "accepted" && mentions(d));
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "open" && (mentions(d) || d.rules.some((r) => ruleIds.has(r))));
  const extras = corpus.docs.filter((d): d is Extra => d.kind === "extra" && mentions(d));
  const amended = new Map<string, string[]>();
  for (const d of [...decisions, ...(targetDoc?.kind === "decision" ? [targetDoc] : [])]) {
    const by = amendedBy(corpus, d.id).map((x) => x.id);
    if (by.length) amended.set(d.id, by);
  }
  return { domains, rules, decisions, changes, extras, others, amended, ...(targetDoc ? { target: targetDoc } : {}) };
}

/** Adds every enclosing domain, keeping corpus order (a parent is read before its subdomains). */
function withAncestors(corpus: Corpus, picked: readonly Domain[]): Domain[] {
  const names = new Set(picked.map((d) => d.name));
  for (const d of picked) for (let p = d.parent; p; p = corpus.domains.find((x) => x.name === p)?.parent) names.add(p);
  return corpus.domains.filter((d) => names.has(d.name));
}

function isUnder(path: string, dir: string): boolean {
  const d = dir.replace(/\/$/, "");
  return path === d || path.startsWith(`${d}/`);
}

/**
 * `full: false` (the CLI default, BR-2112) lists each rule by id and title so an agent reads the domain's
 * shape first and opens only the rules it touches; `full: true` gives every rule's text (`--full`, and the
 * rule review, which needs the whole domain to find contradictions).
 */
export function renderContext(root: string, ctx: Context, opts: { readonly full: boolean; readonly target?: string }): string {
  const out: string[] = [];
  const rulesOf = (domain: Domain, rules: readonly Rule[]) => {
    // reason: --full is read whole (the rule review reads it): it stays in id order so its shape does not change (BR-2007)
    if (opts.full) for (const r of rules) out.push(ruleSection(r));
    else if (rules.length) {
      const grouped = businessListing(domain, rules, (r) => `- ${r.id}${plannedMark(r)}${releaseMark(r)} ${r.title}`);
      const flat = rules.map((r) => `- ${r.id}${plannedMark(r)}${releaseMark(r)} ${r.title}${businessMark(r)}`);
      out.push(`## Rules (${rules.length})\n\n${(grouped.length > 0 ? grouped : flat).join("\n")}\n`);
    }
  };
  const amended = (id: string) => (ctx.amended.has(id) ? ` — partly amended by ${ctx.amended.get(id)!.join(", ")}` : "");
  if (ctx.target) out.push(`# ${ctx.target.id} ${ctx.target.title}${amended(ctx.target.id)}\n\n${ctx.target.body.trim()}\n`);
  for (const d of ctx.domains) {
    out.push(`# Domain: ${d.name}  (code: ${d.code.length ? d.code.join(", ") : `through ${d.parent ?? "the enclosing domain"}`})\n\n${d.body.trim()}\n`);
    rulesOf(d, ctx.rules.filter((x) => x.domain === d.name));
  }
  if (ctx.others.length) out.push(`Other subdomains, not included: ${ctx.others.join(", ")} (canon context <name>)\n`);
  if (ctx.decisions.length) out.push(`# Decisions\n\n${ctx.decisions.map((d) => `- ${d.id} ${d.title} (${d.path})${amended(d.id)}`).join("\n")}\n`);
  if (ctx.changes.length) out.push(`# Open changes\n\n${ctx.changes.map((c) => `- ${c.id} ${c.title} (${c.path})`).join("\n")}\n`);
  for (const type of [...new Set(ctx.extras.map((e) => e.type))]) {
    const of = ctx.extras.filter((e) => e.type === type);
    out.push(`# ${type}\n\n${of.map((e) => `- ${e.id} ${e.title}${e.status ? ` [${e.status}]` : ""} (${e.path})`).join("\n")}\n`);
  }
  if (out.length === 0) out.push(`No domain, rule or document matches. Domains: canon rule domains\n`);
  else if (!opts.full && ctx.rules.length) out.push(`Rules are listed by title. Read the ones you touch: canon show <id>; every rule's text: canon context ${opts.target ?? "<target>"} --full\n`);
  return out.join("\n");
}

/** One rule's id, title and whole text, as `renderContext` prints it with `full: true`. */
export const ruleSection = (r: Rule): string => `## ${r.id}${plannedMark(r)}${releaseMark(r)} ${r.title}${businessMark(r)}\n\n${r.body.trim()}\n`;

/** ` [release R-1]` or ` [release R-1, changed in R-2, R-3]` after a tagged rule's id, nothing for a rule that belongs to no release (D-61). */
export const releaseMark = (d: Doc): string => (d.kind === "rule" && d.release !== undefined ? ` [release ${d.release}${d.changedIn?.length ? `, changed in ${d.changedIn.join(", ")}` : ""}]` : "");

/** ` [business: <name>]` after a rule that names one, in a domain whose listing is not grouped (BR-2007, BR-2430). */
export const businessMark = (d: Doc): string => (d.kind === "rule" && d.business !== undefined ? ` [business: ${d.business}]` : "");

/** ` [规划中]` after a planned rule's id, nothing otherwise (BR-2238). */
export const plannedMark = (d: Doc): string => (d.kind === "rule" && d.status === "planned" ? " [规划中]" : "");

/** Reads a document's raw file text (for `show`). */
export function rawText(root: string, doc: Doc): string {
  return readFileSync(join(root, doc.path), "utf8");
}
