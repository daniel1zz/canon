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
  delegateMaxWorkers: configKey<number>({
    key: "delegate_max_workers",
    doc: "How many delegations may hold a worker slot at once; canon work delegate refuses a new worker beyond it (BR-2526).",
    default: 10,
    schema: { type: "integer", minimum: 1, default: 10 },
    read: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`delegate_max_workers` must be a whole number of at least 1")),
    listed: 221,
    checked: 221,
  }),
  delegateMaxLoadPerCpu: configKey<number>({
    key: "delegate_max_load_per_cpu",
    doc: "The 5-minute load average per CPU at which canon work delegate refuses a new worker (BR-2526).",
    default: 2,
    schema: positiveNumber(2),
    read: positiveValue("delegate_max_load_per_cpu", 1),
    listed: 222,
    checked: 222,
  }),
};
