import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { project } from "../../work/testkit.ts";
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

  test("BR-2375: exactly 80% of the budget in bytes gives a hint, a budget one byte larger gives none", () => {
    let pad = 0;
    for (;; pad++) {
      const root = mkdtempSync(join(tmpdir(), "canon-size-hint-"));
      write(root, { ...dungeon(1), "canon/rules/dungeon/README.md": readme("dungeon", "t".repeat(KB + pad)) });
      const { corpus } = readCorpus(root);
      const { fixed, pieces } = reviewSizes(root, corpus);
      const total = fixed + pieces[0]!.piece;
      if (total % 4 !== 0) continue;
      expect(reviewSizeHints(root, corpus, (total * 5) / 4)).toHaveLength(1);
      expect(reviewSizeHints(root, corpus, (total * 5) / 4 + 1)).toEqual([]);
      return;
    }
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
