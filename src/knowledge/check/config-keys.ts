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
};
