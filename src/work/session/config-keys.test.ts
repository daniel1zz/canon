import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REGENERABLE } from "./config-keys.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const rule = readFileSync(join(ROOT, "canon/rules/work/session/BR-2019.md"), "utf8");

describe("the default regenerable names BR-2019 refers to", () => {
  it("BR-2019: the rule takes the default list from config-keys.ts instead of copying it, and each name it gives as an example is on it", () => {
    expect(rule).toContain("`src/work/session/config-keys.ts`");
    expect(existsSync(join(ROOT, "src/work/session/config-keys.ts"))).toBe(true);
    expect(rule).toContain("`DEFAULT_REGENERABLE`");
    const sentence = rule.split("\n").find((l) => l.includes("`DEFAULT_REGENERABLE`"))!;
    const examples = [...sentence.slice(sentence.indexOf("例如"), sentence.indexOf("；", sentence.indexOf("例如"))).matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.filter((n) => !DEFAULT_REGENERABLE.includes(n))).toEqual([]);
  });
});
