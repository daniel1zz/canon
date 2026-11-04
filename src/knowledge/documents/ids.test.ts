import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoordDb } from "../../work/db.ts";
import { stripCode } from "./model.ts";
import { readCorpus } from "./read.ts";
import { hasPlaceholderLine } from "./templates.ts";
import { check } from "../check/check.ts";
import { createDoc } from "./write.ts";

// Ids are assembled at runtime so this file does not itself name rules when canon check scans the repo.
const id = (p: string, n: number) => [p, n].join("-");

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-ids-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

function db(root: string): CoordDb {
  const r = CoordDb.open(join(root, "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const README = "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n";

function create(root: string, d: CoordDb, kind: string, title: string, domain?: string): string {
  const r = createDoc(root, readCorpus(root).corpus, d, "agent:test", { kind, title, ...(domain ? { domain } : {}) });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("id allocation from the files", () => {
  test("BR-2002: the database's last id wins over a lower highest id in the files", () => {
    const root = repo({ [`canon/decisions/${id("D", 3)}.md`]: `---\nid: ${id("D", 3)}\ntitle: Three\nstatus: proposed\n---\n` });
    const d = db(root);
    d.allocate("D", 8, "agent:test"); // the database last handed out D-9
    expect(create(root, d, "decision", "Next")).toBe(`canon/decisions/${id("D", 10)}-next.md`);
    d.close();
  });

  test("BR-2002: a file that does not parse still holds its number, for decisions, changes and rules", () => {
    const root = repo({
      [`canon/decisions/${id("D", 7)}.md`]: `---\nid: ${id("D", 7)}\ntitle: ""\nstatus: proposed\n---\n## 背景\n`,
      [`canon/changes/${id("C", 4)}-broken.md`]: "no front matter\n",
      "canon/rules/billing/README.md": README,
      [`canon/rules/billing/${id("BR", 12)}.md`]: `---\nid: ${id("BR", 13)}\ntitle: Wrong id\nstatus: active\n---\n`,
    });
    const r = readCorpus(root);
    expect(r.corpus.docs).toEqual([]); // every one of them is a problem, not a document
    expect(r.problems).toHaveLength(3);
    const d = db(root);
    expect(create(root, d, "decision", "next one")).toBe(`canon/decisions/${id("D", 8)}-next-one.md`);
    expect(create(root, d, "change", "next")).toBe(`canon/changes/${id("C", 5)}-next.md`);
    expect(create(root, d, "rule", "next", "billing")).toBe(`canon/rules/billing/${id("BR", 13)}.md`);
    d.close();
  });

  test("BR-2028: a retired rule's number is never given to a new rule", () => {
    const root = repo({
      "canon/rules/billing/README.md": README,
      [`canon/rules/billing/${id("BR", 5)}.md`]: `---\nid: ${id("BR", 5)}\ntitle: Old\nstatus: retired\n---\n## 规则\n\nX.\n`,
    });
    const d = db(root);
    expect(create(root, d, "rule", "New", "billing")).toBe(`canon/rules/billing/${id("BR", 6)}.md`);
    d.close();
  });
});

describe("code is not prose", () => {
  const ref = id("BR", 77);

  test("BR-2004: a code span opened with two backticks holds backticks, and its id is blanked with it", () => {
    expect(stripCode(`x \`\` a\`b\`(${ref}) \`\` y`)).not.toContain(ref);
    expect(stripCode(`x \`${ref}\` y`)).not.toContain(ref);
    expect(stripCode(`x ${ref} y`)).toContain(ref);
    // a run of two backticks is closed only by a run of two, not by single ones
    expect(stripCode(`\`\`a\` ${ref}`)).toContain(ref);
  });

  test("BR-2004 BR-2035: ids and placeholder lines inside a ~~~ fence are code; the same lines outside it are checked", () => {
    for (const fence of ["~~~", "\`\`\`", "~~~~"]) {
      const text = `a\n${fence}\n${ref}\n<占位>\n${fence}\nb\n`;
      expect([fence, stripCode(text).includes(ref), hasPlaceholderLine(text)]).toEqual([fence, false, false]);
    }
    expect(hasPlaceholderLine(`a\n<占位>\n`)).toBe(true);
    // a fence is closed only by the same character: ``` inside ~~~ does not end it
    expect(stripCode(`~~~\n\`\`\`\n${ref}\n~~~\n`)).not.toContain(ref);
    expect(stripCode(`~~~\n${ref}\n\`\`\`\n${ref.replace("77", "78")}\n`)).not.toContain(ref.replace("77", "78"));
  });

  test("BR-2004 BR-2035: canon check reports nothing for an id and a placeholder line inside a ~~~ block of a domain README (#76)", () => {
    const run = (body: string) => {
      const root = repo({ "canon/rules/billing/README.md": `---\ncode: [src/billing]\n---\n# B\n\n${body}\n## 术语\n\n- **a**：b\n`, "src/billing/.keep": "" });
      return check({ root, ...readCorpus(root), testFiles: [] }).map((f) => f.rule).sort();
    };
    expect(run(`~~~\n${ref}\n<占位>\n~~~\n`)).toEqual([]);
    expect(run(`${ref}\n<占位>\n`)).toEqual(["ref-dangling", "template-unfilled"]);
  });
});
