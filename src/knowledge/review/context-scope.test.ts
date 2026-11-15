import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../../work/testkit.ts";
import { reviewScope } from "../../work/land/checks/review-scope.ts";
import { readCorpus } from "../documents/read.ts";
import { reviewPromptParts } from "./review.ts";

const rule = (id: string) => `---\nid: ${id}\ntitle: Rule ${id}\nstatus: active\nuntested: demo\n---\n\n## 规则\n\nSENTINEL-${id}.\n\n## 例子\n\n- x → y\n`;
const decision = (id: string, body: string) => `---\nid: ${id}\ntitle: Decision ${id}\nstatus: accepted\n---\n\n## 背景\n\n${body}\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nnone.\n`;

/** Two top-level domains, game (BR-10) and billing (BR-20), and a decision D-1 on main naming both. */
function repo() {
  const root = project();
  for (const [dom, id] of [["game", "BR-10"], ["billing", "BR-20"]] as const) {
    mkdirSync(join(root, `canon/rules/${dom}`), { recursive: true });
    writeFileSync(join(root, `canon/rules/${dom}/README.md`), `---\ncode: [src/${dom}]\n---\n# ${dom}\n\n## 术语\n\n- **x**：y\n\n## 业务\n\n- **x**：y\n`);
    writeFileSync(join(root, `canon/rules/${dom}/${id}.md`), rule(id));
    mkdirSync(join(root, `src/${dom}`), { recursive: true });
    writeFileSync(join(root, `src/${dom}/.keep`), "");
  }
  mkdirSync(join(root, "canon/decisions"), { recursive: true });
  writeFileSync(join(root, "canon/decisions/D-1.md"), decision("D-1", "Covers BR-10 and BR-20."));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  return root;
}
const corpus = (root: string) => readCorpus(root, ws(root).config.types, ws(root).config).corpus;
const tops = (prompts: readonly string[]) => [...new Set(prompts.flatMap((p) => [...p.matchAll(/^# Current context for (\S+)/gm)].map((m) => m[1]!)))].sort();

describe("the domains a changed decision or release brings into the review (BR-2009, #237)", () => {
  test("BR-2009: a decision already on main brings only the domains its added or changed lines name; a new decision brings every domain its text names", () => {
    const root = repo();
    const base = sh(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "canon/decisions/D-1.md"), decision("D-1", "Covers BR-10 and BR-20.\n\nAlso BR-10 again."));
    writeFileSync(join(root, "canon/decisions/D-2.md"), decision("D-2", "New: BR-10 and BR-20."));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "one line in D-1, a new D-2");
    const head = sh(root, "rev-parse", "HEAD");
    const c = corpus(root);
    const scope = reviewScope(root, base, head, c);
    expect(scope.namedInAdded).toEqual([{ id: "D-1", ids: ["BR-10"] }]); // D-2 is new: no entry, its whole text counts
    const only = (id: string) => scope.changedDocs.filter((d) => d.id === id);
    const prompts = (id: string) => {
      const r = reviewPromptParts(root, c, only(id), { namedInAdded: scope.namedInAdded }, 250 * 1024);
      if (!r.ok) throw new Error(r.error.message);
      return r.value.prompts;
    };
    expect(tops(prompts("D-1"))).toEqual(["game"]); // the unchanged line naming BR-20 no longer brings billing
    expect(tops(prompts("D-2"))).toEqual(["billing", "game"]);
    // an edit whose added lines name no rule brings no domain
    writeFileSync(join(root, "canon/decisions/D-1.md"), decision("D-1", "Covers BR-10 and BR-20.\n\nAlso BR-10 again.\n\nA plain sentence."));
    sh(root, "commit", "-qam", "plain line");
    const later = reviewScope(root, head, sh(root, "rev-parse", "HEAD"), corpus(root));
    expect(later.namedInAdded).toEqual([{ id: "D-1", ids: [] }]);
  });
});
