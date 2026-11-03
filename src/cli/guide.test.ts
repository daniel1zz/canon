import { describe, expect, it } from "bun:test";
import { assembleGuide, WORKFLOW_GUIDE } from "./guide.ts";

describe("workflow guide", () => {
  it("BR-2090 BR-2063 BR-2085: the guide never says Overlap or out of date, which brief's later lines are found by", () => {
    expect(WORKFLOW_GUIDE).not.toContain("Overlap");
    expect(WORKFLOW_GUIDE).not.toContain("out of date");
  });

  it("assembleGuide puts every domain's lines under the header in rank order, as - items", () => {
    expect(assembleGuide("H:", [[{ rank: 30, text: "c" }, { rank: 10, text: "a" }], [{ rank: 20, text: "b" }]])).toBe("H:\n- a\n- b\n- c");
  });

  it("assembleGuide throws when two lines have the same rank", () => {
    expect(() => assembleGuide("H:", [[{ rank: 1, text: "a" }], [{ rank: 1, text: "b" }]])).toThrow("two workflow guide lines have rank 1");
  });
});
