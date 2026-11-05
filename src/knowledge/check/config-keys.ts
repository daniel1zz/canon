import { err, ok } from "../../kernel/result.ts";
import { configKey, REL_DIR, relPath } from "../../invocation/key.ts";

/** canon/config.yaml keys of `canon check`: which files are tests and where each domain's code lives (C-135, D-63). */
export const checkKeys = {
  tests: configKey<readonly string[] | undefined>({
    key: "tests",
    doc: "Globs of the project's test files, whatever their language: the files whose JUnit reports name rules (BR-2005). Required: without it canon check, canon work test and landing fail with exit 2, since canon does not guess which files are tests (BR-2046, D-64).",
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
  codeRoot: configKey<string | undefined>({
    key: "code_root",
    doc: "The directory whose subdirectories mirror the rule domains one to one (`<codeRoot>/<domain path>`, D-15); unset means top-level domain READMEs list their code directories instead.",
    default: undefined,
    schema: { type: ["string", "null"], pattern: REL_DIR.source },
    read: (v) => {
      if (v !== null && (typeof v !== "string" || !REL_DIR.test(v))) return err("invalid", "`code_root` must be a directory relative to the repository root, such as src");
      return ok(typeof v === "string" ? v : undefined);
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
    listed: 160,
    checked: 120,
  }),
};
