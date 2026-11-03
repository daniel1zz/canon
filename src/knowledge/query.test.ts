import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../check/check.ts";
import { contextFor, search, renderContext } from "./query.ts";
import { reviewPrompt } from "../review/review.ts";
import { readCorpus } from "./read.ts";

const id = (p: string, n: number) => [p, n].join("-");

function corpusOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "canon-next-query-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return { root, ...readCorpus(root) };
}

const rule = (n: number, title: string, body: string, status = "active") => `---\nid: ${id("BR", n)}\ntitle: ${title}\nstatus: ${status}\nuntested: fixture\n---\n${body}\n`;

const files = {
  "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney in and out.\n\n## 术语\n\n- **退款**：钱退回\n",
  "canon/rules/auth/README.md": "---\ncode: [src/auth]\n---\n# auth\n\n## 术语\n\n- **退款**：钱退回\n",
  [`canon/rules/billing/${id("BR", 1)}.md`]: rule(1, "Refund window", "Refunds within 30 days."),
  [`canon/rules/billing/${id("BR", 2)}.md`]: rule(2, "Old fee", "Retired.", "retired"),
  [`canon/rules/auth/${id("BR", 3)}.md`]: rule(3, "Session length", "Sessions last 12 hours."),
  [`canon/decisions/${id("D", 1)}-a.md`]: `---\nid: ${id("D", 1)}\ntitle: Why 30 days\nstatus: accepted\n---\nBecause of ${id("BR", 1)}.\n`,
  [`canon/decisions/${id("D", 2)}-b.md`]: `---\nid: ${id("D", 2)}\ntitle: Draft idea\nstatus: proposed\n---\nAbout ${id("BR", 1)}.\n`,
  [`canon/changes/${id("C", 1)}-x.md`]: `---\nid: ${id("C", 1)}\ntitle: Shorten refunds\nstatus: open\nrules: [${id("BR", 1)}]\n---\nx\n`,
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

  test("BR-2112: by default rules are listed by id and title only; with full every rule's text is printed", () => {
    const { corpus } = corpusOf(files);
    const ctx = contextFor(corpus, "billing");
    const brief = renderContext("", ctx, { full: false, target: "billing" });
    expect(brief).toContain(`- ${id("BR", 1)} Refund window`);
    expect(brief).not.toContain("Refunds within 30 days.");
    expect(brief).toContain("canon context billing --full");
    expect(brief).toContain(`${id("D", 1)} Why 30 days`);
    const full = renderContext("", ctx, { full: true });
    expect(full).toContain(`## ${id("BR", 1)} Refund window`);
    expect(full).toContain("Refunds within 30 days.");
    expect(full).not.toContain("--full");
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

  test("BR-2008: an id matches whole ids only, so a short id does not find a note that names only a longer one", () => {
    const { corpus } = corpusOf({ ...files, [`canon/notes/${id("N", 1)}-a.md`]: `---\nid: ${id("N", 1)}\ntitle: A\n---\nAbout ${id("BR", 12)} only.\n` });
    expect(search(corpus, id("BR", 1)).map((h) => h.doc.id)).not.toContain(id("N", 1));
    expect(search(corpus, id("BR", 12)).map((h) => h.doc.id)).toEqual([id("N", 1)]);
  });

  test("BR-2073: a Chinese word finds the Chinese documents that contain it", () => {
    const { corpus } = corpusOf({ ...files, [`canon/notes/${id("N", 1)}-a.md`]: `---\nid: ${id("N", 1)}\ntitle: 复盘\n---\n合入排队太久。\n` });
    expect(search(corpus, "合入").map((h) => h.doc.id)).toEqual([id("N", 1)]);
  });

  test("BR-2073: several words must all appear", () => {
    const { corpus } = corpusOf(files);
    expect(search(corpus, "sessions hours").map((h) => h.doc.id)).toEqual([id("BR", 3)]);
    expect(search(corpus, "sessions refunds")).toEqual([]);
  });
});

describe("check: duplicates", () => {
  test("BR-2003: two files claiming one id are both reported", () => {
    const r = corpusOf({
      ...files,
      [`canon/notes/${id("N", 1)}-a.md`]: `---\nid: ${id("N", 1)}\ntitle: A\n---\n`,
      [`canon/notes/${id("N", 1)}-b.md`]: `---\nid: ${id("N", 1)}\ntitle: B\n---\n`,
    });
    const dups = check({ ...r, testFiles: [] }).filter((f) => f.rule === "id-duplicate");
    expect(dups.map((f) => f.path).sort()).toEqual([`canon/notes/${id("N", 1)}-a.md`, `canon/notes/${id("N", 1)}-b.md`]);
  });
});

describe("subdomains", () => {
  const sub = {
    "canon/rules/work/README.md": "---\ncode: [src/work, src/coord]\n---\n# work\n\nOverview of work.\n",
    "canon/rules/work/drop/README.md": "---\ncode: [src/work/drop.ts]\n---\n# work/drop\n\nDropping.\n",
    "canon/rules/work/land/README.md": "---\ncode: [src/work/work.ts]\n---\n# work/land\n\nLanding.\n",
    [`canon/rules/work/${id("BR", 1)}.md`]: rule(1, "Every write names its actor", "Actor."),
    [`canon/rules/work/drop/${id("BR", 2)}.md`]: rule(2, "Drop archives first", "Archive."),
    [`canon/rules/work/land/${id("BR", 3)}.md`]: rule(3, "Land in order", "Queue."),
  };
  const names = (target: string) => contextFor(corpusOf(sub).corpus, target).domains.map((d) => d.name);

  test("BR-2113: a path resolves to the deepest subdomain covering it plus the domains enclosing it", () => {
    expect(names("src/work/drop.ts")).toEqual(["work", "work/drop"]);
    expect(names("src/coord/db.ts")).toEqual(["work"]);
    const ctx = contextFor(corpusOf(sub).corpus, "src/work/drop.ts");
    expect(ctx.rules.map((r) => r.id).sort()).toEqual([id("BR", 1), id("BR", 2)]); // the enclosing domain's own rules come too, not work/land's
  });

  test("BR-2113: a domain name brings every subdomain under it; a rule id brings its subdomain and the enclosing domain", () => {
    expect(names("work")).toEqual(["work", "work/drop", "work/land"]);
    expect(names("work/land")).toEqual(["work", "work/land"]);
    expect(names(id("BR", 2))).toEqual(["work", "work/drop"]);
  });

  test("BR-2006: a subdomain directory without a README is reported", () => {
    const r = corpusOf({ ...sub, [`canon/rules/work/tokens/${id("BR", 4)}.md`]: rule(4, "T", "t") });
    expect(r.problems.map((p) => p.path)).toContain("canon/rules/work/tokens");
  });

  test("BR-2009: the review of a subdomain's rule reads the whole top-level domain, so a contradiction across subdomains is visible", () => {
    const { root, corpus } = corpusOf(sub);
    const changed = corpus.docs.filter((d) => d.id === id("BR", 2));
    const prompt = reviewPrompt(root, corpus, changed);
    expect(prompt).toContain("# Current context for work\n");
    expect(prompt).toContain("Queue."); // work/land's rule text, a sibling subdomain
  });
});
