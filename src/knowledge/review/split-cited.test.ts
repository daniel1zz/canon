import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../../work/testkit.ts";
import { reviewScope } from "../../work/land/checks/review-scope.ts";
import { readCorpus } from "../documents/read.ts";
import { reviewPrompts } from "./review.ts";

const KB = 1024;
const rule = (id: string, text: string) => `---\nid: ${id}\ntitle: Rule ${id}\nstatus: active\nuntested: demo\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- x → y\n`;
const decision = (id: string, body: string, source = "   - 来源：canon/config.yaml “floor:”") =>
  `---\nid: ${id}\ntitle: Decision ${id}\nstatus: accepted\n---\n\n## 背景\n\n${body}\n\n## 方案\n\n1. A：采用。\n${source}\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nnone.\n`;

/** game: BR-10 and many padded rules; other: BR-90 (named by the decision) and BR-91 (named by the rule BR-10). */
function repo(): string {
  const root = project();
  for (const dom of ["game", "other"]) {
    mkdirSync(join(root, `canon/rules/${dom}`), { recursive: true });
    writeFileSync(join(root, `canon/rules/${dom}/README.md`), `---\ncode: [src/${dom}]\n---\n# ${dom}\n\n## 术语\n\n- **x**：y\n\n## 业务\n\n- **x**：y\n`);
    mkdirSync(join(root, `src/${dom}`), { recursive: true });
    writeFileSync(join(root, `src/${dom}/.keep`), "");
  }
  writeFileSync(join(root, "canon/rules/game/BR-10.md"), rule("BR-10", "按 BR-91 处理。"));
  for (let n = 11; n < 30; n++) writeFileSync(join(root, `canon/rules/game/BR-${n}.md`), rule(`BR-${n}`, `PAD-${n} ${"p".repeat(6 * KB)}`));
  writeFileSync(join(root, "canon/rules/other/BR-90.md"), rule("BR-90", `NAMED-BY-DECISION ${"q".repeat(8 * KB)}`));
  writeFileSync(join(root, "canon/rules/other/BR-91.md"), rule("BR-91", "NAMED-BY-RULE."));
  mkdirSync(join(root, "canon/decisions"), { recursive: true });
  writeFileSync(join(root, "canon/decisions/D-1.md"), decision("D-1", "Covers BR-90 and BR-10."));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  return root;
}
const corpus = (root: string) => readCorpus(root, ws(root).config.types, ws(root).config).corpus;

describe("documents a split review repeats in every call (BR-2359, #241)", () => {
  test("BR-2359 BR-2488: a document only a changed decision names is whole in call 1 and listed in later calls; one a changed rule names stays whole in every call", () => {
    const root = repo();
    const c = corpus(root);
    const changed = c.docs.filter((d) => d.id === "D-1" || d.id === "BR-10");
    const r = reviewPrompts(root, c, changed, {}, 70 * KB);
    if (!r.ok) throw new Error(r.error.message);
    const calls = r.value;
    expect(calls.length).toBeGreaterThan(1);
    /** The whole-text section only, up to the next heading of a listing or the domain text. */
    const named = (p: string) => {
      const from = p.indexOf("# Documents the changed documents name");
      const ends = ["# Documents only the changed decisions", "# More documents the changed", "# Current context for"].map((h) => p.indexOf(h, from)).filter((i) => i > from);
      return p.slice(from, Math.min(...ends));
    };
    expect(named(calls[0]!)).toContain("NAMED-BY-DECISION");
    for (const p of calls) expect(named(p)).toContain("NAMED-BY-RULE"); // #219: a rule's 按 BR-91 keeps BR-91 beside it
    for (const p of calls.slice(1)) {
      expect(named(p)).not.toContain("NAMED-BY-DECISION");
      expect(p).toContain("# Documents only the changed decisions or releases name (whole text in call 1 of this review");
      expect(p).toMatch(/^- BR-90 Rule BR-90 \(rule, active\)/m);
    }
    for (const p of calls) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(70 * KB);
  });
});

describe("a decision whose only edit is in its 来源 lines (BR-2009, #240)", () => {
  test("BR-2009: repointing a 来源 line is not a changed decision; any other edit beside it is", () => {
    const root = repo();
    const base = sh(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "canon/decisions/D-1.md"), decision("D-1", "Covers BR-90 and BR-10.", "   - 来源：canon/config.yaml “review:”"));
    sh(root, "commit", "-qam", "repoint the source");
    const moved = sh(root, "rev-parse", "HEAD");
    const scope = reviewScope(root, base, moved, corpus(root));
    expect(scope.sourcesOnly).toEqual(["canon/decisions/D-1.md"]);
    expect(scope.changedDocs.map((d) => d.id)).toEqual([]);
    writeFileSync(join(root, "canon/decisions/D-1.md"), decision("D-1", "Covers BR-90 and BR-10, and more.", "   - 来源：canon/config.yaml “floor:”"));
    sh(root, "commit", "-qam", "source and text");
    const both = reviewScope(root, moved, sh(root, "rev-parse", "HEAD"), corpus(root));
    expect(both.sourcesOnly).toEqual([]);
    expect(both.changedDocs.map((d) => d.id)).toEqual(["D-1"]);
  });
});
