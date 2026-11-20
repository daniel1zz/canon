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
  /** Its `S<n>` id, written first on its line (BR-2504); every criterion has one. */
  readonly id: string;
  /** The first line without its list marker, its id and its state marker. */
  readonly text: string;
  readonly state: CriterionState;
  /** The document ids a met criterion cites; empty for any other state. */
  readonly evidence: readonly string[];
}

/** A top-level list item of `## 成功标准`, numbered or not (BR-2504, BR-2567). */
export interface CriterionItem {
  /** Its place among the section's top-level items, from 1: `<doc>#<position>` names it (BR-2567). */
  readonly position: number;
  /** The index of its first line in the body's lines. */
  readonly line: number;
  /** The list marker with the spaces after it, e.g. `- ` or `1. `. */
  readonly marker: string;
  /** Its `S<n>` id, undefined when it has none: then it is an explanation, not a criterion (BR-2504, D-151). */
  readonly id?: string;
  /** The first line after the marker. */
  readonly first: string;
}

const HEADING = "## 成功标准";
/** A top-level list item: no indent, then `- `, `* ` or `1. `. */
const ITEM = /^((?:[-*]|\d+\.)\s+)(.*)$/;
/** The state marker closing a criterion's first line; brackets and colon either full-width or ASCII. */
const MARKER = /[（(]\s*(已满足|未满足|待负责人)\s*(?:[:：]([^（()）]*))?[）)]\s*$/;

/** A criterion's id: `S` and digits, then a space, at the start of its first line (BR-2504). */
const CRITERION_ID = /^(S\d+) +/;

const STATE_OF: Readonly<Record<string, CriterionState>> = { 已满足: "met", 未满足: "unmet", 待负责人: "owner" };

/** The section's line range [start, end) after its heading; undefined when the body has no `## 成功标准`. */
export function criteriaSection(lines: readonly string[]): { start: number; end: number } | undefined {
  const at = lines.findIndex((l) => l.trimEnd() === HEADING);
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1).findIndex((l) => /^#{1,2}\s/.test(l));
  return { start: at + 1, end: rest < 0 ? lines.length : at + 1 + rest };
}

/** Every top-level list item of `## 成功标准`, in document order (BR-2504, BR-2567). */
export function criterionItems(body: string): CriterionItem[] {
  const lines = body.split("\n");
  const range = criteriaSection(lines);
  if (!range) return [];
  const out: CriterionItem[] = [];
  for (let i = range.start; i < range.end; i++) {
    const item = ITEM.exec(lines[i]!);
    if (!item) continue;
    const first = item[2]!.trim();
    const named = CRITERION_ID.exec(first);
    out.push({ position: out.length + 1, line: i, marker: item[1]!, first, ...(named ? { id: named[1]! } : {}) });
  }
  return out;
}

/** The criteria of a release or feature body, in document order: only items with an `S<n>` id count (BR-2504, D-151). */
export function criteriaOf(body: string, types: readonly DocType[]): Criterion[] {
  return criterionItems(body).flatMap((item) => (item.id === undefined ? [] : [criterionOf(item.id, item.first)]));

  function criterionOf(id: string, first: string): Criterion {
    const rest = first.slice(CRITERION_ID.exec(first)![0].length);
    const m = MARKER.exec(rest);
    const text = (m ? rest.slice(0, m.index) : rest).trimEnd();
    if (!m) return { id, text, state: "unproven", evidence: [] };
    const state = STATE_OF[m[1]!]!;
    if (state !== "met") return { id, text, state, evidence: [] };
    // reason: ids in backticks are examples, as canon check reads references; a met criterion needs a real one (BR-2504)
    const evidence = [...idsIn(types, stripCode(m[2] ?? ""))];
    return evidence.length > 0 ? { id, text, state, evidence } : { id, text, state: "unproven", evidence: [] };
  }
}

/** `成功标准 <n> 条：已满足 a  未满足 b  待负责人 c  未证明 d` (BR-2505, BR-2506). */
export function criteriaCountLine(criteria: readonly Criterion[]): string {
  return `成功标准 ${criteria.length} 条：${CRITERION_ORDER.map((k) => `${CRITERION_LABEL[k]} ${criteria.filter((c) => c.state === k).length}`).join("  ")}`;
}
