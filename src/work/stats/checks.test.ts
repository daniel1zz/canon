import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKS, LAND_CHECKS, LAND_STAGES } from "./checks.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const rule = readFileSync(join(ROOT, "canon/rules/work/stats/BR-2067.md"), "utf8");

describe("the checks BR-2067 reports on", () => {
  it("BR-2067: the rule takes the list from checks.ts instead of copying it, and every check it names is one", () => {
    expect(rule).toContain("`src/work/stats/checks.ts`");
    expect(existsSync(join(ROOT, "src/work/stats/checks.ts"))).toBe(true);
    expect(rule).toContain("`LAND_STAGES`");
    expect(rule).toContain("`CHECKS`");
    // A bare lowercase name in backticks is a check name: event fields (floor_skipped, batched_by), event kinds
    // (batch.fail), flags and paths have `_`, `.`, a leading `-` or `/`.
    const named = [...rule.matchAll(/`([a-z]+(?:-[a-z]+)*)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !CHECKS.includes(n))).toEqual([]);
  });

  it("BR-2067: CHECKS is every landing stage's reasons in order, then claim and setup", () => {
    expect(LAND_CHECKS).toEqual(LAND_STAGES.flat());
    expect(CHECKS).toEqual([...LAND_CHECKS, "claim", "setup"]);
  });
});
