import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { isPlaceholderLine, templateFor } from "../documents/templates.ts";
import { BUILTIN_TYPES } from "../documents/types.ts";
import { check } from "./check.ts";
import { optionProblems } from "./sources.ts";

// Fixture ids are assembled at runtime so this file does not itself name decisions when canon check scans the repo.
const d = (n: number) => ["D", n].join("-");
const body = (options: string) => `## 背景\n\nB.\n\n## 方案\n\n${options}\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
const messages = (options: string) => optionProblems(body(options)).map((p) => p.message);

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-options-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

describe("decision options (BR-2109)", () => {
  test("BR-2109: `+` and `1)` list items count as options, like `-` and `1.`", () => {
    expect(messages("+ A：采用。\n+ B：否决。")).toEqual([]);
    expect(messages("1) A：采用。\n2) B：否决。")).toEqual([]);
    expect(messages("* A：采用。\n- B：否决。")).toEqual([]);
    expect(messages("+ A：采用。")).toEqual(["has 1 option(s) under ## 方案; a choice needs at least two"]);
  });

  test("BR-2109: 不采用 and its like say rejected, not taken", () => {
    expect(messages("1. A：不采用，太慢。\n2. B：否决。")).toEqual(["no option under ## 方案 is 采用"]);
    expect(messages("1. A：采用。\n2. B：没有采用，太贵。")).toEqual([]);
    expect(messages("1. A：采用。\n2. B：未采用。")).toEqual([]);
  });

  test("BR-2109: a 采用 or 否决 inside a source line or a quote marks nothing", () => {
    const source = "   - 来源：src/x.ts “we 否决 this one, quoted”";
    expect(messages(`1. A：采用。\n2. B，太慢。\n${source}`)).toEqual(['option "B，太慢。" says neither 采用 nor 否决', "no option under ## 方案 is 否决"]);
    expect(messages("1. A：采用。\n2. B 的文档写着“推荐采用”，但我们否决。")).toEqual([]);
    expect(messages("1. A：采用。\n2. B 的文档写着“推荐采用”。")).toEqual(['option "B 的文档写着“推荐采用”。" says neither 采用 nor 否决', "no option under ## 方案 is 否决"]);
  });

  test("BR-2109: an options section of template placeholders only is left to template-unfilled", () => {
    expect(optionProblems(templateFor("decision"))).toEqual([]);
    expect(messages("+ <方案一>：<采用或否决>\n1) <方案二>")).toEqual([]);
    expect(messages("1. A：采用。\n2. <方案二>：<采用或否决，以及理由>")).toEqual(["has 1 option(s) under ## 方案; a choice needs at least two"]);
  });

  test("BR-2109: checked whatever the status; a decision without a 方案 section is not checked", () => {
    const decision = (n: number, status: string, text: string) => ({ [`canon/decisions/${d(n)}.md`]: `---\nid: ${d(n)}\ntitle: X${n}\nstatus: ${status}\n---\n${text}` });
    const types = BUILTIN_TYPES.map((t) => (t.name === "decision" ? { ...t, sections: ["背景", "决定"] } : t));
    const root = repo({
      ...decision(1, "proposed", body("1. A：采用。")),
      ...decision(2, "accepted", body("1. A：采用。")),
      ...decision(3, "superseded", body("1. A：采用。")),
      ...decision(4, "accepted", "## 背景\n\nB.\n\n## 决定\n\nA.\n"),
    });
    const got = check({ root, ...readCorpus(root, types), testFiles: [] }).filter((f) => f.rule === "decision-options").map((f) => f.path);
    expect(got.sort()).toEqual([1, 2, 3].map((n) => `canon/decisions/${d(n)}.md`));
  });
});

describe("placeholder lines", () => {
  test("BR-2035 BR-2109: a placeholder written as a `+` or `1)` item is still a placeholder", () => {
    expect(isPlaceholderLine("+ <方案一>")).toBe(true);
    expect(isPlaceholderLine("1) <方案一>：<理由>")).toBe(true);
    expect(isPlaceholderLine("- [ ] <任务>")).toBe(true);
    expect(isPlaceholderLine("[ ] <任务>")).toBe(false);
    expect(isPlaceholderLine("+ 金额 <100 元时免运费")).toBe(false);
  });
});
