import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { project, sh } from "../../testkit.ts";
import { reviewScope } from "./review-scope.ts";

// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (p: string, n: number) => [p, n].join("-");
const [B1, B2] = [id("BR", 1), id("BR", 2)];
const rule = (n: number, statement: string, links = "") => `---\nid: ${id("BR", n)}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\n${links}---\n\n## 规则\n\n${statement}\n\n## 例子\n\n- a → b\n`;

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** BR-1 and BR-2 committed as the base, then `edit` committed as the head. */
function landing(edit: Record<string, string>) {
  const root = project();
  write(root, {
    "canon/rules/billing/README.md": "# billing\n\nMoney.\n",
    [`canon/rules/billing/${B1}.md`]: rule(1, "退款在七个工作日内原路退回。"),
    [`canon/rules/billing/${B2}.md`]: rule(2, `按 ${B1} 退款。`),
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  const base = sh(root, "rev-parse", "HEAD");
  write(root, edit);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "head");
  return reviewScope(root, base, sh(root, "rev-parse", "HEAD"), readCorpus(root).corpus);
}

describe("BR-2009: a document whose only change is its links records is not reviewed", () => {
  test("BR-2009: a confirm-only edit (links added, body identical) leaves the scope empty", () => {
    const scope = landing({ [`canon/rules/billing/${B2}.md`]: rule(2, `按 ${B1} 退款。`, `links:\n  ${B1}: 0123456789abcdef\n`) });
    expect(scope.linksOnly).toEqual([`canon/rules/billing/${B2}.md`]);
    expect(scope.changedDocs).toHaveLength(0);
    expect(scope.reviewed).toHaveLength(0);
    expect(scope.entries).toHaveLength(0);
  });

  test("BR-2009: a links record edit together with a body edit is reviewed as usual", () => {
    const scope = landing({ [`canon/rules/billing/${B2}.md`]: rule(2, `按 ${B1} 退款，更新。`, `links:\n  ${B1}: 0123456789abcdef\n`) });
    expect(scope.linksOnly).toHaveLength(0);
    expect(scope.reviewed).toEqual([B2]);
  });

  test("BR-2009: a links record edit together with another front-matter edit is reviewed as usual", () => {
    const edited = rule(2, `按 ${B1} 退款。`, `links:\n  ${B1}: 0123456789abcdef\n`).replace("title: Rule 2", "title: Rule two");
    const scope = landing({ [`canon/rules/billing/${B2}.md`]: edited });
    expect(scope.linksOnly).toHaveLength(0);
    expect(scope.reviewed).toEqual([B2]);
  });
});
