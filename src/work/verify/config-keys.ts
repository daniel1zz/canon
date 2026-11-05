import { err, ok } from "../../kernel/result.ts";
import { configKey, optionalString, stringValue } from "../../invocation/key.ts";

/** Where `test_command` takes the test file's path (BR-2160). */
export const FILE_PLACEHOLDER = "{file}";

/** canon/config.yaml keys of `canon work test` (C-135). */
export const verifyKeys = {
  testCommand: configKey<string | undefined>({
    key: "test_command",
    doc: "Shell command `canon work test` runs once per selected test file, `{file}` replaced by its path; a `{report}` in it is replaced by the path the command writes a JUnit XML report to, which canon records (BR-2160, BR-2337, D-23, D-64).",
    default: undefined,
    schema: { anyOf: [{ type: "null" }, { type: "string", maxLength: 0 }, { type: "string", pattern: "\\{file\\}" }] },
    read: (v) => {
      const s = stringValue("test_command")(v);
      if (s.ok && s.value !== undefined && !s.value.includes(FILE_PLACEHOLDER)) {
        return err("invalid", `\`test_command\` must contain ${FILE_PLACEHOLDER}, where the test file's path goes (e.g. "bun test ${FILE_PLACEHOLDER}")`);
      }
      return s;
    },
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 40,
    checked: 60,
  }),
  typecheckCommand: configKey<string | undefined>({
    key: "typecheck_command",
    doc: "Shell command `canon work test` runs once before the selected test files, such as the floor's type-check step; unset runs none (BR-2226).",
    default: undefined,
    schema: optionalString,
    read: stringValue("typecheck_command"),
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 45,
    checked: 65,
  }),
  testJobs: configKey<number | "auto">({
    key: "test_jobs",
    doc: "The most test files `canon work test` runs at once: a whole number of at least 1, or `auto` (half of the CPUs); another file is started only while a CPU is idle, so 1 means one at a time (BR-2302, D-56).",
    default: "auto",
    schema: { oneOf: [{ type: "integer", minimum: 1 }, { const: "auto" }, { type: "null" }], default: "auto" },
    read: (v) => (v === null || v === "auto" ? ok("auto") : typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`test_jobs` must be a whole number of at least 1, or `auto`")),
    listed: 46,
    checked: 66,
  }),
  alwaysTests: configKey<readonly string[]>({
    key: "always_tests",
    doc: "Globs of test files (among those `tests` finds) that `canon work test` selects on every run, reason `always`: tests a change can break without being imported by it or naming its rules, such as ones that read the whole source tree (BR-2297).",
    default: [],
    schema: { type: ["array", "null"], items: { type: "string", minLength: 1 }, default: [] },
    read: (v) => {
      if (v === null) return ok([]);
      if (!Array.isArray(v) || v.some((g) => typeof g !== "string" || g === "")) return err("invalid", "`always_tests` must be a list of test file globs, each a non-empty string");
      return ok(v as string[]);
    },
    listed: 47,
    checked: 67,
  }),
};
