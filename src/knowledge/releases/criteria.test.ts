import { describe, expect, test } from "bun:test";
import { BUILTIN_TYPES } from "../documents/types.ts";
import { criteriaCountLine, criteriaOf } from "./criteria.ts";
import { migrated, migrationSteps } from "./migrate.ts";

const C = (n: number) => ["C", n].join("-");
const BR = (n: number) => ["BR", n].join("-");
const body = (...items: string[]) => `## 目标\n\n- S1 不是成功标准（已满足：${C(1)}）\n\n## 成功标准\n\n${items.join("\n")}\n\n## 故事地图切片\n\n- S9 也不是（已满足：${C(2)}）\n`;
const one = (item: string) => criteriaOf(body(item), BUILTIN_TYPES);

describe("release success criteria", () => {
  test("BR-2504: a met marker with ids is met with those ids as evidence, full-width or ASCII brackets and colon", () => {
    expect(one(`- S1 规则全部通过。（已满足：${BR(584)}、${C(497)}）`)).toEqual([{ id: "S1", text: "规则全部通过。", state: "met", evidence: [BR(584), C(497)] }]);
    expect(one(`- S2 玩通主线。(已满足: ${C(12)})`)).toEqual([{ id: "S2", text: "玩通主线。", state: "met", evidence: [C(12)] }]);
    expect(one(`1. S6 玩通主线。（已满足：${C(12)}）`)[0]).toMatchObject({ id: "S6", state: "met" });
  });

  test("BR-2504: a met marker without an id, or with ids only in backticks, is unproven", () => {
    expect(one("- S2 玩通主线。（已满足：负责人说可以了）")).toEqual([{ id: "S2", text: "玩通主线。", state: "unproven", evidence: [] }]);
    expect(one("- S2 玩通主线。（已满足）")[0]!.state).toBe("unproven");
    expect(one(`- S2 玩通主线。（已满足：\`${C(12)}\`）`)[0]!.state).toBe("unproven");
  });

  test("BR-2504: unmet and owner markers, with or without a note; no marker or another bracket is unproven", () => {
    expect(one("- S3 五个体系通关。（未满足：还差两个）")).toEqual([{ id: "S3", text: "五个体系通关。", state: "unmet", evidence: [] }]);
    expect(one("- S3 五个体系通关。（未满足）")[0]!.state).toBe("unmet");
    expect(one("- S4 负责人玩通。（待负责人）")).toEqual([{ id: "S4", text: "负责人玩通。", state: "owner", evidence: [] }]);
    expect(one("- S4 负责人玩通。(待负责人: 等试玩)")[0]!.state).toBe("owner");
    expect(one("- S5 不需要人解释。")).toEqual([{ id: "S5", text: "不需要人解释。", state: "unproven", evidence: [] }]);
    expect(one(`- S5 不需要人解释。（见 ${C(4)}）`)).toEqual([{ id: "S5", text: `不需要人解释。（见 ${C(4)}）`, state: "unproven", evidence: [] }]);
  });

  test("BR-2504: only unindented numbered items count, each judged by its first line; other sections and a missing section give none", () => {
    const got = criteriaOf(body("- S1 甲", `  - 子项（已满足：${C(3)}）`, "  续行（已满足：" + C(3) + "）", "* S2 乙（待负责人）"), BUILTIN_TYPES);
    expect(got.map((c) => [c.id, c.text, c.state])).toEqual([["S1", "甲", "unproven"], ["S2", "乙", "owner"]]);
    expect(criteriaOf("## 目标\n\n- S1 x（已满足：" + C(1) + "）\n", BUILTIN_TYPES)).toEqual([]);
    expect(criteriaOf("## 成功标准\n\n内容\n", BUILTIN_TYPES)).toEqual([]);
  });

  test("BR-2504: an item without an S<n> id and a space is an explanation, not a criterion, whatever its marker", () => {
    expect(one("- 验收方式：开发会话自己按清单逐条验收。")).toEqual([]);
    expect(one(`- 负责人玩通主线。（已满足：${C(12)}）`)).toEqual([]);
    expect(one("- S3五个体系各有构筑通关。")).toEqual([]);
    expect(criteriaOf(body("- S1 甲（未满足）", "- 本版由开发会话自己验收。", "- S2 乙"), BUILTIN_TYPES).map((c) => c.id)).toEqual(["S1", "S2"]);
  });

  test("BR-2504: the count line names every state, zeros included", () => {
    const got = criteriaOf(body(`- S1 a（已满足：${C(1)}）`, "- S2 b（待负责人）", "- S3 c", "- 说明"), BUILTIN_TYPES);
    expect(criteriaCountLine(got)).toBe("成功标准 3 条：已满足 1  未满足 0  待负责人 1  未证明 1");
  });
});

describe("migrating criteria written the old way", () => {
  test("BR-2567: unnumbered items get the next free id in order; named notes leave the list for the end of the section with their sub-items", () => {
    const text = body("- S1 甲", "- 乙（未满足）", "- 验收方式：自己验收。", "  - 细节", "- 丙");
    const dry = migrationSteps(text, new Set());
    expect(dry.map((s) => [s.item.position, s.to, s.item.first])).toEqual([[2, "S2", "乙（未满足）"], [3, "S3", "验收方式：自己验收。"], [4, "S4", "丙"]]);
    const steps = migrationSteps(text, new Set([3]));
    expect(steps.map((s) => s.to)).toEqual(["S2", "note", "S3"]);
    const out = migrated(text, steps);
    expect(out).toContain("## 成功标准\n\n- S1 甲\n- S2 乙（未满足）\n- S3 丙\n\n验收方式：自己验收。\n  - 细节\n\n## 故事地图切片");
    expect(criteriaOf(out, BUILTIN_TYPES).map((c) => [c.id, c.state])).toEqual([["S1", "unproven"], ["S2", "unmet"], ["S3", "unproven"]]);
    expect(migrationSteps(out, new Set())).toEqual([]);
  });

  test("BR-2567: an ordered list keeps its marker; a section at the end of the file takes the notes before its trailing blank lines", () => {
    const text = "## 成功标准\n\n1. 丙\n2. 说明\n\n";
    const out = migrated(text, migrationSteps(text, new Set([2])));
    expect(out).toBe("## 成功标准\n\n1. S1 丙\n\n说明\n\n");
  });
});
