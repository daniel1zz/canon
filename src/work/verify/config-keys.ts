import { err, ok } from "../../kernel/result.ts";
import { configKey, optionalString, positiveNumber, positiveValue, stringValue, TUNABLE, optional, required } from "../../invocation/key.ts";
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
    flow: {
      steps: ["test.run"],
      role: required("没有它就不记录测试报告，canon check 找不到任何规则的测试"),
    },
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
    flow: {
      steps: ["test.select"],
      role: optional("不写：只挑改过的测试和点名了改过规则的测试"),
    },
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
    flow: {
      steps: ["test.typecheck"],
      role: optional("不写：不做类型检查"),
      idle: (v) => (v === undefined ? "typecheck_command 没写" : undefined),
    },
    listed: 45,
    checked: 65,
  }),
  testJobs: configKey<number | "auto">({
    key: "test_jobs",
    doc: "The most test files `canon work test` runs at once: a whole number of at least 1, or `auto` (half of the CPUs); another file is started only while a CPU is idle, so 1 means one at a time (BR-2302, D-56).",
    default: "auto",
    schema: { oneOf: [{ type: "integer", minimum: 1 }, { const: "auto" }, { type: "null" }], default: "auto" },
    read: (v) => (v === null || v === "auto" ? ok("auto") : typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`test_jobs` must be a whole number of at least 1, or `auto`")),
    flow: {
      steps: ["test.run"],
      role: TUNABLE,
    },
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
    flow: {
      steps: ["test.select"],
      role: optional("[]（默认）：没有每次都跑的测试"),
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
    flow: {
      steps: ["test.run"],
      role: TUNABLE,
    },
    listed: 220,
    checked: 220,
  }),
  fullTestSlots: configKey<number>({
    key: "full_test_slots",
    doc: "The most full test runs (`canon work test` with no test file named, and the background floor of main) that go on at once on this machine, counting every worktree and every project using canon here; the others wait in line and say how many are ahead. Default 1 (BR-2579).",
    default: 1,
    schema: { type: ["integer", "null"], minimum: 1, default: 1 },
    read: (v) => (v === null ? ok(1) : typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`full_test_slots` must be a whole number of at least 1")),
    flow: {
      steps: ["test.run"],
      role: TUNABLE,
    },
    listed: 223,
    checked: 223,
  }),
  heavyMaxLoadPerCpu: configKey<number>({
    key: "heavy_max_load_per_cpu",
    doc: "The 5-minute load average per CPU at which heavy steps (canon work test, a landing's floor and test files, the background floor, canon heavy run) wait in the machine's load queue, and at which a failed background floor counts as failed under overload. Separate from delegate_max_load_per_cpu, which only limits delegating; default 2 (BR-2630, BR-2665, BR-2666, D-172).",
    default: 2,
    schema: positiveNumber(2),
    read: positiveValue("heavy_max_load_per_cpu", 1),
    flow: {
      steps: ["test.run"],
      role: TUNABLE,
    },
    listed: 234,
    checked: 234,
  }),
  heavyCommands: configKey<readonly string[]>({
    key: "heavy_commands",
    doc: "Regular expressions (JavaScript syntax) that recognise this project's heavy commands (recording, export, build): while the 5-minute load is at the limit, the Bash hook refuses a matching command that does not run as `canon heavy run -- <command>`, which waits for the load like `canon work test` does (BR-2631, D-161). Default none.",
    default: [],
    schema: { type: ["array", "null"], items: { type: "string", minLength: 1 }, default: [] },
    read: (v) => {
      if (v === null) return ok([]);
      if (!Array.isArray(v) || v.some((p) => typeof p !== "string")) return err("invalid", "`heavy_commands` must be a list of regular expressions, each a string");
      for (const [i, p] of v.entries()) {
        try {
          new RegExp(p as string);
        } catch (e) {
          return err("invalid", `\`heavy_commands\` item ${i + 1} (${JSON.stringify(p)}) is not a valid regular expression: ${(e as Error).message}`);
        }
      }
      return ok(v as string[]);
    },
    flow: {
      steps: ["test.run"],
      role: optional("[]（默认）：Bash 前的 hook 不拦任何命令"),
    },
    listed: 232,
    checked: 232,
  }),
};
