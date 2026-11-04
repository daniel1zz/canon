import { err, ok } from "../../kernel/result.ts";
import { configKey } from "../../config/key.ts";

/** canon/config.yaml keys of `canon check` (C-135). */
export const checkKeys = {
  tests: configKey<readonly string[] | undefined>({
    key: "tests",
    doc: "Globs of test files scanned for rule ids; unset means the default discovery (BR-2046).",
    default: undefined,
    schema: { type: "array", items: { type: "string" } },
    read: (v) => (!Array.isArray(v) || v.some((t) => typeof t !== "string") ? err("invalid", "`tests` must be a list of globs") : ok(v as string[])),
    listed: 30,
    checked: 70,
  }),
  sessionTextBudget: configKey<number | undefined>({
    key: "session_text_budget",
    doc: "Bytes of text every session loads (root CLAUDE.md, the work guide, skill descriptions) above which canon check and canon work test print a hint, never a finding; unset means no hint (BR-2257, D-37).",
    default: undefined,
    schema: { type: ["integer", "null"], exclusiveMinimum: 0 },
    read: (v) => {
      if (v === null) return ok(undefined);
      return typeof v === "number" && Number.isInteger(v) && v > 0 ? ok(v) : err("invalid", "`session_text_budget` must be a whole number of bytes greater than 0, such as 12000");
    },
    listed: 215,
    checked: 215,
  }),
};
