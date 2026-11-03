import { describe, expect, it } from "bun:test";
import { CHECKS, LAND_CHECKS, LAND_STAGES } from "./checks.ts";

describe("the checks BR-2067 reports on", () => {
  it("BR-2067: CHECKS is every landing stage's reasons in order, then claim and setup", () => {
    expect(LAND_CHECKS).toEqual(LAND_STAGES.flat());
    expect(CHECKS).toEqual([...LAND_CHECKS, "claim", "setup"]);
  });
});
