import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { stripCode, type Change, type Corpus, type Doc, type Domain, type Extra, type Rule } from "../documents/model.ts";
import { idsIn, type DocType } from "../documents/types.ts";

/** Plain scan over the files: the corpus is small enough that an index would only add a second source of truth. */
export interface Hit {
  readonly doc: Doc;
  readonly score: number;
  readonly line: string;
  /** How many of the query's words the document contains; equals `terms` for an id search (BR-2073). */
  readonly matched: number;
  readonly terms: number;
}

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
      if (score > 0) hits.push({ doc, score, line: bestLine(doc.body, [exactId.toLowerCase()]), matched: 1, terms: 1 });
      continue;
    }
    let matched = 0;
    for (const t of terms) {
      if (doc.id.toLowerCase() === t) score += 100;
      if (title.includes(t)) score += 5;
      score += Math.min(count(body, t), 5);
      if (doc.id.toLowerCase() === t || title.includes(t) || body.includes(t)) matched++;
    }
    if (matched > 0) hits.push({ doc, score, line: bestLine(doc.body, terms), matched, terms: terms.length });
  }
  // reason: documents with every word come first, then partial ones by words matched (BR-2073)
  return hits.sort((a, b) => b.matched - a.matched || b.score - a.score || a.doc.id.localeCompare(b.doc.id)).slice(0, limit);
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
  /** Domains holding code the target file imports, not already among `domains` (BR-2119). */
  readonly imports: readonly ImportedDomain[];
  /** Subdomains of the returned top-level domains that were not returned, by name (BR-2120). */
  readonly others: readonly string[];
}

export interface ImportedDomain {
  readonly domain: Domain;
  /** The imported repo paths that fall in this domain. */
  readonly via: readonly string[];
  /** Empty for a domain under another top-level domain: it is listed by name only (BR-2119). */
  readonly rules: readonly Rule[];
  /** True when the imported domain is under a top-level domain other than the target's. */
  readonly elsewhere: boolean;
}

/** `root` lets a file target bring the domains of the code it imports (BR-2119); without it only matching counts. */
export function contextFor(corpus: Corpus, target: string, root?: string): Context {
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
  const active = (name: string) => corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status === "active" && d.domain === name);
  const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status === "active" && names.has(d.domain));
  const imports: ImportedDomain[] = [];
  if (!targetDoc && root !== undefined && isFile(join(root, t))) {
    const via = new Map<string, string[]>();
    for (const path of importedPaths(root, t)) {
      const owner = deepestOwner(corpus, path);
      if (!owner || names.has(owner.name)) continue;
      via.set(owner.name, [...(via.get(owner.name) ?? []), path]);
    }
    // reason: a behaviour that spans subdomains of one top-level domain is the easy one to miss, so those
    // imports bring their rule titles; other top-level domains are named only, to keep the context short (BR-2119)
    const ownTops = new Set(domains.map((d) => d.name.split("/")[0]!));
    for (const d of corpus.domains) {
      if (!via.has(d.name)) continue;
      const elsewhere = !ownTops.has(d.name.split("/")[0]!);
      imports.push({ domain: d, via: via.get(d.name)!, rules: elsewhere ? [] : active(d.name), elsewhere });
    }
  }
  const shown = new Set([...names, ...imports.map((i) => i.domain.name)]);
  const tops = new Set(domains.map((d) => d.name.split("/")[0]!));
  const others = corpus.domains.filter((d) => d.parent && tops.has(d.name.split("/")[0]!) && !shown.has(d.name)).map((d) => d.name);
  const ruleIds = new Set(rules.map((r) => r.id));
  const mentions = (d: Doc) => [...referencedIds(d, corpus.types)].some((id) => ruleIds.has(id));
  const decisions = corpus.docs.filter((d) => d.kind === "decision" && d.status === "accepted" && mentions(d));
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "open" && (mentions(d) || d.rules.some((r) => ruleIds.has(r))));
  const extras = corpus.docs.filter((d): d is Extra => d.kind === "extra" && mentions(d));
  return { domains, rules, decisions, changes, extras, imports, others, ...(targetDoc ? { target: targetDoc } : {}) };
}

/** The domain whose code path covers a path most specifically (the longest covering path wins). */
function deepestOwner(corpus: Corpus, path: string): Domain | undefined {
  let best: { domain: Domain; length: number } | undefined;
  for (const d of corpus.domains) {
    for (const c of d.code) if (isUnder(path, c) && (!best || c.length > best.length)) best = { domain: d, length: c.length };
  }
  return best?.domain;
}

const SPECIFIERS = [
  /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])import\s*["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Repo paths of the relative imports in a file, read at run time so nothing has to be declared or kept up to
 * date (D-15). A specifier resolves the way bundlers do: as written, with a source extension, or as a
 * directory's index; one that resolves to nothing is kept as written, since matching is by directory anyway.
 */
export function importedPaths(root: string, file: string): string[] {
  const text = readFileSync(join(root, file), "utf8");
  const out = new Set<string>();
  for (const re of SPECIFIERS) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const base = posix.normalize(posix.join(posix.dirname(file), spec));
      if (base.startsWith("../") || base === "..") continue;
      const stem = base.replace(/\.[cm]?jsx?$/, "");
      const candidates = [base, ...RESOLVE_EXTS.map((e) => `${stem}${e}`), ...RESOLVE_EXTS.map((e) => `${base}/index${e}`)];
      out.add(candidates.find((c) => isFile(join(root, c))) ?? base);
    }
  }
  out.delete(file);
  return [...out].sort();
}

function isFile(full: string): boolean {
  return existsSync(full) && statSync(full).isFile();
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
  const rulesOf = (rules: readonly Rule[]) => {
    if (opts.full) for (const r of rules) out.push(`## ${r.id} ${r.title}\n\n${r.body.trim()}\n`);
    else if (rules.length) out.push(`## Rules (${rules.length})\n\n${rules.map((r) => `- ${r.id} ${r.title}`).join("\n")}\n`);
  };
  if (ctx.target) out.push(`# ${ctx.target.id} ${ctx.target.title}\n\n${ctx.target.body.trim()}\n`);
  for (const d of ctx.domains) {
    out.push(`# Domain: ${d.name}  (code: ${d.code.length ? d.code.join(", ") : `through ${d.parent ?? "the enclosing domain"}`})\n\n${d.body.trim()}\n`);
    rulesOf(ctx.rules.filter((x) => x.domain === d.name));
  }
  for (const i of ctx.imports.filter((x) => !x.elsewhere)) {
    out.push(`# Imported domain: ${i.domain.name}  (the target imports ${i.via.join(", ")}; README: canon context ${i.domain.name})\n`);
    rulesOf(i.rules);
  }
  const elsewhere = ctx.imports.filter((x) => x.elsewhere);
  if (elsewhere.length) out.push(`Imported from other domains, not included: ${elsewhere.map((i) => `${i.domain.name} (${i.via.join(", ")})`).join("; ")} (canon context <name>)\n`);
  if (ctx.others.length) out.push(`Other subdomains, not included: ${ctx.others.join(", ")} (canon context <name>)\n`);
  if (ctx.decisions.length) out.push(`# Decisions\n\n${ctx.decisions.map((d) => `- ${d.id} ${d.title} (${d.path})`).join("\n")}\n`);
  if (ctx.changes.length) out.push(`# Open changes\n\n${ctx.changes.map((c) => `- ${c.id} ${c.title} (${c.path})`).join("\n")}\n`);
  for (const type of [...new Set(ctx.extras.map((e) => e.type))]) {
    const of = ctx.extras.filter((e) => e.type === type);
    out.push(`# ${type}\n\n${of.map((e) => `- ${e.id} ${e.title}${e.status ? ` [${e.status}]` : ""} (${e.path})`).join("\n")}\n`);
  }
  if (out.length === 0) out.push(`No domain, rule or document matches. Domains: canon rule domains\n`);
  else if (!opts.full && (ctx.rules.length || ctx.imports.some((i) => i.rules.length))) out.push(`Rules are listed by title. Read the ones you touch: canon show <id>; every rule's text: canon context ${opts.target ?? "<target>"} --full\n`);
  return out.join("\n");
}

/** Reads a document's raw file text (for `show`). */
export function rawText(root: string, doc: Doc): string {
  return readFileSync(join(root, doc.path), "utf8");
}
