import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, ws } from "../../work/testkit.ts";
import { readCorpus } from "../documents/read.ts";
import { reviewPrompt, reviewPrompts } from "./review.ts";

const KB = 1024;
const rule = (id: string, text: string) => `---\nid: ${id}\ntitle: Rule ${id}\nstatus: active\nuntested: demo\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- x → y\n`;

function repo(): string {
  const root = project();
  mkdirSync(join(root, "canon/rules/game"), { recursive: true });
  writeFileSync(join(root, "canon/rules/game/README.md"), "---\ncode: [src/game]\n---\n# game\n\n## 术语\n\n- **x**：y\n\n## 业务\n\n- **x**：y\n");
  for (let n = 10; n < 30; n++) writeFileSync(join(root, `canon/rules/game/BR-${n}.md`), rule(`BR-${n}`, `PAD-${n} ${"p".repeat(6 * KB)}`));
  return root;
}
const corpus = (root: string) => readCorpus(root, ws(root).config.types, ws(root).config).corpus;

describe("the review prompt puts what every call shares first (BR-2359, C-576)", () => {
  test("BR-2359: fixed instructions, then the rule index and accepted decisions, then the answer format and changed documents, then the domain text; the calls of a split review share that start", () => {
    const root = repo();
    const c = corpus(root);
    const changed = c.docs.filter((d) => d.id === "BR-10");
    const at = (p: string, h: string) => p.indexOf(h);
    const one = reviewPrompt(root, c, changed);
    expect(at(one, "You review changes to a project's rules")).toBe(0);
    expect(at(one, "# Rule index")).toBeLessThan(at(one, "Answer with JSON only"));
    expect(at(one, "Answer with JSON only")).toBeLessThan(at(one, "# Changed documents"));
    expect(at(one, "# Changed documents")).toBeLessThan(at(one, "# Current context for game"));
    const split = reviewPrompts(root, c, changed, {}, 60 * KB);
    if (!split.ok) throw new Error(split.error.message);
    expect(split.value.length).toBeGreaterThan(1);
    const shared = one.slice(0, at(one, "Answer with JSON only"));
    for (const p of split.value) expect(p.startsWith(shared)).toBe(true);
  });
});
