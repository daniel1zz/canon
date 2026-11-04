import type { Corpus, Rule } from "../../knowledge/documents/model.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { STATE_LABEL, STATE_ORDER, type ExecutionState } from "./state.ts";

/** `canon progress` (BR-2247): execution states per domain, per domain with ids, or for one change's rules. */

const number = (id: string) => Number(id.split("-")[1]);

function countsLine(name: string, rules: readonly Rule[], states: ReadonlyMap<string, ExecutionState>): string {
  const counts = STATE_ORDER.map((k) => `${STATE_LABEL[k]} ${rules.filter((r) => states.get(r.id)?.kind === k).length}`);
  return `${name}  ${counts.join("  ")}`;
}

function idLines(rules: readonly Rule[], states: ReadonlyMap<string, ExecutionState>): string[] {
  const out: string[] = [];
  for (const k of STATE_ORDER) {
    const of = rules.filter((r) => states.get(r.id)?.kind === k).sort((a, b) => number(a.id) - number(b.id));
    if (of.length === 0) continue;
    out.push(`  ${STATE_LABEL[k]}: ${of.map((r) => {
      const s = states.get(r.id)!;
      return s.kind === "passed" || s.kind === "waiting" ? `${r.id} (${s.change})` : r.id;
    }).join(", ")}`);
  }
  return out;
}

/** The lines `canon progress [target]` prints, or undefined when the target is neither a domain nor a change (exit 3). */
export function progressLines(corpus: Corpus, states: ReadonlyMap<string, ExecutionState>, target: string | undefined): string[] | undefined {
  const current = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status !== "retired");
  if (target === undefined) {
    const lines = corpus.domains.map((d) => countsLine(d.name, current.filter((r) => r.domain === d.name), states));
    lines.push(countsLine("合计", current, states));
    return lines;
  }
  const t = target.trim().replace(/\/$/, "");
  const domains = corpus.domains.filter((d) => d.name === t || d.name.startsWith(`${t}/`));
  if (domains.length > 0 && corpus.domains.some((d) => d.name === t)) {
    return domains.flatMap((d) => {
      const rules = current.filter((r) => r.domain === d.name);
      return [countsLine(d.name, rules, states), ...idLines(rules, states)];
    });
  }
  const doc = findDoc(corpus, t);
  if (doc?.kind !== "change") return undefined;
  const listed = new Set(doc.rules);
  const rules = current.filter((r) => listed.has(r.id));
  return [countsLine(doc.id, rules, states), ...idLines(rules, states)];
}
