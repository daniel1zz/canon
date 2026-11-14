import { err, ok } from "../../kernel/result.ts";
import { configKey, optionalString, stringValue } from "../../invocation/key.ts";
import { REPORT_PLACEHOLDER, REPORT_RECIPES } from "./report.ts";

/** Where `test_command` takes the test file's path (BR-2160). */
export const FILE_PLACEHOLDER = "{file}";

/** canon/config.yaml keys of `canon work test` (C-135). */
export const verifyKeys = {
  testCommand: configKey<string | undefined>({
    key: "test_command",
    doc: "Shell command `canon work test` runs once per selected test file: `{file}` is replaced by its path and `{report}` by the path the command writes a JUnit XML report to, which canon records per test file (BR-2160, BR-2337, D-23, D-64).",
    default: undefined,
    schema: { anyOf: [{ type: "null" }, { type: "string", maxLength: 0 }, { type: "string", allOf: [{ pattern: "\\{file\\}" }, { pattern: "\\{report\\}" }] }] },
    read: (v) => {
      const s = stringValue("test_command")(v);
      if (s.ok && s.value !== undefined) {
        if (!s.value.includes(FILE_PLACEHOLDER)) return err("invalid", `\`test_command\` must contain ${FILE_PLACEHOLDER}, where the test file's path goes, and ${REPORT_PLACEHOLDER}, where the command writes its JUnit XML report\n${REPORT_RECIPES}`);
        if (!s.value.includes(REPORT_PLACEHOLDER)) return err("invalid", `\`test_command\` must contain ${REPORT_PLACEHOLDER}, where the command writes its JUnit XML report: canon reads which tests a file has and whether they run from it (D-64)\n${REPORT_RECIPES}`);
      }
      return s;
    },
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 40,
    checked: 60,
  }),
  testSelectCommand: configKey<string | undefined>({
    key: "test_select_command",
    doc: "Shell command `canon work test` and the floor skip (BR-2164) ask which test files a change can break: it gets the changed repository paths on standard input, one per line, deleted ones included, and prints one test file per line, optionally a tab and why; empty output means none (BR-2346, D-64).",
    default: undefined,
    schema: optionalString,
    read: stringValue("test_select_command"),
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 42,
    checked: 62,
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
  testTimeoutMinutes: configKey<number>({
    key: "test_timeout_minutes",
    doc: "How long one `canon work test` may run in all, in minutes (fractions allowed); past it the run stops like a signal stops it and fails, naming the slowest files and the machine load, since a run that long means the suite or the machine needs looking at (BR-2466). Default 30.",
    default: 30,
    schema: { type: ["number", "null"], exclusiveMinimum: 0, default: 30 },
    read: (v) => (v === null ? ok(30) : typeof v === "number" && v > 0 && Number.isFinite(v) ? ok(v) : err("invalid", "`test_timeout_minutes` must be a number of minutes greater than 0")),
    listed: 220,
    checked: 220,
  }),
};
