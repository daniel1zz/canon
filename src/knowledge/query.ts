import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ID_PATTERN, stripCode, type Change, type Corpus, type Doc, type Domain, type Rule } from "./model.ts";

/** Plain scan over the files: the corpus is small enough that an index would only add a second source of truth. */
export interface Hit {
  readonly doc: Doc;
  readonly score: number;
  readonly line: string;
}

export function search(corpus: Corpus, query: string, limit = 20): Hit[] {
  const q = query.trim();
  if (q === "") return [];
  const exactId = /^(BR|D|C|N)-\d+$/i.test(q) ? q.toUpperCase() : undefined;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Hit[] = [];
  for (const doc of corpus.docs) {
    const title = doc.title.toLowerCase();
    const body = doc.body.toLowerCase();
    let score = 0;
    if (exactId && doc.id === exactId) score += 100;
    if (exactId && referencedIds(doc).has(exactId)) score += 10;
    for (const t of terms) {
      if (doc.id.toLowerCase() === t) score += 100;
      if (title.includes(t)) score += 5;
      score += Math.min(count(body, t), 5);
    }
    if (exactId === undefined && terms.length > 1 && !terms.every((t) => title.includes(t) || body.includes(t))) continue;
    if (score > 0) hits.push({ doc, score, line: bestLine(doc.body, exactId ? [exactId.toLowerCase()] : terms) });
  }
  return hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id)).slice(0, limit);
}

/** Every id a document points at: in its text and in its structured fields (a change's rules, a decision's supersedes). */
export function referencedIds(doc: Doc): Set<string> {
  const ids = new Set([...stripCode(doc.body).matchAll(ID_PATTERN)].map((m) => m[0]));
  if (doc.kind === "change") for (const r of doc.rules) ids.add(r);
  if (doc.kind === "decision" && doc.supersedes) ids.add(doc.supersedes);
  return ids;
}

function count(text: string, term: string): number {
  let n = 0;
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) n++;
  return n;
}

function bestLine(body: string, terms: string[]): string {
  const line = body.split("\n").find((l) => terms.some((t) => l.toLowerCase().includes(t)));
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
  readonly target?: Doc;
}

export function contextFor(corpus: Corpus, target: string): Context {
  const t = target.replace(/^\.\//, "").replace(/\/$/, "");
  let domains: Domain[] = [];
  let targetDoc: Doc | undefined;
  const asDoc = findDoc(corpus, t);
  if (asDoc) {
    targetDoc = asDoc;
    const ruleIds = referencedIds(asDoc);
    const names = new Set(corpus.docs.filter((d): d is Rule => d.kind === "rule" && ruleIds.has(d.id)).map((r) => r.domain));
    if (asDoc.kind === "rule") names.add(asDoc.domain);
    domains = corpus.domains.filter((d) => names.has(d.name));
  } else {
    domains = corpus.domains.filter((d) => d.name === t || d.code.some((c) => isUnder(t, c) || isUnder(c, t)));
  }
  const names = new Set(domains.map((d) => d.name));
  const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status === "active" && names.has(d.domain));
  const ruleIds = new Set(rules.map((r) => r.id));
  const mentions = (d: Doc) => [...referencedIds(d)].some((id) => ruleIds.has(id));
  const decisions = corpus.docs.filter((d) => d.kind === "decision" && d.status === "accepted" && mentions(d));
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "open" && (mentions(d) || d.rules.some((r) => ruleIds.has(r))));
  return { domains, rules, decisions, changes, ...(targetDoc ? { target: targetDoc } : {}) };
}

function isUnder(path: string, dir: string): boolean {
  const d = dir.replace(/\/$/, "");
  return path === d || path.startsWith(`${d}/`);
}

export function renderContext(root: string, ctx: Context): string {
  const out: string[] = [];
  if (ctx.target) out.push(`# ${ctx.target.id} ${ctx.target.title}\n\n${ctx.target.body.trim()}\n`);
  for (const d of ctx.domains) {
    out.push(`# Domain: ${d.name}  (code: ${d.code.join(", ")})\n\n${d.body.trim()}\n`);
    for (const r of ctx.rules.filter((x) => x.domain === d.name)) out.push(`## ${r.id} ${r.title}\n\n${r.body.trim()}\n`);
  }
  if (ctx.decisions.length) out.push(`# Decisions\n\n${ctx.decisions.map((d) => `- ${d.id} ${d.title} (${d.path})`).join("\n")}\n`);
  if (ctx.changes.length) out.push(`# Open changes\n\n${ctx.changes.map((c) => `- ${c.id} ${c.title} (${c.path})`).join("\n")}\n`);
  if (out.length === 0) out.push(`No domain, rule or document matches. Domains: lore rule domains\n`);
  return out.join("\n");
}

/** Reads a document's raw file text (for `show`). */
export function rawText(root: string, doc: Doc): string {
  return readFileSync(join(root, doc.path), "utf8");
}
