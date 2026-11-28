import { describe, expect, it } from "bun:test";
import { assembleGuide, GUIDE_TOPICS, guideFor, WORKFLOW_GUIDE } from "./guide.ts";
import { join } from "node:path";

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

  it("BR-2654: every canon guide <topic> the guide names is a topic, every topic is named by the guide, and topic names are unique", () => {
    const named = new Set([...guideFor(join(import.meta.dir, "../..")).matchAll(/canon guide ([a-z]+)/g)].map((m) => m[1]!));
    const topics = GUIDE_TOPICS.map((t) => t.name);
    expect(new Set(topics).size).toBe(topics.length);
    expect([...named].sort()).toEqual(topics.filter((t) => named.has(t)).sort());
    for (const n of named) expect(topics).toContain(n);
    // reason: evidence and lessons are named by canon's always-loaded rules, not by the guide (D-169)
    expect(topics.filter((t) => !named.has(t)).sort()).toEqual(["evidence", "lessons"]);
  });
});
