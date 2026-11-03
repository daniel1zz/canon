import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { check } from "./check.ts";

// Fixture ids are assembled at runtime, so this file names no rule outside its test titles (BR-2005).
const br = (n: number) => ["BR", n].join("-");

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-lists-"));
  mkdirSync(join(root, "src/billing"), { recursive: true });
  const all = { "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# Billing\n\n## 术语\n\n- **退款**：钱退回\n", ...files };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const TS = 'export const STAGES: readonly string[] = [\n  "floor", "check",\n];\nexport const ALL = [...STAGES, "claim"];\nconst OTHER = ["stray"];\n';
const rule = (lists: string, body = "Reads `src/stats.ts` `STAGES`: `floor`.", status = "active") =>
  `---\nid: ${br(1)}\ntitle: R\nstatus: ${status}\nuntested: fixture\nlists: ${lists}\n---\n## 规则\n\n${body}\n\n## 例子\n\n- a → b\n`;
const findings = (files: Record<string, string>) => {
  const root = repo(files);
  return check({ root, ...readCorpus(root), testFiles: [] })
    .filter((f) => f.rule === "list-mismatch" || f.rule === "file-invalid")
    .map((f) => `${f.rule}: ${f.message}`);
};
const at = (lists: string, body?: string, status?: string, code: Record<string, string> = { "src/stats.ts": TS }) =>
  findings({ ...code, [`canon/rules/billing/${br(1)}.md`]: rule(lists, body, status) });

describe("rules that name items of a code list (lists front matter)", () => {
  test("BR-2180: text, front matter and code that agree give no finding; a typo on either side, a missing assignment or file is list-mismatch", () => {
    const ok = "[{file: src/stats.ts, name: STAGES, items: [floor]}]";
    expect(at(ok)).toEqual([]);
    expect(at(ok, "Reads `src/stats.ts` `STAGES`: `flor`.")).toEqual([expect.stringMatching(/^list-mismatch: .*does not write `floor` in backticks/)]);
    expect(at("[{file: src/stats.ts, name: STAGES, items: [flor]}]", "Reads `src/stats.ts` `STAGES`: `flor`.")).toEqual([expect.stringMatching(/^list-mismatch: names `flor` from src\/stats.ts STAGES, which is not on it/)]);
    expect(at("[{file: src/stats.ts, name: STAGES, items: [stray]}]", "Reads `src/stats.ts` `STAGES`: `stray`.")).toEqual([expect.stringContaining("`stray`")]);
    expect(at("[{file: src/stats.ts, name: STAGES2, items: [floor]}]", "Reads `src/stats.ts` `STAGES2`: `floor`.")).toEqual([expect.stringContaining("does not assign STAGES2")]);
    expect(at("[{file: src/gone.ts, name: STAGES, items: [floor]}]", "Reads `src/gone.ts` `STAGES`: `floor`.")).toEqual([expect.stringContaining("src/gone.ts is not a file")]);
    expect(at("[{file: src/gone.ts, name: STAGES, items: [floor]}]", "Reads `src/gone.ts` `STAGES`: `flor`.", "retired")).toEqual([]);
  });

  test("BR-2180: the initializer is read as text, so Python and Go lists work; items spread from another constant are not on it", () => {
    const py = { "src/stats.py": 'STAGES: list[str] = [\n    "floor",\n]\nOTHER = ["claim"]\n' };
    expect(at("[{file: src/stats.py, name: STAGES, items: [floor]}]", "Reads `src/stats.py` `STAGES`: `floor`.", "active", py)).toEqual([]);
    expect(at("[{file: src/stats.py, name: STAGES, items: [claim]}]", "Reads `src/stats.py` `STAGES`: `claim`.", "active", py)).toEqual([expect.stringContaining("`claim`")]);
    const go = { "src/stats.go": 'var STAGES = []string{\n\t"floor",\n}\nvar OTHER = []string{"claim"}\n' };
    expect(at("[{file: src/stats.go, name: STAGES, items: [floor]}]", "Reads `src/stats.go` `STAGES`: `floor`.", "active", go)).toEqual([]);
    expect(at("[{file: src/stats.go, name: STAGES, items: [claim]}]", "Reads `src/stats.go` `STAGES`: `claim`.", "active", go)).toEqual([expect.stringContaining("`claim`")]);
    expect(at("[{file: src/stats.ts, name: ALL, items: [claim]}]", "Reads `src/stats.ts` `ALL`: `claim`.")).toEqual([]);
    expect(at("[{file: src/stats.ts, name: ALL, items: [floor]}]", "Reads `src/stats.ts` `ALL`: `floor`.")).toEqual([expect.stringContaining("`floor`")]);
  });

  test("BR-2180: a lists value that is not a non-empty list of file, name and items makes the rule file-invalid", () => {
    for (const bad of ["[]", "x", "[{file: src/stats.ts, name: STAGES}]", "[{file: src/stats.ts, name: STAGES, items: []}]", "[{file: /abs.ts, name: STAGES, items: [floor]}]", "[{file: ../x.ts, name: STAGES, items: [floor]}]", "[{file: src/stats.ts, name: STAGES, items: [floor], extra: 1}]"]) {
      expect(at(bad)).toEqual([expect.stringMatching(/^file-invalid: `lists` must be/)]);
    }
  });
});
