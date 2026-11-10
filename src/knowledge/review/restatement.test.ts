import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { project, sh } from "../../work/testkit.ts";
import { reviewScope } from "../../work/land/checks/review-scope.ts";
import { parseAnswer, reviewPrompt, RULE_CRITERIA } from "./review.ts";

// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (p: string, n: number) => [p, n].join("-");
const [B1, B2, B3] = [id("BR", 1), id("BR", 2), id("BR", 3)];
const STATEMENT = "退款在七个工作日内原路退回到付款账户";
const COPY = `退款按 ${B1} 在七个工作日内原路退回到付款账户。`;
const rule = (n: number, statement: string) => `---\nid: ${id("BR", n)}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\n---\n\n## 规则\n\n${statement}\n\n## 例子\n\n- a → b\n`;

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** BR-1 and BR-2 committed as the base, then `edit` committed as the head; the prompt the rule review would get. */
function landing(edit: Record<string, string>) {
  const root = project();
  write(root, { "canon/rules/billing/README.md": "# billing\n\nMoney.\n", [`canon/rules/billing/${B1}.md`]: rule(1, STATEMENT), [`canon/rules/billing/${B2}.md`]: rule(2, "x。\n第二行。") });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  const base = sh(root, "rev-parse", "HEAD");
  write(root, edit);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "head");
  const corpus = readCorpus(root).corpus;
  const scope = reviewScope(root, base, sh(root, "rev-parse", "HEAD"), corpus);
  return { scope, prompt: reviewPrompt(root, corpus, scope.changedDocs, { added: scope.added, restatements: scope.restatements }) };
}

describe("rule review of restatements", () => {
  test("BR-2405: an edited rule's new line is listed with its number and text; unchanged lines are not; a copy of another rule is a hint", () => {
    const { prompt } = landing({ [`canon/rules/billing/${B2}.md`]: rule(2, `x。\n第二行。\n${COPY}`) });
    const lines = prompt.slice(prompt.indexOf("# Lines added or changed in this landing\n"));
    expect(lines).toContain(`## ${B2} (canon/rules/billing/${B2}.md)\n\n12: ${COPY}\n`);
    expect(lines).not.toContain("10: x。");
    expect(prompt).toContain(`# Possible restatements found by shared wording`);
    expect(prompt).toContain(`- canon/rules/billing/${B2}.md:12: ${B2} restates ${B1} (13 runs shared`);
    expect(prompt).toContain("`restatement`: a changed rule or decision that, in a line this landing adds or changes");
  });

  test("BR-2405: a new rule is not listed among the edited lines, but its restatements are hints", () => {
    const { prompt } = landing({ [`canon/rules/billing/${B3}.md`]: rule(3, COPY) });
    expect(prompt).not.toContain("# Lines added or changed in this landing\n");
    expect(prompt).toContain(`${B3} restates ${B1}`);
  });

  test("BR-2405: a rule that only lost a line says so; with no restatement there is no hints section", () => {
    const { prompt } = landing({ [`canon/rules/billing/${B2}.md`]: rule(2, "x。") });
    expect(prompt).toContain(`## ${B2} (canon/rules/billing/${B2}.md)\n\n(only lines removed)`);
    expect(prompt).not.toContain("# Possible restatements found by shared wording");
  });

  test("BR-2405: a finding under the restatement key blocks", () => {
    expect(RULE_CRITERIA).toContain("restatement");
    const v = parseAnswer({ findings: [{ criterion: "restatement", text: `${B2} 复述了 ${B1}` }] });
    expect(v.ok && v.value.verdict).toBe("block");
  });
});
