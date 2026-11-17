import { stripCode } from "../documents/model.ts";
import { idsIn, type DocType } from "../documents/types.ts";

/**
 * The success criteria of a release document (`## 成功标准`), each with the state its own marker gives it (BR-2504,
 * D-129). Nothing is inferred: a release whose rules all pass still has every unmarked criterion unproven.
 */

export type CriterionState = "met" | "unmet" | "owner" | "unproven";

export const CRITERION_ORDER: readonly CriterionState[] = ["met", "unmet", "owner", "unproven"];
export const CRITERION_LABEL: Readonly<Record<CriterionState, string>> = { met: "已满足", unmet: "未满足", owner: "待负责人", unproven: "未证明" };

export interface Criterion {
  /** The first line without its list marker and its state marker. */
  readonly text: string;
  readonly state: CriterionState;
  /** The document ids a met criterion cites; empty for any other state. */
  readonly evidence: readonly string[];
}

const HEADING = "## 成功标准";
/** A top-level list item: no indent, then `- `, `* ` or `1. `. */
const ITEM = /^(?:[-*]|\d+\.)\s+(.*)$/;
/** The state marker closing a criterion's first line; brackets and colon either full-width or ASCII. */
const MARKER = /[（(]\s*(已满足|未满足|待负责人)\s*(?:[:：]([^（()）]*))?[）)]\s*$/;

const STATE_OF: Readonly<Record<string, CriterionState>> = { 已满足: "met", 未满足: "unmet", 待负责人: "owner" };

/** The criteria of a release body, in document order; none when it has no `## 成功标准` section or no items in it. */
export function criteriaOf(body: string, types: readonly DocType[]): Criterion[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === HEADING);
  if (start < 0) return [];
  const out: Criterion[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const item = ITEM.exec(line);
    if (item) out.push(criterionOf(item[1]!.trim()));
  }
  return out;

  function criterionOf(first: string): Criterion {
    const m = MARKER.exec(first);
    const text = (m ? first.slice(0, m.index) : first).trimEnd();
    if (!m) return { text, state: "unproven", evidence: [] };
    const state = STATE_OF[m[1]!]!;
    if (state !== "met") return { text, state, evidence: [] };
    // reason: ids in backticks are examples, as canon check reads references; a met criterion needs a real one (BR-2504)
    const evidence = [...idsIn(types, stripCode(m[2] ?? ""))];
    return evidence.length > 0 ? { text, state, evidence } : { text, state: "unproven", evidence: [] };
  }
}

/** `成功标准 <n> 条：已满足 a  未满足 b  待负责人 c  未证明 d` (BR-2505, BR-2506). */
export function criteriaCountLine(criteria: readonly Criterion[]): string {
  return `成功标准 ${criteria.length} 条：${CRITERION_ORDER.map((k) => `${CRITERION_LABEL[k]} ${criteria.filter((c) => c.state === k).length}`).join("  ")}`;
}
