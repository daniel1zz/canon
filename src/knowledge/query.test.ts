import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../check/check.ts";
import { contextFor, search } from "./query.ts";
import { readCorpus } from "./read.ts";

const id = (p: string, n: number) => [p, n].join("-");

function corpusOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "lore-next-query-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return { root, ...readCorpus(root) };
}

const rule = (n: number, title: string, body: string, status = "active") => `---\nid: ${id("BR", n)}\ntitle: ${title}\nstatus: ${status}\nuntested: fixture\n---\n${body}\n`;

const files = {
  "lore/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney in and out.\n",
  "lore/rules/auth/README.md": "---\ncode: [src/auth]\n---\n# auth\n",
  [`lore/rules/billing/${id("BR", 1)}.md`]: rule(1, "Refund window", "Refunds within 30 days."),
  [`lore/rules/billing/${id("BR", 2)}.md`]: rule(2, "Old fee", "Retired.", "retired"),
  [`lore/rules/auth/${id("BR", 3)}.md`]: rule(3, "Session length", "Sessions last 12 hours."),
  [`lore/decisions/${id("D", 1)}-a.md`]: `---\nid: ${id("D", 1)}\ntitle: Why 30 days\nstatus: accepted\n---\nBecause of ${id("BR", 1)}.\n`,
  [`lore/decisions/${id("D", 2)}-b.md`]: `---\nid: ${id("D", 2)}\ntitle: Draft idea\nstatus: proposed\n---\nAbout ${id("BR", 1)}.\n`,
  [`lore/changes/${id("C", 1)}-x.md`]: `---\nid: ${id("C", 1)}\ntitle: Shorten refunds\nstatus: open\nrules: [${id("BR", 1)}]\n---\nx\n`,
};

describe("context", () => {
  test("BR-2007: a code path yields its whole domain — README, every active rule, accepted decisions and open changes that name them", () => {
    const { corpus } = corpusOf(files);
    const ctx = contextFor(corpus, "src/billing/refund.ts");
    expect(ctx.domains.map((d) => d.name)).toEqual(["billing"]);
    expect(ctx.rules.map((r) => r.id)).toEqual([id("BR", 1)]); // retired rule left out, auth not included
    expect(ctx.decisions.map((d) => d.id)).toEqual([id("D", 1)]); // proposed decision left out
    expect(ctx.changes.map((c) => c.id)).toEqual([id("C", 1)]);
  });

  test("BR-2007: a change id yields the domains of the rules it touches", () => {
    const { corpus } = corpusOf(files);
    expect(contextFor(corpus, id("C", 1)).domains.map((d) => d.name)).toEqual(["billing"]);
  });
});

describe("search", () => {
  test("BR-2008: an exact id finds the document first and every document that names it", () => {
    const { corpus } = corpusOf(files);
    const hits = search(corpus, id("BR", 1)).map((h) => h.doc.id);
    expect(hits[0]).toBe(id("BR", 1));
    expect(hits).toContain(id("D", 1));
    expect(hits).toContain(id("C", 1));
    expect(hits).not.toContain(id("BR", 3));
  });

  test("BR-2008: several words must all appear", () => {
    const { corpus } = corpusOf(files);
    expect(search(corpus, "sessions hours").map((h) => h.doc.id)).toEqual([id("BR", 3)]);
    expect(search(corpus, "sessions refunds")).toEqual([]);
  });
});

describe("check: duplicates", () => {
  test("BR-2003: two files claiming one id are both reported", () => {
    const r = corpusOf({
      ...files,
      [`lore/notes/${id("N", 1)}-a.md`]: `---\nid: ${id("N", 1)}\ntitle: A\n---\n`,
      [`lore/notes/${id("N", 1)}-b.md`]: `---\nid: ${id("N", 1)}\ntitle: B\n---\n`,
    });
    const dups = check({ ...r, testFiles: [] }).filter((f) => f.rule === "id-duplicate");
    expect(dups.map((f) => f.path).sort()).toEqual([`lore/notes/${id("N", 1)}-a.md`, `lore/notes/${id("N", 1)}-b.md`]);
  });
});
