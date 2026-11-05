import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../check/check.ts";
import { contextFor, isIdQuery, renderSearch, search, renderContext, SEARCH_HINT } from "./query.ts";
import { reviewPrompt } from "../review/review.ts";
import { readCorpus } from "../documents/read.ts";

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

  test("BR-2073: documents with every word come first; partial ones follow, ordered by words matched", () => {
    const { corpus } = corpusOf(files);
    const both = search(corpus, "sessions hours");
    expect(both[0]!.doc.id).toBe(id("BR", 3));
    expect([both[0]!.matched, both[0]!.terms]).toEqual([2, 2]);
    const partial = search(corpus, "sessions refunds");
    expect(partial.map((h) => h.doc.id).sort()).toEqual([id("BR", 1), id("BR", 3), id("C", 1)].sort()); // C-1 "Shorten refunds"
    expect(partial.every((h) => h.matched === 1 && h.terms === 2)).toBe(true);
    const abc = corpusOf({
      [`canon/notes/${id("N", 1)}-x.md`]: `---\nid: ${id("N", 1)}\ntitle: X\n---\nalpha beta\n`,
      [`canon/notes/${id("N", 2)}-y.md`]: `---\nid: ${id("N", 2)}\ntitle: Y\n---\nalpha alpha alpha alpha alpha\n`,
      [`canon/notes/${id("N", 3)}-z.md`]: `---\nid: ${id("N", 3)}\ntitle: Z\n---\nalpha beta gamma\n`,
      [`canon/notes/${id("N", 4)}-w.md`]: `---\nid: ${id("N", 4)}\ntitle: W\n---\nnothing here\n`,
    }).corpus;
    const hits = search(abc, "alpha beta gamma");
    expect(hits.map((h) => [h.doc.id, h.matched])).toEqual([[id("N", 3), 3], [id("N", 1), 2], [id("N", 2), 1]]);
    const lines = renderSearch(hits, false);
    expect(lines[0]).not.toContain("words]");
    expect(lines[1]).toContain("[2/3 words]");
    expect(lines[2]).toContain("[1/3 words]");
    expect(search(corpus, "sessions").every((h) => h.matched === h.terms)).toBe(true);
  });

  test("BR-2133: the hint follows when no document has every word, after (no match) when nothing matched; never for an id or a full match", () => {
    const { corpus } = corpusOf(files);
    const partial = renderSearch(search(corpus, "sessions refunds"), false);
    expect(partial.at(-1)).toBe(SEARCH_HINT);
    expect(partial).not.toContain("(no match)");
    expect(renderSearch(search(corpus, "zzqq"), false)).toEqual(["(no match)", SEARCH_HINT]);
    expect(renderSearch(search(corpus, "sessions hours"), false)).not.toContain(SEARCH_HINT);
    expect(isIdQuery(corpus, id("BR", 999))).toBe(true);
    expect(renderSearch(search(corpus, id("BR", 999)), isIdQuery(corpus, id("BR", 999)))).toEqual(["(no match)"]);
    expect(SEARCH_HINT).toContain("Chinese keywords");
  });
});

describe("search ranking", () => {
  const note = (n: number, title: string, body: string) => [`canon/notes/${id("N", n)}.md`, `---\nid: ${id("N", n)}\ntitle: ${title}\n---\n${body}\n`] as const;

  test("BR-2215: among documents matching as many words, a title hit scores 5, each body hit 1 up to 5, an id equal to a word 100; ties go by id", () => {
    const { corpus } = corpusOf(Object.fromEntries([note(1, "Body", "refund refund"), [`canon/decisions/${id("D", 1)}.md`, `---\nid: ${id("D", 1)}\ntitle: Refund rules\nstatus: accepted\n---\nnothing\n`]]));
    expect(search(corpus, "refund").map((h) => [h.doc.id, h.score])).toEqual([[id("D", 1), 5], [id("N", 1), 2]]);
    const capped = corpusOf(Object.fromEntries([note(1, "Body", "refund ".repeat(7)), [`canon/decisions/${id("D", 1)}.md`, `---\nid: ${id("D", 1)}\ntitle: Refund rules\nstatus: accepted\n---\nnothing\n`], note(2, "Refund both", "one refund")])).corpus;
    expect(search(capped, "refund").map((h) => [h.doc.id, h.score])).toEqual([[id("N", 2), 6], [id("D", 1), 5], [id("N", 1), 5]]);
    const byId = corpusOf(Object.fromEntries([note(1, "One", "nothing"), note(2, "Two", "a refund")])).corpus;
    const hits = search(byId, `${id("n", 1)} refund`);
    expect(hits.map((h) => [h.doc.id, h.matched, h.score])).toEqual([[id("N", 1), 1, 100], [id("N", 2), 1, 1]]);
  });
});

describe("render", () => {
  test("BR-2073: a one-word search lists its hits without a words marker", () => {
    const { corpus } = corpusOf(files);
    const lines = renderSearch(search(corpus, "sessions"), false);
    expect(lines[0]).toStartWith(id("BR", 3));
    expect(lines.join("\n")).not.toContain("words]");
  });

  test("BR-2120: a returned domain without subdomains gets no other-subdomains line", () => {
    const { root, corpus } = corpusOf(files);
    const out = renderContext(root, contextFor(corpus, "src/billing/refund.ts"), { full: false });
    expect(out).toContain("# Domain: billing");
    expect(out).not.toContain("Other subdomains");
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
  // Without code_root: the top-level README names the code, subdomains are business only (D-15).
  const sub = {
    "canon/rules/work/README.md": "---\ncode: [src/work, src/coord]\n---\n# work\n\nOverview of work.\n",
    "canon/rules/work/drop/README.md": "# work/drop\n\nDropping.\n",
    "canon/rules/work/land/README.md": "# work/land\n\nLanding.\n",
    [`canon/rules/work/${id("BR", 1)}.md`]: rule(1, "Every write names its actor", "Actor."),
    [`canon/rules/work/drop/${id("BR", 2)}.md`]: rule(2, "Drop archives first", "Archive."),
    [`canon/rules/work/land/${id("BR", 3)}.md`]: rule(3, "Land in order", "Queue."),
  };
  const layered = (extra: Record<string, string> = {}) => {
    const { root } = corpusOf({ ...sub, "canon/rules/work/README.md": "# work\n\nOverview of work.\n", ...extra });
    return { root, corpus: readCorpus(root, undefined, { codeRoot: "src", shared: ["src/kernel"] }).corpus };
  };
  const names = (target: string) => contextFor(corpusOf(sub).corpus, target).domains.map((d) => d.name);
  const layeredNames = (target: string) => contextFor(layered().corpus, target).domains.map((d) => d.name);

  test("BR-2113: with code_root a path resolves to the subdomain whose directory covers it plus the domains enclosing it", () => {
    expect(layeredNames("src/work/drop/drop.ts")).toEqual(["work", "work/drop"]);
    expect(layeredNames("src/work/db.ts")).toEqual(["work"]);
    expect(layeredNames("src/work")).toEqual(["work", "work/drop", "work/land"]);
    const ctx = contextFor(layered().corpus, "src/work/drop/drop.ts");
    expect(ctx.rules.map((r) => r.id).sort()).toEqual([id("BR", 1), id("BR", 2)]); // the enclosing domain's own rules come too, not work/land's
  });

  test("BR-2113: without code_root a path resolves through the top-level code only; subdomains have none", () => {
    expect(names("src/work/drop.ts")).toEqual(["work"]);
    expect(names("src/coord/db.ts")).toEqual(["work"]);
  });

  test("BR-2113: a domain name brings every subdomain under it; a rule id brings its subdomain and the enclosing domain", () => {
    expect(names("work")).toEqual(["work", "work/drop", "work/land"]);
    expect(names("work/land")).toEqual(["work", "work/land"]);
    expect(names(id("BR", 2))).toEqual(["work", "work/drop"]);
  });

  test("BR-2120: subdomains of a returned top-level domain that were not returned are listed by name only", () => {
    const { root, corpus } = layered();
    const ctx = contextFor(corpus, "src/work/drop/drop.ts");
    expect(ctx.others).toEqual(["work/land"]);
    const out = renderContext(root, ctx, { full: false });
    expect(out).toContain("Other subdomains, not included: work/land (canon context <name>)");
    expect(out).not.toContain("Queue.");
    expect(contextFor(corpus, "work").others).toEqual([]);
    expect(renderContext(root, contextFor(corpus, "work"), { full: false })).not.toContain("Other subdomains");
  });

  test("BR-2113: a file target brings only the domains whose code covers it, whatever the file imports", () => {
    const { root, corpus } = layered({
      "canon/rules/billing/README.md": "# billing\n\nMoney.\n",
      [`canon/rules/billing/${id("BR", 4)}.md`]: rule(4, "Refund window", "Refunds within 30 days."),
      "src/work/drop/drop.ts": 'import { land } from "../land/land.js";\nexport { x } from "../../kernel/git.ts";\nconst b = require("../../billing");\n',
      "src/work/land/land.ts": "",
      "src/kernel/git.ts": "",
      "src/billing/index.ts": "",
    });
    const ctx = contextFor(corpus, "src/work/drop/drop.ts");
    expect(ctx.domains.map((d) => d.name)).toEqual(["work", "work/drop"]);
    expect(ctx.others).toEqual(["work/land"]); // imported by the file, still only named
    const out = renderContext(root, ctx, { full: false });
    expect(out).not.toContain("Imported");
    expect(out).not.toContain("Refund window");
    expect(out).not.toContain(`- ${id("BR", 3)} Land in order`);
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

describe("amended decisions", () => {
  const dec = (n: number, status: string, extra = "") => `---\nid: ${id("D", n)}\ntitle: Decision ${n}\nstatus: ${status}\n${extra}---\nAbout ${id("BR", 1)}.\n`;
  const withAmends = (amends: string, status = "accepted") => ({
    ...files,
    [`canon/decisions/${id("D", 3)}.md`]: dec(3, status, `amends: ${amends}\n`),
  });

  test("BR-2139: amends lists decisions; a non-list, a missing id or a non-decision is reported by check", () => {
    const findings = (amends: string) => check({ ...corpusOf(withAmends(amends)), testFiles: [] }).filter((f) => f.path.includes(id("D", 3)) && f.rule !== "doc-missing-section");
    expect(findings(`[${id("D", 1)}]`)).toEqual([]);
    expect(findings(id("D", 1)).map((f) => f.rule)).toEqual(["file-invalid"]);
    expect(findings(`[${id("D", 99)}]`).map((f) => f.rule)).toEqual(["ref-dangling"]);
    expect(findings(`[${id("BR", 1)}]`).map((f) => f.rule)).toEqual(["amends-not-decision"]);
  });

  test("BR-2140: context marks a decision an accepted decision amends; a proposed or superseded amendment does not count", () => {
    const { corpus } = corpusOf(withAmends(`[${id("D", 1)}]`));
    const out = renderContext("", contextFor(corpus, "billing"), { full: false });
    expect(out).toContain(`- ${id("D", 1)} Why 30 days (canon/decisions/${id("D", 1)}-a.md) — partly amended by ${id("D", 3)}`);
    expect(renderContext("", contextFor(corpus, id("D", 1)), { full: false })).toContain(`# ${id("D", 1)} Why 30 days — partly amended by ${id("D", 3)}`);
    const proposed = corpusOf(withAmends(`[${id("D", 1)}]`, "proposed")).corpus;
    expect(renderContext("", contextFor(proposed, "billing"), { full: false })).not.toContain("partly amended by");
    const superseded = corpusOf(withAmends(`[${id("D", 1)}]`, "superseded")).corpus;
    expect(renderContext("", contextFor(superseded, id("D", 1)), { full: false })).not.toContain("partly amended by");
  });

  test("BR-2141: the review prompt asks for amends and shows a changed decision's supersedes and amends", () => {
    const { root, corpus } = corpusOf(withAmends(`[${id("D", 1)}]`));
    const amending = corpus.docs.find((d) => d.id === id("D", 3))!;
    const prompt = reviewPrompt(root, corpus, [amending]);
    expect(prompt).toContain("must list it in `amends:`");
    expect(prompt).toContain(`## ${id("D", 3)} Decision 3 (decision, accepted)\n\namends: ${id("D", 1)}\n`);
    const plain = corpus.docs.find((d) => d.id === id("D", 1))!;
    const plainPrompt = reviewPrompt(root, corpus, [plain]);
    expect(plainPrompt).toContain(`## ${id("D", 1)} Why 30 days (decision, accepted)\n\nBecause of`);
  });
});

describe("lessons in the rule review", () => {
  const withLessons = (body: string) => ({ ...files, [`canon/changes/${id("C", 1)}-x.md`]: `---\nid: ${id("C", 1)}\ntitle: Shorten refunds\nstatus: open\nrules: [${id("BR", 1)}]\n---\n${body}` });

  test("BR-2162: the review prompt carries the landing change's lessons and asks for notes, never a block, on where they went", () => {
    const { root, corpus } = corpusOf(withLessons("## 为什么\n\nx\n\n## 教训\n\n- 合入前要跑测试 → 只靠文字\n\n## 任务\n\n- [ ] x\n"));
    const changed = corpus.docs.filter((d) => d.id === id("BR", 1));
    const change = corpus.docs.find((d) => d.id === id("C", 1));
    const prompt = reviewPrompt(root, corpus, changed, { change });
    expect(prompt).toContain(`# Lessons of ${id("C", 1)} Shorten refunds (the change this landing belongs to)\n\n- 合入前要跑测试 → 只靠文字\n`);
    expect(prompt).not.toContain("## 任务\n\n- [ ] x"); // only the lessons section, not the whole change
    expect(prompt).toContain("add a note (never block for it)");
    expect(prompt).toContain("text-only (只靠文字) without a reason");
    expect(prompt).toContain("does not say the owner confirmed it");
  });

  test("BR-2162: a change without a lessons section, or no change at all, adds no lessons part", () => {
    const { root, corpus } = corpusOf(withLessons("## 为什么\n\nx\n"));
    const changed = corpus.docs.filter((d) => d.id === id("BR", 1));
    expect(reviewPrompt(root, corpus, changed, { change: corpus.docs.find((d) => d.id === id("C", 1)) })).not.toContain("# Lessons of");
    expect(reviewPrompt(root, corpus, changed)).not.toContain("# Lessons of");
  });
});
