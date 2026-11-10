import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { project, sh, startNew } from "../../work/testkit.ts";
import { reviewSizes } from "./review.ts";
import { reviewSizeHints } from "./size-hint.ts";

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (p: string, n: number) => [p, n].join("-");
const KB = 1024;

const rule = (n: number, body: string) => `---\nid: ${id("BR", n)}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\n---\n## 规则\n\n${body}\n\n## 例子\n\n- a → b\n`;
const readme = (name: string, body = "Short.") => `---\ncode: [src/${name}]\n---\n# ${name}\n\n## 术语\n\n- x: y\n\n${body}\n`;
const sub = (name: string, body = "Short.") => `# ${name}\n\n${body}\n`;

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

function hintsFor(files: Record<string, string>, budgetBytes: number) {
  const root = mkdtempSync(join(tmpdir(), "canon-size-hint-"));
  write(root, files);
  return { root, hints: reviewSizeHints(root, readCorpus(root).corpus, budgetBytes) };
}

/** `dungeon`: a README of `readmeKb` KB and one short rule. */
const dungeon = (readmeKb: number) => ({
  "canon/rules/dungeon/README.md": readme("dungeon", "t".repeat(readmeKb * KB)),
  [`canon/rules/dungeon/${id("BR", 1)}.md`]: rule(1, "Short."),
});

describe("review size hint", () => {
  test("BR-2375: a big top README near the budget gives one hint with the domain and the three sizes, and no subdomain split", () => {
    const { hints } = hintsFor(dungeon(79), 60 * KB);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/^hint review-size: dungeon: changed documents 0 KB \(not known without a change\), review instructions \+ rule index \+ accepted decision titles \d+ KB, domain text 8\d KB; 8\d KB together is 13\d% of review_max_prompt_kb = 60 KB/);
    expect(hints[0]).toContain("shorten the README of dungeon");
    expect(hints[0]).toContain("does not make them smaller");
    expect(hints[0]).not.toContain("canon rule domain");
  });

  test("BR-2375: the sizes in the hint are the ones the refusal names", async () => {
    const { reviewPrompts } = await import("./review.ts");
    const root = mkdtempSync(join(tmpdir(), "canon-size-hint-"));
    write(root, dungeon(79));
    const { corpus } = readCorpus(root);
    const refusal = reviewPrompts(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 1)), {}, 60 * KB);
    if (refusal.ok) throw new Error("expected a refusal");
    const hint = reviewSizeHints(root, corpus, 60 * KB)[0]!;
    for (const part of [/review instructions \+ rule index \+ accepted decision titles \d+ KB, domain text \d+ KB/, /cannot be made smaller than \d+ KB/]) expect(refusal.error.message).toMatch(part);
    expect(hint.match(/titles (\d+) KB, domain text (\d+) KB/)!.slice(1)).toEqual(refusal.error.message.match(/titles (\d+) KB, domain text (\d+) KB/)!.slice(1));
    expect(hint).toContain(`at least ${refusal.error.message.match(/than (\d+) KB/)![1]} KB`);
  });

  test("BR-2375: rule-sized pieces near the budget give a hint that suggests raising the budget or splitting into subdomains; far from it, no hint", () => {
    const files = {
      "canon/rules/big/README.md": readme("big"),
      "canon/rules/big/a/README.md": sub("big/a"),
      [`canon/rules/big/a/${id("BR", 1)}.md`]: rule(1, "x".repeat(30 * KB)),
      [`canon/rules/big/a/${id("BR", 2)}.md`]: rule(2, "x".repeat(30 * KB)),
    };
    expect(hintsFor(files, 100 * KB).hints).toEqual([]);
    const near = hintsFor(files, 40 * KB).hints;
    expect(near).toHaveLength(1);
    expect(near[0]).toContain("canon rule domain big/a/<name>");
    expect(near[0]).not.toContain("shorten the README");
  });

  test("BR-2375: exactly 70% of the budget in bytes gives a hint, a budget one byte larger gives none", () => {
    let pad = 0;
    for (;; pad++) {
      const root = mkdtempSync(join(tmpdir(), "canon-size-hint-"));
      write(root, { ...dungeon(1), "canon/rules/dungeon/README.md": readme("dungeon", "t".repeat(KB + pad)) });
      const { corpus } = readCorpus(root);
      const { fixed, pieces } = reviewSizes(root, corpus);
      const total = fixed + pieces[0]!.piece;
      if (total % 7 !== 0) continue;
      expect(reviewSizeHints(root, corpus, (total * 10) / 7)).toHaveLength(1);
      expect(reviewSizeHints(root, corpus, (total * 10) / 7 + 1)).toEqual([]);
      return;
    }
  });

  test("BR-2375: 69% of the budget gives no hint and 71% gives one", () => {
    const root = mkdtempSync(join(tmpdir(), "canon-size-hint-"));
    write(root, dungeon(40));
    const { corpus } = readCorpus(root);
    const { fixed, pieces } = reviewSizes(root, corpus);
    const total = fixed + pieces[0]!.piece;
    expect(reviewSizeHints(root, corpus, Math.floor(total / 0.69) + 1)).toEqual([]);
    expect(reviewSizeHints(root, corpus, Math.floor(total / 0.71))).toHaveLength(1);
  });

  test("BR-2375: the measured case of #145, 78% of the budget, is hinted", () => {
    const root = mkdtempSync(join(tmpdir(), "canon-size-hint-"));
    write(root, dungeon(100));
    const { corpus } = readCorpus(root);
    const { fixed, pieces } = reviewSizes(root, corpus);
    const hints = reviewSizeHints(root, corpus, Math.round((fixed + pieces[0]!.piece) / 0.78));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/is 78% of review_max_prompt_kb/);
  });

  test("BR-2375: with this work's changed documents counted, 64% gives no hint, 72% gives one that does not say refused, over 100% says the landing's review will be refused", () => {
    const mk = (kbSize: number) => {
      const root = mkdtempSync(join(tmpdir(), "canon-size-hint-"));
      write(root, { ...dungeon(40), [`canon/decisions/${id("D", 5)}.md`]: `---\nid: ${id("D", 5)}\ntitle: Big\nstatus: proposed\n---\n${"d".repeat(Math.round(kbSize * KB))}\n` });
      const { corpus } = readCorpus(root);
      return { root, corpus, work: { changed: corpus.docs.filter((d) => d.id === id("D", 5)), extras: {} } };
    };
    const base = mk(1);
    const { fixed, pieces } = reviewSizes(base.root, base.corpus);
    const static_ = fixed + pieces[0]!.piece;
    const budget = Math.round(static_ / 0.5);
    const at = (kbSize: number) => { const m = mk(kbSize); return reviewSizeHints(m.root, m.corpus, budget, m.work); };
    expect(reviewSizeHints(base.root, base.corpus, budget)).toEqual([]);
    expect(at(0.1 * budget / KB)).toEqual([]);
    const near = at((0.22 * budget) / KB);
    expect(near).toHaveLength(1);
    expect(near[0]).toContain("this work's");
    expect(near[0]).toMatch(/is 7\d% of review_max_prompt_kb/);
    expect(near[0]).not.toContain("will be refused");
    const over = at((0.6 * budget) / KB);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatch(/changed documents \d+ KB \(this work's/);
    expect(over[0]).toContain("the landing's review of this work will be refused");
    expect(over[0]).toContain("land the changed documents in several smaller changes");
    // without the work the same corpus counts 0 and says so
    expect(reviewSizeHints(base.root, base.corpus, Math.round(static_ / 0.72))[0]).toContain("not known without a change");
  });

  test("BR-2375: a small README but a 70 KB rule gives a hint that suggests splitting into subdomains", () => {
    const { hints } = hintsFor({ "canon/rules/fat/README.md": readme("fat"), [`canon/rules/fat/${id("BR", 1)}.md`]: rule(1, "x".repeat(70 * KB)) }, 60 * KB);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("canon rule domain fat/<name>");
    expect(hints[0]).not.toContain("shorten the README");
  });

  test("BR-2375: two top domains near the budget give two hints, one per domain", () => {
    const { hints } = hintsFor({ ...dungeon(79), "canon/rules/vault/README.md": readme("vault", "t".repeat(79 * KB)), [`canon/rules/vault/${id("BR", 2)}.md`]: rule(2, "Short.") }, 60 * KB);
    expect(hints.map((h) => h.split(":")[1])).toEqual([" dungeon", " vault"]);
  });

  test("BR-2375: a 70 KB subdomain README under a short top README gives a hint that suggests splitting, not shortening the top README", () => {
    const { hints } = hintsFor(
      {
        "canon/rules/wide/README.md": readme("wide"),
        "canon/rules/wide/sub/README.md": sub("wide/sub", "y".repeat(70 * KB)),
        [`canon/rules/wide/sub/${id("BR", 1)}.md`]: rule(1, "Short."),
      },
      60 * KB,
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("canon rule domain wide/sub/<name>");
    expect(hints[0]).not.toContain("shorten the README");
  });
});

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("canon check review size hint", () => {
  const setup = (config: string) => {
    const root = project();
    write(root, { ...dungeon(79), "src/dungeon/.keep": "", "canon/config.yaml": `tests: []\nreview_max_prompt_kb: 60\n${config}` });
    return root;
  };

  test("BR-2375: canon check prints the hint on stderr; stdout, --json and the exit code stay as without it", () => {
    const root = setup("");
    const r = canon(root, "check");
    expect([r.code, r.out]).toEqual([0, "ok: 1 documents, 1 domains\n"]);
    expect(r.err.split("\n").filter((l) => l.startsWith("hint review-size:"))).toHaveLength(1);
    const j = canon(root, "check", "--json");
    expect([j.code, JSON.parse(j.out), j.err.includes("hint review-size: dungeon:")]).toEqual([0, [], true]);
  });

  test("BR-2375: with review: none there is no hint", () => {
    const r = canon(setup("review: none\n"), "check");
    expect([r.code, r.err.includes("hint review-size")]).toEqual([0, false]);
  });
});

describe("canon check review size hint in a change worktree", () => {
  const decisionOf = (kbSize: number) => `---\nid: ${id("D", 5)}\ntitle: Big\nstatus: proposed\n---\n${"d".repeat(kbSize * KB)}\n`;
  const config = (budget: number) => `tests: []\nreview: "true"\nreview_max_prompt_kb: ${budget}\n`;
  const setup = (budget: number) => {
    const root = project();
    write(root, { ...dungeon(60), "src/dungeon/.keep": "", "canon/config.yaml": config(budget) });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "dungeon");
    return { root, wt: startNew(root, "Change dungeon docs").worktree };
  };
  const hintOf = (cwd: string) => canon(cwd, "check").err.split("\n").filter((l) => l.startsWith("hint review-size:"));

  test("BR-2375: in a worktree the work's real changed documents are counted and named, and main without them counts 0", () => {
    const { root, wt } = setup(100);
    expect(hintOf(root)).toEqual([]); // about 63% of the budget
    write(wt, { [`canon/decisions/${id("D", 5)}.md`]: decisionOf(10) });
    const near = hintOf(wt);
    expect(near).toHaveLength(1);
    expect(near[0]).toContain("this work's");
    expect(near[0]).not.toContain("will be refused");
    write(wt, { [`canon/decisions/${id("D", 5)}.md`]: decisionOf(60) });
    const over = hintOf(wt);
    expect(over).toHaveLength(1);
    expect(over[0]).toContain("the landing's review of this work will be refused");
    expect(hintOf(root)).toEqual([]);
  });

  test("BR-2375: a worktree that changes no reviewed document counts 0 and says so", () => {
    const { wt } = setup(80);
    write(wt, { "app2.txt": "x" });
    const h = hintOf(wt);
    expect(h).toHaveLength(1);
    expect(h[0]).toContain("not known without a change");
  });

  test("BR-2375: the budget is main's, not the worktree's edited config", () => {
    const { wt } = setup(100);
    write(wt, { "canon/config.yaml": config(20) });
    expect(hintOf(wt)).toEqual([]);
  });
});
