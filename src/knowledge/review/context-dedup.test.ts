import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { reviewPrompt, reviewPromptParts, reviewPrompts } from "./review.ts";
import { FAST, project, quiet, reviewLandings, sh, startNew, ws } from "../../work/testkit.ts";
import { land } from "../../work/land/land.ts";

const CLI = join(import.meta.dir, "../../invocation/main.ts");
const KB = 1024;
const rule = (n: number, text: string) => `---\nid: BR-${n}\ntitle: Rule ${n}\nuntested: demo\nbusiness: x\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;
const readme = "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n";
function fixture(texts: string[]) {
  const root = project();
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  writeFileSync(join(root, "canon/rules/billing/README.md"), readme);
  for (const [i, text] of texts.entries()) writeFileSync(join(root, `canon/rules/billing/BR-${i + 1}.md`), rule(i + 1, text));
  return { root, corpus: readCorpus(root).corpus };
}
const context = (p: string) => p.slice(p.indexOf("# Current context for "), p.lastIndexOf("# Rule index"));
const occurrences = (p: string, text: string) => p.split(text).length - 1;

describe("review context uses changed text once", () => {
  test("BR-2009 BR-2036: only this prompt's changed rules lose their domain bodies; changing the selected rule changes the summary", () => {
    const texts = ["Refunds paid in 30 days.", "Every refund is logged."];
    const { root, corpus } = fixture(texts);
    for (const [i, text] of texts.entries()) {
      const changed = corpus.docs.filter((d) => d.id === `BR-${i + 1}`);
      const p = reviewPrompt(root, corpus, changed);
      expect(p.slice(0, p.indexOf("# Current context for"))).toContain(text);
      expect(context(p)).toContain(`## BR-${i + 1} Rule ${i + 1} [business: x]\n`);
      expect(context(p)).not.toContain(text);
      expect(context(p)).toContain(texts[1 - i]!);
      expect(occurrences(p, text)).toBe(1);
    }
  });

  test("BR-2009: cited rules and newly landed rules keep full domain bodies; deleted text and READMEs stay visible", () => {
    const { root, corpus } = fixture(["Changed refunds.", "Cited refund text."]);
    const changed = corpus.docs.filter((d) => d.id === "BR-1");
    const cited = corpus.docs.filter((d) => d.id === "BR-2");
    for (const extra of [{ cited }, { incremental: { from: 42, added: cited } }]) {
      const p = reviewPrompt(root, corpus, changed, { ...extra, deleted: [{ id: "D-9", path: "canon/decisions/D-9.md", text: "DELETED-DECISION" }], readmes: ["billing"] });
      expect(occurrences(p, "Changed refunds.")).toBe(1);
      expect(occurrences(p, "Cited refund text.")).toBe(2);
      expect(context(p)).toContain("Cited refund text.");
      expect(p).toContain("DELETED-DECISION");
      expect(context(p)).toContain("**退款**");
    }
  });

  test("BR-2009 BR-2358 BR-2359: CLI preview and landed reviews preserve full changed text in every call, with whole and split budgets", async () => {
    for (const budget of [250, 24]) {
      const { root } = fixture([`UNCHANGED-1 ${"u".repeat(8 * KB)}`, `UNCHANGED-2 ${"v".repeat(8 * KB)}`]);
      const calls = `${root}-calls`;
      mkdirSync(calls);
      const script = `${root}-review.sh`;
      writeFileSync(script, `n=$(ls "${calls}" | wc -l); cat > "${calls}/p.$n"\necho '{"findings":[]}'\n`);
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview_parallel: 1\nreview_max_prompt_kb: ${budget}\nreview: 'sh ${script}'\n`);
      sh(root, "add", "-A"); sh(root, "commit", "-qm", "domain and reviewer");
      const s = startNew(root, "Changed rule");
      const body = `CHANGED-3 ${"改".repeat(2 * KB)}`;
      writeFileSync(join(s.worktree, "canon/rules/billing/BR-3.md"), rule(3, body));
      const preview = Bun.spawn(["bun", CLI, "work", "review"], { cwd: s.worktree, env: { ...process.env, CANON_ACTOR: "agent:a" }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(preview.stdout).text(), new Response(preview.stderr).text(), preview.exited]);
      expect({ code, err, ok: out.includes("review: ok") }).toEqual({ code: 0, err: "", ok: true });
      const previewCount = readdirSync(calls).length;
      expect(previewCount).toBe(budget === 250 ? 1 : 2);
      for (const file of readdirSync(calls)) {
        const p = readFileSync(join(calls, file), "utf8");
        expect(occurrences(p, body)).toBe(1);
      }
      sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "rule");
      expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
      await reviewLandings(root);
      expect(readdirSync(calls).length).toBe(2 * previewCount);
      for (const file of readdirSync(calls)) {
        const p = readFileSync(join(calls, file), "utf8");
        expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(budget * KB);
        expect(p.slice(0, p.indexOf("# Current context for"))).toContain(body);
        expect(occurrences(p, body)).toBe(1);
        expect(context(p)).not.toContain("CHANGED-3");
      }
      for (const tag of ["UNCHANGED-1", "UNCHANGED-2"]) {
        expect(readdirSync(calls).filter((f) => context(readFileSync(join(calls, f), "utf8")).includes(tag))).toHaveLength(2);
      }
    }
  }, 60_000);

  test("BR-2009 BR-2448: another document part still receives a changed rule's full domain body", () => {
    const bodies = [1, 2, 3].map((n) => `Common description.\n\nBODY-${n} ${"x".repeat(30 * KB)}`);
    const { root, corpus } = fixture(bodies);
    const changed = corpus.docs.filter((d) => d.kind === "rule");
    const result = reviewPromptParts(root, corpus, changed, {}, 80 * KB);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.parts.length).toBeGreaterThan(1);
    for (const p of result.value.prompts) {
      const head = p.slice(0, p.indexOf("# Current context for"));
      for (const [i, body] of bodies.entries()) {
        if (head.includes(`## BR-${i + 1} Rule ${i + 1} (rule`)) {
          expect(head).toContain(body);
          expect(context(p).includes(body)).toBe(false);
        }
      }
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(80 * KB);
    }
    for (const [i, body] of bodies.entries()) {
      expect(result.value.prompts.some((p) => !p.includes(`## BR-${i + 1} Rule ${i + 1} (rule`) && context(p).includes(body))).toBe(true);
    }
  });

  test("BR-2359 BR-2488: the smallest piece is priced without the changed body, leaving room for whole cited text", () => {
    const body = `CHANGED-1, see BR-4. ${"c".repeat(12 * KB)}`;
    const cited = `CITED-4 ${"d".repeat(2 * KB)}`;
    const { root, corpus } = fixture([body, `OTHER-2 ${"a".repeat(6 * KB)}`, `OTHER-3 ${"b".repeat(6 * KB)}`, cited]);
    for (const budget of [30, 31]) {
      const result = reviewPrompts(root, corpus, corpus.docs.filter((d) => d.id === "BR-1"), {}, budget * KB);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.length).toBeGreaterThan(1);
      for (const p of result.value) {
        expect(Buffer.byteLength(p)).toBeLessThanOrEqual(budget * KB);
        expect(p).toContain("# Documents the changed documents name (whole text");
        expect(p.slice(0, p.indexOf("# Current context for"))).toContain(cited);
        expect(occurrences(p, body)).toBe(1);
      }
    }
    const refused = reviewPrompts(root, corpus, corpus.docs.filter((d) => d.id === "BR-1"), {}, 12 * KB);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("above review_max_prompt_kb = 12 KB");
  });

  test("BR-2112: CLI context --full still prints every rule body", async () => {
    const { root } = fixture(["First body stays.", "Second body stays."]);
    const p = Bun.spawn(["bun", CLI, "context", "billing", "--full"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("## BR-1 Rule 1 [business: x]");
    expect(out).toContain("First body stays.");
    expect(out).toContain("Second body stays.");
  });
});
