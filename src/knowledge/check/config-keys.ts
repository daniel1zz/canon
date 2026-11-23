import { err, ok } from "../../kernel/result.ts";
import { configKey, oneOfEntry, rawAt, readGroup, REL_DIR, relPath, optional, required, TUNABLE } from "../../invocation/key.ts";
import { CONFIGURABLE_CHECKS, type CheckAction, type CheckPolicy } from "./policy.ts";
import { DEFAULT_DESIGN_SIGNALS, DESIGN_CLASSES, type DesignClass } from "./design-basis/design-basis.ts";

/** canon/config.yaml keys of `canon check`: which files are tests and where each domain's code lives (C-135, D-63). */
const ACTIONS: readonly CheckAction[] = ["refuse", "remind", "off"];

export const checkKeys = {
  checkPolicy: configKey<CheckPolicy>({
    key: "policies.checks",
    doc: "Per check, whether canon check refuses (a finding that refuses a landing), reminds (a note) or is off: only the checks that say a document is incomplete, never one that says it is false (BR-2641, D-164). An entry left out keeps its default.",
    default: CONFIGURABLE_CHECKS,
    schema: { type: ["object", "null"], additionalProperties: false, default: CONFIGURABLE_CHECKS, properties: Object.fromEntries(Object.entries(CONFIGURABLE_CHECKS).map(([k, d]) => [k, { enum: [...ACTIONS], default: d }])) },
    read: (v) => readGroup("policies.checks", v, CONFIGURABLE_CHECKS as CheckPolicy, Object.fromEntries(Object.keys(CONFIGURABLE_CHECKS).map((k) => [k, oneOfEntry(ACTIONS)])) as never),
    flow: { steps: ["test.check"], role: TUNABLE },
    listed: 402,
    checked: 402,
  }),
  tests: configKey<readonly string[] | undefined>({
    key: "tests",
    doc: "Globs of the project's test files, whatever their language: the files whose JUnit reports name rules (BR-2005). Required: without it canon check, canon work test and landing fail with exit 2, since canon does not guess which files are tests (BR-2046, D-64).",
    default: undefined,
    schema: { type: "array", items: { type: "string" } },
    read: (v) => (!Array.isArray(v) || v.some((t) => typeof t !== "string") ? err("invalid", "`tests` must be a list of globs") : ok(v as string[])),
    flow: {
      steps: ["test.select", "test.check"],
      role: required("没有它，canon check、canon work test 和合入都以退出码 2 失败"),
    },
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
    flow: {
      steps: ["session.instructions"],
      role: optional("不写：不提示"),
    },
    listed: 215,
    checked: 215,
  }),
  codeRoot: configKey<string | undefined>({
    key: "code_root",
    doc: "The directory whose subdirectories mirror the rule domains one to one (`<codeRoot>/<domain path>`, D-15); unset means top-level domain READMEs list their code directories instead.",
    default: undefined,
    schema: { type: ["string", "null"], pattern: REL_DIR.source },
    read: (v) => {
      if (v !== null && (typeof v !== "string" || !REL_DIR.test(v))) return err("invalid", "`code_root` must be a directory relative to the repository root, such as src");
      return ok(typeof v === "string" ? v : undefined);
    },
    flow: {
      steps: ["test.check"],
      role: optional("不写：由顶层领域 README 自己列代码目录"),
    },
    listed: 150,
    checked: 110,
  }),
  // reason: shared reads code_root from ctx.raw, which is valid by now because code_root is checked first (BR-2116)
  shared: configKey<readonly string[]>({
    key: "shared",
    doc: "Directories (or files) under code_root that belong to no business domain, such as a shared kernel; empty without code_root (BR-2116).",
    default: [],
    schema: { type: ["array", "null"], items: relPath, default: [] },
    needs: ["code_root"],
    read: (v, ctx) => {
      if (v === null) return ok([]);
      const root = ctx.raw["code_root"];
      const codeRoot = typeof root === "string" ? root : undefined;
      if (codeRoot === undefined) return err("invalid", "`shared` needs `code_root`: it lists directories under the code root that are no domain's");
      if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !REL_DIR.test(s) || !s.startsWith(`${codeRoot}/`))) {
        return err("invalid", `\`shared\` must be a list of directories under ${codeRoot}, such as ${codeRoot}/kernel`);
      }
      return ok(v as string[]);
    },
    flow: {
      steps: ["test.check"],
      role: optional("[]：没有共享目录"),
    },
    listed: 160,
    checked: 120,
  }),
  designSignals: configKey<Readonly<Record<DesignClass, readonly string[]>>>({
    key: "design_signals",
    doc: "Globs of the paths of each one-way-door class (persistent, boundary, dependency): a change touching one is asked for its design basis (BR-2491, D-124). A class left out keeps its default; [] turns it off.",
    default: DEFAULT_DESIGN_SIGNALS,
    schema: { type: "object", additionalProperties: false, properties: Object.fromEntries(DESIGN_CLASSES.map((c) => [c, { type: "array", items: { type: "string" } }])) },
    read: (v) => {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return err("invalid", "`design_signals` must map persistent, boundary or dependency to a list of globs");
      const out: Record<DesignClass, readonly string[]> = { ...DEFAULT_DESIGN_SIGNALS };
      for (const [k, globs] of Object.entries(v as Record<string, unknown>)) {
        if (!(DESIGN_CLASSES as readonly string[]).includes(k)) return err("invalid", `\`design_signals.${k}\` is not a class: use ${DESIGN_CLASSES.join(", ")}`);
        if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string" || g.trim() === "")) return err("invalid", `\`design_signals.${k}\` must be a list of globs, such as ["game/src/save_game/**"]`);
        out[k as DesignClass] = globs as string[];
      }
      return ok(out);
    },
    flow: {
      steps: ["land.design"],
      role: optional("某一类写 []：这一类不再要求设计依据"),
    },
    listed: 165,
    checked: 125,
  }),
};

/** policies.checks as a config mapping (main's, for a landing) sets it; the defaults when it does not (BR-2641). */
export function checkPolicyOf(raw: Readonly<Record<string, unknown>>, root: string) {
  const at = rawAt(raw, checkKeys.checkPolicy.key);
  return at.set ? checkKeys.checkPolicy.read(at.value, { root, raw }) : ok(checkKeys.checkPolicy.default);
}
