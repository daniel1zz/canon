import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { check } from "./check.ts";
import { project } from "../../work/testkit.ts";

// Fixture ids are assembled at runtime, so only test titles name rules (BR-2005).
const README = "---\ncode: [src/billing]\n---\n# Billing\n\n## 术语\n\n- **退款**：钱退回\n";
const MAIN = join(import.meta.dir, "../../cli/main.ts");
const br = (n: number) => ["BR", n].join("-");

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-planned-"));
  mkdirSync(join(root, "src/billing"), { recursive: true });
  const all = { "canon/rules/billing/README.md": README, ...files };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const rule = (n: number, meta: string, body = "## 规则\n\nStatement.\n\n## 例子\n\n- day 30 → refunded\n") => ({ [`canon/rules/billing/${br(n)}.md`]: `---\nid: ${br(n)}\ntitle: Rule ${n}\n${meta}---\n${body}` });
const findings = (root: string) => check({ root, ...readCorpus(root) }).map((f) => `${f.rule} ${f.path}${f.rule === "file-invalid" ? ` ${f.message}` : ""}`);

describe("planned rules in canon check", () => {
  test("BR-2235 BR-2005: a planned rule with no test and no untested is not reported; an active one is", () => {
    const root = repo({ ...rule(1, "status: planned\n"), ...rule(2, "") });
    expect(findings(root)).toEqual([`rule-untested canon/rules/billing/${br(2)}.md`]);
  });

  test("BR-2235: a planned rule a test names is not reported either", () => {
    const root = repo({ ...rule(1, "status: planned\n"), "src/billing/a.test.ts": `it("${br(1)}: refunds", () => {});` });
    expect(findings(root)).toEqual([]);
  });

  test("BR-2235 BR-2001: any other status is file-invalid and names the three allowed", () => {
    const root = repo(rule(1, "status: draft\n"));
    expect(findings(root)).toEqual([`file-invalid canon/rules/billing/${br(1)}.md status must be one of active, retired, planned`]);
  });

  test("BR-2235 BR-2034: a planned rule whose examples section holds only blank lines is rule-no-example; with untested it is not", () => {
    const root = repo({ ...rule(1, "status: planned\n", "## 规则\n\nStatement.\n\n## 例子\n\n\n"), ...rule(2, "status: planned\nuntested: provider\n", "## 规则\n\nStatement.\n") });
    expect(findings(root)).toEqual([`rule-no-example canon/rules/billing/${br(1)}.md`]);
  });

  test("BR-2033: a planned rule without a statement section is rule-no-statement; a retired one is not", () => {
    const root = repo({ ...rule(1, "status: planned\n", "Just text.\n\n## 例子\n\n- a → b\n"), ...rule(2, "status: retired\n", "Just text.\n") });
    expect(findings(root)).toEqual([`rule-no-statement canon/rules/billing/${br(1)}.md`]);
  });

  test("BR-2235 BR-2033 BR-2034: a missing test never fails canon check for a planned rule, but a missing statement or example does, so it blocks the landing (BR-2016)", () => {
    const run = (files: Record<string, string>) => {
      const root = project();
      for (const [p, text] of Object.entries({ "canon/rules/billing/README.md": README, "src/billing/.keep": "", ...files })) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), text);
      }
      return Bun.spawnSync(["bun", MAIN, "check"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" }).exitCode;
    };
    expect(run(rule(1, "status: planned\n"))).toBe(0);
    expect(run(rule(1, "status: planned\n", "## 规则\n\nStatement.\n\n## 例子\n\n\n"))).toBe(1);
    expect(run(rule(1, "status: planned\n", "Just text.\n\n## 例子\n\n- a → b\n"))).toBe(1);
  });

  test("BR-2235: a rule without status is active and reported without a test", () => {
    const root = repo(rule(1, ""));
    expect(readCorpus(root).corpus.docs.find((d) => d.id === br(1))).toMatchObject({ status: "active" });
    expect(findings(root)).toEqual([`rule-untested canon/rules/billing/${br(1)}.md`]);
  });
});
