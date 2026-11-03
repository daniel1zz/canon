import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripCode, type Change, type Corpus, type Doc, type Domain, type Extra, type Rule } from "./model.ts";
import { idsIn, type DocType } from "./types.ts";

/** Plain scan over the files: the corpus is small enough that an index would only add a second source of truth. */
export interface Hit {
  readonly doc: Doc;
  readonly score: number;
  readonly line: string;
}

export function search(corpus: Corpus, query: string, limit = 20): Hit[] {
  const q = query.trim();
  if (q === "") return [];
  const upper = q.toUpperCase();
  const exactId = corpus.types.some((t) => new RegExp(`^${t.prefix}-\\d+$`).test(upper)) ? upper : undefined;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Hit[] = [];
  for (const doc of corpus.docs) {
    const title = doc.title.toLowerCase();
    const body = doc.body.toLowerCase();
    let score = 0;
    if (exactId) {
      // An id matches whole ids only: BR-1 never matches BR-12 (BR-2008).
      if (doc.id === exactId) score += 100;
      if (referencedIds(doc, corpus.types).has(exactId) || new RegExp(`\\b${exactId}\\b`).test(doc.body)) score += 10;
      if (score > 0) hits.push({ doc, score, line: bestLine(doc.body, [exactId.toLowerCase()]) });
      continue;
    }
    for (const t of terms) {
      if (doc.id.toLowerCase() === t) score += 100;
      if (title.includes(t)) score += 5;
      score += Math.min(count(body, t), 5);
    }
    if (terms.length > 1 && !terms.every((t) => title.includes(t) || body.includes(t))) continue;
    if (score > 0) hits.push({ doc, score, line: bestLine(doc.body, terms) });
  }
  return hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id)).slice(0, limit);
}

/** Every id a document points at: in its text and in its structured fields (a change's rules, a decision's supersedes). */
export function referencedIds(doc: Doc, types: readonly DocType[]): Set<string> {
  const ids = idsIn(types, stripCode(doc.body));
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
  /** Documents of declared types that mention one of the rules (BR-2053), listed by title. */
  readonly extras: readonly Extra[];
  readonly target?: Doc;
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
  const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status === "active" && names.has(d.domain));
  const ruleIds = new Set(rules.map((r) => r.id));
  const mentions = (d: Doc) => [...referencedIds(d, corpus.types)].some((id) => ruleIds.has(id));
  const decisions = corpus.docs.filter((d) => d.kind === "decision" && d.status === "accepted" && mentions(d));
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "open" && (mentions(d) || d.rules.some((r) => ruleIds.has(r))));
  const extras = corpus.docs.filter((d): d is Extra => d.kind === "extra" && mentions(d));
  return { domains, rules, decisions, changes, extras, ...(targetDoc ? { target: targetDoc } : {}) };
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
  if (ctx.target) out.push(`# ${ctx.target.id} ${ctx.target.title}\n\n${ctx.target.body.trim()}\n`);
  for (const d of ctx.domains) {
    out.push(`# Domain: ${d.name}  (code: ${d.code.join(", ")})\n\n${d.body.trim()}\n`);
    const rules = ctx.rules.filter((x) => x.domain === d.name);
    if (opts.full) for (const r of rules) out.push(`## ${r.id} ${r.title}\n\n${r.body.trim()}\n`);
    else if (rules.length) out.push(`## Rules (${rules.length})\n\n${rules.map((r) => `- ${r.id} ${r.title}`).join("\n")}\n`);
  }
  if (ctx.decisions.length) out.push(`# Decisions\n\n${ctx.decisions.map((d) => `- ${d.id} ${d.title} (${d.path})`).join("\n")}\n`);
  if (ctx.changes.length) out.push(`# Open changes\n\n${ctx.changes.map((c) => `- ${c.id} ${c.title} (${c.path})`).join("\n")}\n`);
  for (const type of [...new Set(ctx.extras.map((e) => e.type))]) {
    const of = ctx.extras.filter((e) => e.type === type);
    out.push(`# ${type}\n\n${of.map((e) => `- ${e.id} ${e.title}${e.status ? ` [${e.status}]` : ""} (${e.path})`).join("\n")}\n`);
  }
  if (out.length === 0) out.push(`No domain, rule or document matches. Domains: canon rule domains\n`);
  else if (!opts.full && ctx.rules.length) out.push(`Rules are listed by title. Read the ones you touch: canon show <id>; every rule's text: canon context ${opts.target ?? "<target>"} --full\n`);
  return out.join("\n");
}

/** Reads a document's raw file text (for `show`). */
export function rawText(root: string, doc: Doc): string {
  return readFileSync(join(root, doc.path), "utf8");
}
