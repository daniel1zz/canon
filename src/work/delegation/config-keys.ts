import { configKey, MINUTE, positiveNumber, positiveValue, REL_DIR, relPath, TUNABLE, optional } from "../../invocation/key.ts";
import { err, ok } from "../../kernel/result.ts";

export const delegationKeys = {
  designPaths: configKey<readonly string[]>({
    key: "design_paths",
    doc: "Repository-relative design contract files pinned from main when delegating a change (BR-2497).",
    default: [],
    schema: { type: "array", items: relPath, default: [] },
    read: (v) => Array.isArray(v) && v.every((p) => typeof p === "string" && REL_DIR.test(p)) ? ok(v as string[]) : err("invalid", "`design_paths` must be a list of repository-relative file paths"),
    flow: {
      steps: ["start.delegate"],
      role: optional("[]（默认）：派活时不固定设计文件"),
    },
    listed: 145,
    checked: 81,
  }),
  delegationStallMs: configKey<number>({
    key: "delegation_stall_minutes",
    doc: "How long a delegated change may have no live worker and no new commit before it shows as stalled (BR-2522).",
    default: 60 * MINUTE,
    schema: positiveNumber(60),
    read: positiveValue("delegation_stall_minutes", MINUTE),
    flow: {
      steps: ["start.delegate"],
      role: TUNABLE,
    },
    listed: 146,
    checked: 82,
  }),
  delegateMaxWorkers: configKey<number>({
    key: "delegate_max_workers",
    doc: "How many delegations may hold a worker slot at once; canon work delegate refuses a new worker beyond it (BR-2526).",
    default: 10,
    schema: { type: "integer", minimum: 1, default: 10 },
    read: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`delegate_max_workers` must be a whole number of at least 1")),
    flow: {
      steps: ["start.delegate"],
      role: TUNABLE,
    },
    listed: 221,
    checked: 221,
  }),
  delegateMaxLoadPerCpu: configKey<number>({
    key: "delegate_max_load_per_cpu",
    doc: "The 5-minute load average per CPU at which canon work delegate refuses a new worker (BR-2526).",
    default: 2,
    schema: positiveNumber(2),
    read: positiveValue("delegate_max_load_per_cpu", 1),
    flow: {
      steps: ["start.delegate"],
      role: TUNABLE,
    },
    listed: 222,
    checked: 222,
  }),
  designProfiles: configKey<readonly string[]>({
    key: "design_profiles",
    doc: "The worker profiles (CANON_WORKER_PROFILE, recorded when the worker's session starts) whose workers may open changes and chores and land design documents, read from main (BR-2633, D-162). Default none: every worker only implements.",
    default: [],
    schema: { type: ["array", "null"], items: { type: "string", minLength: 1 }, default: [] },
    read: (v) => {
      if (v === null) return ok([]);
      if (!Array.isArray(v) || v.some((p) => typeof p !== "string" || p.trim() === "")) return err("invalid", "`design_profiles` must be a list of worker profile names, each a non-empty string");
      return ok((v as string[]).map((p) => p.trim()));
    },
    flow: {
      steps: ["start.delegate"],
      role: optional("[]（默认）：worker 都只实现，不能开变更、不能合入设计"),
    },
    listed: 233,
    checked: 233,
  }),
};
