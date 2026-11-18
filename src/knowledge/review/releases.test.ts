import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { reviewPrompt } from "./review.ts";

const id = (p: string, n: number) => [p, n].join("-");

const rule = (n: number, title: string, release?: string) =>
  `---\nid: ${id("BR", n)}\ntitle: ${title}\nstatus: active\nuntested: fixture\n${release ? `release: ${release}\n` : ""}---\n## 规则\n\n${title}。\n`;
const release = (n: number, status: string, not: string) =>
  `---\nid: ${id("R", n)}\ntitle: 版本 ${n}\nstatus: ${status}\n---\n## 目标\n\n目标${n}\n\n## 范围\n\n范围${n}\n\n## 不做\n\n${not}\n`;

/** R-1 (active, 不做 支付) with BR-1 and BR-2 tagged, R-2 with BR-3, an untagged BR-4, a retired BR-5 tagged R-1. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "canon-review-release-"));
  const files: Record<string, string> = {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n",
    [`canon/rules/billing/${id("BR", 1)}.md`]: rule(1, "退款", id("R", 1)),
    [`canon/rules/billing/${id("BR", 2)}.md`]: rule(2, "对账", id("R", 1)),
    [`canon/rules/billing/${id("BR", 3)}.md`]: rule(3, "发票", id("R", 2)),
    [`canon/rules/billing/${id("BR", 4)}.md`]: rule(4, "没标版本"),
    [`canon/rules/billing/${id("BR", 5)}.md`]: rule(5, "旧规则", id("R", 1)).replace("status: active", "status: retired"),
    [`canon/releases/${id("R", 1)}.md`]: release(1, "active", "不做支付网关"),
    [`canon/releases/${id("R", 2)}.md`]: release(2, "planned", "不做多币种"),
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const read = readCorpus(root);
  expect(read.problems).toEqual([]);
  const doc = (n: string) => read.corpus.docs.find((d) => d.id === n)!;
  return { root, corpus: read.corpus, doc };
}

describe("the rule review prompt and releases", () => {
  test("BR-2327: a changed release brings its tagged rules (not retired ones) and the instruction to block contradictions with 不做", () => {
    const { root, corpus, doc } = fixture();
    const prompt = reviewPrompt(root, corpus, [doc(id("R", 1))]);
    expect(prompt).toContain("excludes or lies outside its 范围");
    const part = prompt.split("# Release ")[1]!.split("\n# ")[0]!;
    expect(part).toContain(`${id("R", 1)} 版本 1 (active) (new text shown above)`);
    expect(part).toContain(`- ${id("BR", 1)} [billing] 退款\n- ${id("BR", 2)} [billing] 对账`);
    expect(part).not.toContain(id("BR", 3));
    expect(part).not.toContain(id("BR", 5));
    expect(part).not.toContain("不做支付网关"); // its text is in the changed documents, not repeated
    expect(prompt).toContain("不做支付网关"); // ... where it is
    expect(prompt.split("# Release ")).toHaveLength(2);
  });

  test("BR-2327: a changed tagged rule brings its release whole, once, even when two rules of it changed", () => {
    const { root, corpus, doc } = fixture();
    const prompt = reviewPrompt(root, corpus, [doc(id("BR", 1)), doc(id("BR", 2))]);
    expect(prompt.split("\n# Release ")).toHaveLength(2);
    const part = prompt.split("\n# Release ")[1]!.split("\n# ")[0]!;
    expect(part).toContain(`${id("R", 1)} 版本 1 (active)`);
    expect(part).toContain("不做支付网关");
    expect(part).toContain(`- ${id("BR", 1)} [billing] 退款`);
  });

  test("BR-2327: a planned tagged rule is marked, an untagged rule brings no release, the index names each rule's release", () => {
    const { root, corpus, doc } = fixture();
    const planned = { ...doc(id("BR", 3)), status: "planned" } as typeof corpus.docs[number];
    const withPlanned = { ...corpus, docs: corpus.docs.map((d) => (d.id === planned.id ? planned : d)) };
    expect(reviewPrompt(root, withPlanned, [planned])).toContain(`- ${id("BR", 3)} [billing] [规划中] 发票`);
    const untagged = reviewPrompt(root, corpus, [doc(id("BR", 4))]);
    expect(untagged).not.toContain("# Release ");
    expect(untagged).toContain(`- ${id("BR", 1)} [billing] [${id("R", 1)}] 退款`);
    expect(untagged).toContain(`- ${id("BR", 4)} [billing] 没标版本`);
  });
});

describe("the rule review prompt and features (#249)", () => {
  /** R-3 lists F-1 (不做 导出) with BR-6 tagged feature F-1; BR-7 is tagged F-1 but retired. */
  function features() {
    const root = mkdtempSync(join(tmpdir(), "canon-review-feature-"));
    const featureText = `---\nid: ${id("F", 1)}\ntitle: 账单\nstatus: active\n---\n## 目标\n\n对账\n\n## 范围\n\n月度账单\n\n## 不做\n\n不做导出\n\n## 成功标准\n\n- S1 能对账\n`;
    const files: Record<string, string> = {
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n",
      [`canon/rules/billing/${id("BR", 6)}.md`]: rule(6, "月度账单").replace("untested: fixture\n", `untested: fixture\nfeature: ${id("F", 1)}\n`),
      [`canon/rules/billing/${id("BR", 7)}.md`]: rule(7, "旧账单").replace("untested: fixture\n", `untested: fixture\nfeature: ${id("F", 1)}\n`).replace("status: active", "status: retired"),
      [`canon/rules/billing/${id("BR", 8)}.md`]: rule(8, "没挂模块"),
      [`canon/features/${id("F", 1)}.md`]: featureText,
      [`canon/releases/${id("R", 3)}.md`]: release(3, "active", "不做多币种").replace("status: active\n", `status: active\nfeatures: [${id("F", 1)}]\n`),
    };
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    const read = readCorpus(root);
    expect(read.problems).toEqual([]);
    return { root, corpus: read.corpus, doc: (n: string) => read.corpus.docs.find((d) => d.id === n)! };
  }

  test("BR-2327 BR-2009: a changed rule tagged with a feature brings the feature whole, its rules (not retired ones) and the 范围 and 不做 of each release listing it", () => {
    const { root, corpus, doc } = features();
    const prompt = reviewPrompt(root, corpus, [doc(id("BR", 6))]);
    expect(prompt).toContain("a feature whose 范围 does something the 不做 of a release listing it excludes");
    expect(prompt.split("\n# Feature ")).toHaveLength(2);
    const part = prompt.split("\n# Feature ")[1]!.split("\n# ")[0]!;
    expect(part).toContain(`${id("F", 1)} 账单 (active)`);
    expect(part).toContain("不做导出");
    expect(part).toContain(`Rules tagged ${id("F", 1)}:\n- ${id("BR", 6)} [billing] 月度账单`);
    expect(part).not.toContain(id("BR", 7));
    expect(part).toContain(`Releases listing ${id("F", 1)}:\n- ${id("R", 3)} 版本 3 (active)`);
    expect(part).toContain(`### ${id("R", 3)} 不做\n\n不做多币种`);
  });

  test("BR-2327: a changed feature is shown once, its text not repeated; a rule tagged with no feature brings none", () => {
    const { root, corpus, doc } = features();
    const prompt = reviewPrompt(root, corpus, [doc(id("F", 1))]);
    const part = prompt.split("\n# Feature ")[1]!.split("\n# ")[0]!;
    expect(part).toContain(`${id("F", 1)} 账单 (active) (new text shown above)`);
    expect(part).not.toContain("不做导出");
    expect(prompt).toContain("不做导出");
    expect(reviewPrompt(root, corpus, [doc(id("BR", 8))])).not.toContain("\n# Feature ");
  });
});
