import { describe, expect, test } from "bun:test";
import { BUILTIN_TYPES } from "../documents/types.ts";
import { criteriaCountLine, criteriaOf } from "./criteria.ts";

const C = (n: number) => ["C", n].join("-");
const BR = (n: number) => ["BR", n].join("-");
const body = (...items: string[]) => `## 目标\n\n- 不是成功标准（已满足：${C(1)}）\n\n## 成功标准\n\n${items.join("\n")}\n\n## 故事地图切片\n\n- 也不是（已满足：${C(2)}）\n`;
const one = (item: string) => criteriaOf(body(item), BUILTIN_TYPES);

describe("release success criteria", () => {
  test("BR-2504: a met marker with ids is met with those ids as evidence, full-width or ASCII brackets and colon", () => {
    expect(one(`- 规则全部通过。（已满足：${BR(584)}、${C(497)}）`)).toEqual([{ text: "规则全部通过。", state: "met", evidence: [BR(584), C(497)] }]);
    expect(one(`- 玩通主线。(已满足: ${C(12)})`)).toEqual([{ text: "玩通主线。", state: "met", evidence: [C(12)] }]);
    expect(one(`1. 玩通主线。（已满足：${C(12)}）`)[0]!.state).toBe("met");
  });

  test("BR-2504: a met marker without an id, or with ids only in backticks, is unproven", () => {
    expect(one("- 玩通主线。（已满足：负责人说可以了）")).toEqual([{ text: "玩通主线。", state: "unproven", evidence: [] }]);
    expect(one("- 玩通主线。（已满足）")[0]!.state).toBe("unproven");
    expect(one(`- 玩通主线。（已满足：\`${C(12)}\`）`)[0]!.state).toBe("unproven");
  });

  test("BR-2504: unmet and owner markers, with or without a note; no marker or another bracket is unproven", () => {
    expect(one("- 五个体系通关。（未满足：还差两个）")).toEqual([{ text: "五个体系通关。", state: "unmet", evidence: [] }]);
    expect(one("- 五个体系通关。（未满足）")[0]!.state).toBe("unmet");
    expect(one("- 负责人玩通。（待负责人）")).toEqual([{ text: "负责人玩通。", state: "owner", evidence: [] }]);
    expect(one("- 负责人玩通。(待负责人: 等试玩)")[0]!.state).toBe("owner");
    expect(one("- 不需要人解释。")).toEqual([{ text: "不需要人解释。", state: "unproven", evidence: [] }]);
    expect(one(`- 不需要人解释。（见 ${C(4)}）`)).toEqual([{ text: `不需要人解释。（见 ${C(4)}）`, state: "unproven", evidence: [] }]);
  });

  test("BR-2504: only unindented items count, each judged by its first line; other sections and a missing section give none", () => {
    const got = criteriaOf(body("- 甲", `  - 子项（已满足：${C(3)}）`, "  续行（已满足：" + C(3) + "）", "* 乙（待负责人）"), BUILTIN_TYPES);
    expect(got.map((c) => [c.text, c.state])).toEqual([["甲", "unproven"], ["乙", "owner"]]);
    expect(criteriaOf("## 目标\n\n- x（已满足：" + C(1) + "）\n", BUILTIN_TYPES)).toEqual([]);
    expect(criteriaOf("## 成功标准\n\n内容\n", BUILTIN_TYPES)).toEqual([]);
  });

  test("BR-2504: the count line names every state, zeros included", () => {
    const got = criteriaOf(body(`- a（已满足：${C(1)}）`, "- b（待负责人）", "- c"), BUILTIN_TYPES);
    expect(criteriaCountLine(got)).toBe("成功标准 3 条：已满足 1  未满足 0  待负责人 1  未证明 1");
  });
});
