import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { reviewPrompt, runReview } from "./review.ts";

const br = (n: number) => ["BR", n].join("-");

function corpusOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "canon-wording-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return { root, ...readCorpus(root) };
}

const rule = (n: number, title: string, status: string) => `---\nid: ${br(n)}\ntitle: ${title}\nstatus: ${status}\nuntested: fixture\n---\n## 规则\n\n${title}.\n`;
const files = {
  "canon/rules/auth/README.md": "---\ncode: [src/auth]\n---\n# auth\n",
  "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n",
  [`canon/rules/auth/${br(7)}.md`]: rule(7, "锁定账号", "planned"),
  [`canon/rules/billing/${br(1)}.md`]: rule(1, "退款", "active"),
  [`canon/rules/billing/${br(2)}.md`]: rule(2, "旧手续费", "retired"),
};

describe("the rule review and planned rules", () => {
  test("BR-2036: the rule index lists planned rules marked [规划中], active ones unmarked, not retired ones", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === br(1)));
    expect(prompt).toContain(`- ${br(7)} [auth] [规划中] 锁定账号`);
    expect(prompt).toContain(`- ${br(1)} [billing] 退款`);
    expect(prompt).not.toContain(`- ${br(2)} `);
  });
});

describe("wording judgements", () => {
  const q = { id: br(1), title: "退款", before: "退款必须在 30 天内。", after: "退款一定要在 30 天内。", examples: "- 第 30 天 → 退款" };

  test("BR-2239: with wording questions the prompt has a Wording judgements section with both statements and the examples, and asks for the wording field", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, [], { wording: [q] });
    expect(prompt).toContain("# Wording judgements");
    expect(prompt).toContain(`## ${br(1)} 退款\n\n### 规则 before\n\n退款必须在 30 天内。\n\n### 规则 now\n\n退款一定要在 30 天内。\n\n### 例子 (unchanged)\n\n- 第 30 天 → 退款`);
    expect(prompt).toContain('"wording":{"<rule id>":"wording"|"behaviour"}');
  });

  test("BR-2239: without wording questions the prompt has no Wording judgements section", () => {
    const { root, corpus } = corpusOf(files);
    expect(reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === br(1)))).not.toContain("Wording judgements");
  });

  test("BR-2239: the verdict carries the wording answers when the reviewer gave them, and none otherwise", async () => {
    const answer = (out: string) => runReview(`printf '%s' '${out}'`, tmpdir(), "prompt", { timeoutMs: 60_000 });
    expect(await answer(`{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`)).toEqual({ ok: true, value: { verdict: "ok", findings: [], wording: { [br(1)]: "wording" } } });
    expect(await answer(`{"verdict":"ok","findings":[],"wording":{"${br(1)}":"behaviour"}}`)).toEqual({ ok: true, value: { verdict: "ok", findings: [], wording: { [br(1)]: "behaviour" } } });
    expect(await answer('{"verdict":"ok","findings":[]}')).toEqual({ ok: true, value: { verdict: "ok", findings: [] } });
  });
});
