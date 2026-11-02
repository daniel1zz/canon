import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoordDb } from "../coord/db.ts";
import { readCorpus } from "../knowledge/read.ts";
import { check } from "./check.ts";

// Ids are assembled at runtime so this file does not itself name rules when canon check scans the repo.
const br = (n: number) => ["BR", n].join("-");
const d = (n: number) => ["D", n].join("-");

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-next-check-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const domainReadme = "---\ncode: [src/billing]\n---\n# Billing\n";
const ruleFile = (n: number, extra = "") => `---\nid: ${br(n)}\ntitle: Rule ${n}\n${extra}---\nStatement ${n}.\n`;

describe("canon check", () => {
  test("BR-2004 BR-2005: a clean corpus whose rules are all tested has no findings", () => {
    const root = repo({
      "canon/rules/billing/README.md": domainReadme,
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      [`canon/decisions/${d(1)}-x.md`]: `---\nid: ${d(1)}\ntitle: X\nstatus: accepted\n---\nBecause ${br(1)}. Example only: \`${br(77)}\`.\n\n\`\`\`\n${br(78)}\n\`\`\`\n`,
      "src/billing/refund.test.ts": `it("${br(1)}: refuses day 31", () => {});`,
    });
    const r = readCorpus(root);
    expect(check({ root, ...r })).toEqual([]);
  });

  test("BR-2001 BR-2004 BR-2005: reports each outcome violation by its rule name", () => {
    const root = repo({
      "canon/rules/billing/README.md": domainReadme,
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      [`canon/rules/billing/${br(2)}.md`]: ruleFile(2, "status: retired\n"),
      [`canon/rules/billing/${br(3)}.md`]: ruleFile(3, "untested: covered by the payment provider's contract\n"),
      [`canon/rules/billing/${br(4)}.md`]: `---\nid: ${br(5)}\ntitle: Wrong id\n---\nx\n`,
      [`canon/changes/C-1-a.md`]: `---\nid: C-1\ntitle: A\nrules: [${br(9)}]\n---\nTouches ${br(1)}.\n`,
      "src/billing/a.test.ts": `it("${br(2)} old", () => {}); it("${br(7)}", () => {});`,
    });
    const findings = check({ root, ...readCorpus(root) });
    const summary = findings.map((f) => `${f.rule} ${f.path}`).sort();
    expect(summary).toEqual(
      [
        `file-invalid canon/rules/billing/${br(4)}.md`, // id does not match the file name
        "ref-dangling canon/changes/C-1-a.md", // change lists a rule that does not exist
        "ref-dangling src/billing/a.test.ts", // test names a rule that does not exist
        `rule-untested canon/rules/billing/${br(1)}.md`, // active, no test, no reason
        "test-retired-rule src/billing/a.test.ts",
      ].sort(),
    );
  });

  test("BR-2006: a domain without README is invalid, so its code scope is never silently empty", () => {
    const root = repo({ [`canon/rules/auth/${br(1)}.md`]: ruleFile(1, "untested: n/a\n") });
    const findings = check({ root, ...readCorpus(root) });
    expect(findings.map((f) => f.rule)).toEqual(["file-invalid"]);
  });
});

describe("id allocation", () => {
  test("BR-2002: never hands out an id at or below the highest one already in the files", () => {
    const root = repo({});
    const db = CoordDb.open(join(root, "state.db"));
    if (!db.ok) throw new Error(db.error.message);
    expect(db.value.allocate("BR", 1562, "test")).toBe(br(1563));
    expect(db.value.allocate("BR", 0, "test")).toBe(br(1564));
    expect(db.value.allocate("D", 0, "test")).toBe(d(1));
    db.value.close();
  });
});
