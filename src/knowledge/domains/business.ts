import { git } from "../../kernel/git.ts";
import { isPlaceholderLine, section } from "../documents/templates.ts";
import type { Corpus, Domain, Rule } from "../documents/model.ts";

/**
 * The business layer of the baseline (D-96): a domain's README lists the businesses it covers, and each rule names
 * one of them, so the rules that draw one business's boundary can be read together without moving any file.
 * A business name is scoped to its domain: the same name in two domains names two businesses (BR-2430).
 */

/** The README section that lists a domain's businesses (BR-2430). */
export const BUSINESS_SECTION = "## 业务";

export interface Business {
  readonly name: string;
  /** What the README says this business covers; empty when the line says nothing after the name. */
  readonly text: string;
}

const ITEM = /^-\s+\*\*(.+?)\*\*：(.*)$/;

/** The businesses a domain README lists: the `- **<name>**：<what it covers>` lines under `## 业务` (BR-2430). */
export function businessesOf(domain: Domain): readonly Business[] {
  const body = section(domain.body, BUSINESS_SECTION);
  if (body === undefined) return [];
  const out: Business[] = [];
  const seen = new Set<string>();
  for (const line of body.split("\n")) {
    const m = ITEM.exec(line.trim());
    if (!m) continue;
    const name = m[1]!.trim();
    // reason: a name is unique in its domain, so a second line with the same name names the same business (BR-2430)
    // reason: the template's unfilled line is not a business, or a rule could point at `<业务名>` and pass (BR-2430, BR-2035)
    if (name === "" || seen.has(name) || isPlaceholderLine(line)) continue;
    seen.add(name);
    out.push({ name, text: m[2]!.trim() });
  }
  return out;
}

/** The rule files this work added or changed: differences from its base, plus files not tracked yet (BR-2431, as BR-2344). */
function workRuleFiles(root: string, base: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const call of [git(root, "diff", "--name-only", base, "--", "canon/rules"), git(root, "ls-files", "--others", "--exclude-standard", "--", "canon/rules")]) {
    if (!call.ok) continue;
    for (const line of call.value.split("\n")) if (line.trim() !== "") out.add(line.trim());
  }
  return out;
}

export interface BusinessFinding {
  readonly path: string;
  readonly message: string;
}

/**
 * `rule-business-unmapped` for every rule this work added or changed that names no business, or names one its domain
 * does not list (BR-2431). Rules this work did not touch are never reported, so nothing has to be migrated; without a
 * base there is no work to compare with (a main checkout), and nothing is reported at all.
 */
export function businessFindings(root: string, corpus: Corpus, base: string | undefined): readonly BusinessFinding[] {
  if (base === undefined) return [];
  // reason: the main checkout is the primary worktree, not a change; there is no work to compare with, so nothing is reported (BR-2431, as BR-2344)
  const dir = git(root, "rev-parse", "--git-dir");
  const common = git(root, "rev-parse", "--git-common-dir");
  if (!dir.ok || !common.ok || dir.value.trim() === common.value.trim()) return [];
  const touched = workRuleFiles(root, base);
  if (touched.size === 0) return [];
  const listed = new Map<string, readonly string[]>();
  for (const d of corpus.domains) listed.set(d.name, businessesOf(d).map((b) => b.name));
  const out: BusinessFinding[] = [];
  for (const doc of corpus.docs) {
    if (doc.kind !== "rule" || (doc.status !== "active" && doc.status !== "planned")) continue;
    if (!touched.has(doc.path)) continue;
    const names = listed.get(doc.domain) ?? [];
    if (doc.business !== undefined && names.includes(doc.business)) continue;
    const what = doc.business === undefined
      ? `${doc.id} has no \`business\`: this work added or changed it, so it must name one of its domain's businesses`
      : `${doc.id} names business “${doc.business}”, which domain ${doc.domain} does not list`;
    const where = names.length === 0 ? `canon/rules/${doc.domain}/README.md has no ${BUSINESS_SECTION} section yet` : `domain ${doc.domain} lists: ${names.join(", ")}`;
    out.push({ path: doc.path, message: `${what} (${where}): point it at one, or add the new business to canon/rules/${doc.domain}/README.md first (BR-2431)` });
  }
  return out;
}

/**
 * What `canon rule new --domain X` prints before it creates the file: each business the domain lists with the rules
 * that name it, then the rules that name none, so the author sees this business's whole boundary first (BR-2432).
 */
export function contractLines(corpus: Corpus, domainName: string): readonly string[] {
  const domain = corpus.domains.find((d) => d.name === domainName);
  if (!domain) return [];
  const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.domain === domainName && (d.status === "active" || d.status === "planned"));
  const byId = (a: Rule, b: Rule) => a.id.localeCompare(b.id, "en", { numeric: true });
  const businesses = businessesOf(domain);
  const out: string[] = [];
  if (businesses.length === 0) {
    out.push(`domain ${domainName} lists no business yet (${BUSINESS_SECTION} in canon/rules/${domainName}/README.md): write the business there first, then point this rule at it (BR-2430)`);
  } else {
    out.push(`businesses of ${domainName} — a new rule draws a boundary these do not cover yet, or starts a new business (BR-2432):`);
    for (const b of businesses) {
      out.push(`  ${b.name}${b.text === "" ? "" : ` — ${b.text}`}`);
      const of = rules.filter((r) => r.business === b.name).sort(byId);
      if (of.length === 0) out.push("    (no rule yet)");
      for (const r of of) out.push(`    ${r.id} ${r.title}`);
    }
  }
  const loose = rules.filter((r) => r.business === undefined || !businesses.some((b) => b.name === r.business)).sort(byId);
  if (loose.length > 0) {
    out.push(`  in no business (${loose.length}) — they are not migrated, each gets a business when it is next changed (BR-2431):`);
    for (const r of loose) out.push(`    ${r.id} ${r.title}`);
  }
  return out;
}
