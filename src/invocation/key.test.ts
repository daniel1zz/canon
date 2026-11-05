import { describe, expect, it } from "bun:test";
import { CONFIG_KEYS } from "./config.ts";

describe("config keys declared by the domains", () => {
  it("each has its own name, its own place in the known-key list and its own place in the validation order", () => {
    const unique = (xs: readonly unknown[]) => new Set(xs).size === xs.length;
    expect(unique(CONFIG_KEYS.map(([, k]) => k.key))).toBe(true);
    expect(unique(CONFIG_KEYS.map(([, k]) => k.listed))).toBe(true);
    expect(unique(CONFIG_KEYS.map(([, k]) => k.checked))).toBe(true);
    for (const [, k] of CONFIG_KEYS) expect(k.doc.trim()).not.toBe("");
  });

  it("BR-2116: shared is validated after code_root, whose value its reader relies on", () => {
    const at = (key: string) => CONFIG_KEYS.find(([, k]) => k.key === key)![1].checked;
    expect(at("shared")).toBeGreaterThan(at("code_root"));
  });
});
