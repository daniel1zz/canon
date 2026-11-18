import { configKey, MINUTE, positiveNumber, positiveValue, REL_DIR, relPath } from "../../invocation/key.ts";
import { err, ok } from "../../kernel/result.ts";

export const delegationKeys = {
  designPaths: configKey<readonly string[]>({
    key: "design_paths",
    doc: "Repository-relative design contract files pinned from main when delegating a change (BR-2497).",
    default: [],
    schema: { type: "array", items: relPath, default: [] },
    read: (v) => Array.isArray(v) && v.every((p) => typeof p === "string" && REL_DIR.test(p)) ? ok(v as string[]) : err("invalid", "`design_paths` must be a list of repository-relative file paths"),
    listed: 145,
    checked: 81,
  }),
  delegationStallMs: configKey<number>({
    key: "delegation_stall_minutes",
    doc: "How long a delegated change may have no live worker and no new commit before it shows as stalled (BR-2522).",
    default: 60 * MINUTE,
    schema: positiveNumber(60),
    read: positiveValue("delegation_stall_minutes", MINUTE),
    listed: 146,
    checked: 82,
  }),
};
