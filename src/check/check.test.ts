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
const ruleFile = (n: number, extra = "") => `---\nid: ${br(n)}\ntitle: Rule ${n}\n${extra}---\n## 规则\n\nStatement ${n}.\n\n## 例子\n\n- day 30 → refunded\n`;

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

  test("BR-2001 BR-2004 BR-2005 BR-2042: reports each outcome violation by its rule name", () => {
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

describe("rule shape", () => {
  const readme = { "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n" };
  const fileOf = (n: number, body: string, extra = "") => ({ [`canon/rules/billing/${br(n)}.md`]: `---\nid: ${br(n)}\ntitle: R${n}\n${extra}---\n${body}` });
  const run = (files: Record<string, string>) => {
    const ids = Object.keys(files).map((p) => p.split("/").pop()!.replace(/\.md$/, ""));
    const root = repo({ ...readme, ...files, "src/billing/a.test.ts": `it("${ids.join(" ")}", () => {});` });
    return check({ root, ...readCorpus(root) }).map((f) => `${f.rule} ${f.path.split("/").pop()}`).sort();
  };

  test("BR-2033: an active rule without a non-empty statement section is reported", () => {
    expect(run({ ...fileOf(1, "Just text.\n\n## 例子\n\n- a → b\n"), ...fileOf(2, "## 规则\n\n\n## 例子\n\n- a → b\n") })).toEqual([
      `rule-no-statement ${br(1)}.md`,
      `rule-no-statement ${br(2)}.md`,
    ]);
  });

  test("BR-2034: a tested active rule needs a real example; an untested or retired one does not", () => {
    expect(
      run({
        ...fileOf(1, "## 规则\n\nS.\n"),
        ...fileOf(2, "## 规则\n\nS.\n\n## 例子\n\n"),
        ...fileOf(3, "## 规则\n\nS.\n", "untested: provider contract\n"),
        ...fileOf(4, "## 规则\n\nS.\n", "status: retired\n"),
      }),
    ).toEqual([`rule-no-example ${br(1)}.md`, `rule-no-example ${br(2)}.md`, "test-retired-rule a.test.ts"]);
  });

  test("BR-2035: a placeholder line left from a template is reported, but not one written as code", () => {
    const root = repo({
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n<这个领域管什么、不管什么。>\n",
      ...fileOf(1, "## 规则\n\nS.\n\n## 例子\n\n- <边界上的具体输入或状态> → <必须出现的结果>\n- `canon work start <C-n>` → starts\n"),
      [`canon/decisions/${d(1)}.md`]: `---\nid: ${d(1)}\ntitle: X\n---\n## 背景\n\n<为什么需要做这个决定，有哪些事实和数据。>\n\n\`\`\`\n<kept as code>\n\`\`\`\n`,
      "src/billing/a.test.ts": `it("${br(1)}", () => {});`,
    });
    const got = check({ root, ...readCorpus(root) }).filter((f) => f.rule === "template-unfilled").map((f) => f.path.split("/").pop()).sort();
    expect(got).toEqual([`${br(1)}.md`, `${d(1)}.md`, "README.md"].sort());
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
