import { technicalLayerWord } from "../documents/domain-names.ts";
import type { Corpus, Rule } from "../documents/model.ts";
import { groupByBusiness } from "./business.ts";

/** `canon rule domains`: what the baseline is divided into — the domains, their code and the businesses each lists (BR-2114). */

/** Above this many direct rules, `canon rule domains` suggests subdomains (BR-2114). */
const SPLIT_HINT = 25;

export function domainLines(corpus: Corpus): readonly string[] {
  const out: string[] = [];
  for (const d of corpus.domains) {
    const rules = corpus.docs.filter((r): r is Rule => r.kind === "rule" && r.domain === d.name && r.status === "active");
    // reason: a hint, not a check: a big domain makes `canon context` long, splitting is a judgement call (BR-2114)
    const hint = rules.length > SPLIT_HINT ? `  (more than ${SPLIT_HINT} rules: consider subdomains, canon rule domain ${d.name}/<name>)` : "";
    const word = technicalLayerWord(d.name);
    // reason: said next to the domain until it is renamed; `canon check` says it as a note too (BR-2318)
    const named = word !== undefined ? `  (named after a technical layer: \`${word}\`; name domains by business capability)` : "";
    const indent = "  ".repeat(d.name.split("/").length - 1);
    out.push(`${`${indent}${d.name}`.padEnd(24)} ${String(rules.length).padStart(4)} rules  ${d.code.length ? d.code.join(", ") : `(code through ${d.name.split("/")[0]})`}${hint}${named}`);
    // reason: a business is a name several rules point at, so the listing is where the shape of a domain is read now (BR-2114, D-96)
    for (const g of groupByBusiness(d, rules)) out.push(`${`${indent}  - ${g.name ?? "in no business"}`.padEnd(24)} ${String(g.rules.length).padStart(4)} rules`);
  }
  return out;
}
