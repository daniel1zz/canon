import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../check/check.ts";
import { behaviourHash } from "./behaviour.ts";
import { readCorpus } from "./read.ts";

const br = (n: number) => ["BR", n].join("-");

describe("behaviour hash", () => {
  const base = "## 规则\n\n退款必须在 30 天内。\n\n## 例子\n\n- 第 30 天 → 退款\n- 第 31 天 → 退出码 2\n";

  test("BR-2236: the hash is the first 16 hex characters of SHA-256 over the two normalised sections", () => {
    const want = createHash("sha256").update("规则\nA\n例子\n- B").digest("hex").slice(0, 16);
    expect(behaviourHash("## 规则\n\nA\n\n## 例子\n\n- B\n")).toBe(want);
  });

  test("BR-2236: title, other sections and whitespace do not change it", () => {
    const h = behaviourHash(base);
    expect(behaviourHash(`${base}\n## 背景\n\n为什么。\n`)).toBe(h);
    expect(behaviourHash(base.replace("退款必须在 30 天内。", "退款必须在  30 天内。\n\n").replace("- 第 30", "  - 第 30"))).toBe(h);
  });

  test("BR-2236: an example's result or a sentence moved between the sections changes it", () => {
    const h = behaviourHash(base);
    expect(behaviourHash(base.replace("退出码 2", "退出码 3"))).not.toBe(h);
    expect(behaviourHash("## 规则\n\nA\n\n## 例子\n\n- B\n")).not.toBe(behaviourHash("## 规则\n\n\n## 例子\n\nA\n- B\n"));
  });
});

describe("pass records in a change's front matter", () => {
  const repo = (passes: string) => {
    const root = mkdtempSync(join(tmpdir(), "canon-passes-"));
    const files: Record<string, string> = {
      "canon/rules/billing/README.md": "---\ncode: [src]\n---\n# Billing\n\n## 术语\n\n- **退款**：钱退回\n",
      [`canon/rules/billing/${br(1)}.md`]: `---\nid: ${br(1)}\ntitle: R\nuntested: x\n---\n## 规则\n\nS.\n`,
      "canon/changes/C-1.md": `---\nid: C-1\ntitle: A\nstatus: done\n${passes}---\n## 为什么\n\nX.\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [x] X\n`,
    };
    mkdirSync(join(root, "src"), { recursive: true });
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), t);
    }
    return check({ root, ...readCorpus(root) }).map((f) => `${f.rule}${f.message.includes("passes") ? " passes" : ""}`);
  };

  test("BR-2237: a hash and a method, with or without wording, is valid and read", () => {
    expect(repo(`passes:\n  ${br(1)}: "3f2a9c0d1e4b5a67 test"\n`)).toEqual([]);
    expect(repo(`passes:\n  ${br(1)}: "3f2a9c0d1e4b5a67 acceptance wording"\n`)).toEqual([]);
    expect(repo(`passes:\n  ${br(1)}: "3f2a9c0d1e4b5a67 test-file"\n`)).toEqual([]); // evidence only down to the file (BR-2241)
  });

  test("BR-2237: an unknown method, a short or upper-case hash, or a list is file-invalid naming passes", () => {
    expect(repo(`passes:\n  ${br(1)}: "3f2a9c0d1e4b5a67 manual"\n`)).toEqual(["file-invalid passes"]);
    expect(repo(`passes:\n  ${br(1)}: "3F2A test"\n`)).toEqual(["file-invalid passes"]);
    expect(repo(`passes: [${br(1)}]\n`)).toEqual(["file-invalid passes"]);
  });

  test("BR-2237: a record of a rule that does not exist is ref-dangling", () => {
    expect(repo(`passes:\n  ${br(999)}: "3f2a9c0d1e4b5a67 test"\n`)).toEqual(["ref-dangling"]);
  });
});
