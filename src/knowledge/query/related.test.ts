import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { RELATED_LIMIT, relatedLines, relatedTo } from "./related.ts";
import { project, sh } from "../../work/testkit.ts";

// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (p: string, n: number) => [p, n].join("-");
const BR = (n: number) => id("BR", n);
const D = (n: number) => id("D", n);
const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

const readme = (name: string) => `---\ncode: [src/${name}]\n---\n# ${name}\n\n## 术语\n\n- **词**：意思\n`;
/** A rule whose title is a Latin word, so titles share no text unless a test says so. */
const rule = (n: number, body: string, title = `r${n}x`, status = "active") => `---\nid: ${BR(n)}\ntitle: ${title}\nstatus: ${status}\nuntested: fixture\n---\n## 规则\n\n${body}\n\n## 例子\n\n- a → b\n`;
const decision = (n: number, body: string, status = "accepted") => `---\nid: ${D(n)}\ntitle: d${n}x\nstatus: ${status}\n---\n\n## 背景\n\n${body}\n`;

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const domains = {
  "canon/rules/billing/README.md": readme("billing"),
  "canon/rules/billing/sub/README.md": "# sub\n\n## 术语\n\n- **词**：意思\n",
  "canon/rules/shipping/README.md": readme("shipping"),
};

function relatedOf(files: Record<string, string>, target: string) {
  const root = mkdtempSync(join(tmpdir(), "canon-related-"));
  write(root, { ...domains, ...files });
  const { corpus } = readCorpus(root);
  const doc = corpus.docs.find((d) => d.id === target)!;
  const related = relatedTo(corpus, doc, RELATED_LIMIT);
  return { related, lines: relatedLines(doc, related), ids: related.map((r) => r.doc.id) };
}

describe("related documents: three rankings fused", () => {
  test("BR-2387: a rule in the same top-level domain sharing a name is listed too", () => {
    const l = relatedOf({ [`canon/rules/billing/${BR(1)}.md`]: rule(1, "写 `refund.issued` 事件。"), [`canon/rules/billing/sub/${BR(2)}.md`]: rule(2, "读 `refund.issued`。"), [`canon/rules/shipping/${BR(7)}.md`]: rule(7, "看 `refund.issued`。") }, BR(1));
    expect(new Set(l.ids)).toEqual(new Set([BR(2), BR(7)]));
    expect(l.lines.find((x) => x.startsWith(`  ${BR(2)} `))).toContain("`refund.issued`");
  });

  test("BR-2387: a rule in another domain naming the asked one is found by that backlink alone, with the sentence naming it", () => {
    const l = relatedOf({ [`canon/rules/billing/${BR(1)}.md`]: rule(1, "退款时记账。"), [`canon/rules/shipping/${BR(7)}.md`]: rule(7, `按 ${BR(1)} 发货。`) }, BR(1));
    expect(l.lines).toEqual([`Related to ${BR(1)} (references both ways, shared text and names; check they do not contradict it):`, `  ${BR(7)} r7x  (names ${BR(1)})`, `      按 ${BR(1)} 发货。`]);
    const back = relatedOf({ [`canon/rules/billing/${BR(1)}.md`]: rule(1, "退款时记账。"), [`canon/rules/shipping/${BR(7)}.md`]: rule(7, `按 ${BR(1)} 发货。`) }, BR(7));
    expect(back.lines[1]).toBe(`  ${BR(1)} r1x  (named by ${BR(7)})`);
  });

  test("BR-2387: two hops through a document linked with at most 10 others count, through a more linked one they do not", () => {
    const files = { [`canon/rules/billing/${BR(1)}.md`]: rule(1, `依据 ${D(3)}。`), [`canon/decisions/${D(3)}.md`]: decision(3, `结果见 ${BR(9)}。`), [`canon/rules/shipping/${BR(9)}.md`]: rule(9, "发货单。") };
    const l = relatedOf(files, BR(1));
    expect(l.ids).toContain(BR(9));
    expect(l.lines.find((x) => x.startsWith(`  ${BR(9)} `))).toBe(`  ${BR(9)} r9x  (via ${D(3)})`);
    const hub: Record<string, string> = {};
    for (let n = 20; n < 31; n++) hub[`canon/rules/shipping/${BR(n)}.md`] = rule(n, `参见 ${D(3)}。`);
    expect(relatedOf({ ...files, ...hub }, BR(1)).ids).not.toContain(BR(9));
  });

  test("BR-2387: two rules that never name each other but say the same thing in other words are found by their character pairs", () => {
    const l = relatedOf({
      [`canon/rules/billing/${BR(1)}.md`]: rule(1, "角色转身后朝向角度立即更新。"),
      [`canon/rules/shipping/${BR(5)}.md`]: rule(5, "转身以后按新的朝向角度重算。"),
      [`canon/rules/shipping/${BR(6)}.md`]: rule(6, "日志按天归档。"),
    }, BR(1));
    expect(l.ids).toEqual([BR(5)]);
    expect(l.lines[1]).toStartWith(`  ${BR(5)} r5x  (words `);
    expect(l.related[0]!.words).toEqual(expect.arrayContaining(["朝向", "角度", "转身"]));
    expect(l.lines[2]).toBe("      转身以后按新的朝向角度重算。");
  });

  test("BR-2387: only the section headings in common is no shared text, and nothing related gives no lines", () => {
    const l = relatedOf({ [`canon/rules/billing/${BR(1)}.md`]: rule(1, "退款时记账。"), [`canon/rules/shipping/${BR(6)}.md`]: rule(6, "日志按天归档。") }, BR(1));
    expect(l.ids).toEqual([]);
    expect(l.lines).toEqual([]);
  });

  test("BR-2387: a retired rule and a proposed decision naming the rule are not listed; an accepted decision is", () => {
    const l = relatedOf({
      [`canon/rules/billing/${BR(1)}.md`]: rule(1, "退款时记账。"),
      [`canon/rules/shipping/${BR(8)}.md`]: rule(8, `按 ${BR(1)}。`, "r8x", "retired"),
      [`canon/decisions/${D(3)}.md`]: decision(3, `因为 ${BR(1)}。`),
      [`canon/decisions/${D(4)}.md`]: decision(4, `关于 ${BR(1)}。`, "proposed"),
    }, BR(1));
    expect(l.ids).toEqual([D(3)]);
  });

  test("BR-2387: a document both naming the rule and sharing its words comes before one that only shares words, even with a higher text score", () => {
    const l = relatedOf({
      [`canon/rules/billing/${BR(1)}.md`]: rule(1, "写退款单。"),
      [`canon/rules/shipping/${BR(7)}.md`]: rule(7, `按 ${BR(1)} 写退款单，再核对一次金额和收件人。`),
      [`canon/rules/shipping/${BR(8)}.md`]: rule(8, "写退款单。"),
    }, BR(1));
    expect(l.ids).toEqual([BR(7), BR(8)]);
  });

  test("BR-2387: at most 10 are listed with no line counting the rest; shared names rarest first, the first 3 written", () => {
    const many: Record<string, string> = {};
    for (let n = 40; n < 52; n++) many[`canon/rules/shipping/${BR(n)}.md`] = rule(n, "看 `refund.issued`。");
    const l = relatedOf({ ...many, [`canon/rules/billing/${BR(1)}.md`]: rule(1, "写 `refund.issued`。") }, BR(1));
    expect(l.related).toHaveLength(10);
    expect(l.lines.some((x) => x.includes("… and"))).toBe(false);
    const names = relatedOf({
      [`canon/rules/billing/${BR(1)}.md`]: rule(1, "写 `zz.1`、`aa.1`、`mm.2`、`kk.3`。"),
      [`canon/rules/shipping/${BR(7)}.md`]: rule(7, "写 `zz.1`、`aa.1`、`mm.2`、`kk.3`。"),
      [`canon/rules/shipping/${BR(8)}.md`]: rule(8, "写 `mm.2`。"),
    }, BR(1));
    expect(names.lines).toContain(`  ${BR(7)} r7x  (\`aa.1\`, \`kk.3\`, \`zz.1\`, …; words aa kk zz)`);
  });

  test("BR-2387: a name in more than 10 other live documents is not a shared name; in exactly 10 it is", () => {
    const of = (k: number) => {
      const common: Record<string, string> = {};
      for (let n = 20; n < 20 + k; n++) common[`canon/rules/shipping/${BR(n)}.md`] = rule(n, "输出 `--json`。");
      return relatedOf({ ...common, [`canon/rules/billing/${BR(1)}.md`]: rule(1, "输出 `--json`。") }, BR(1));
    };
    expect(of(10).related.every((r) => r.shared.includes("--json"))).toBe(true);
    expect(of(11).related.every((r) => r.shared.length === 0)).toBe(true);
  });

  test("BR-2387: the sentence line is cut to 120 characters with an ellipsis", () => {
    const long = `按 ${BR(1)} ${"发".repeat(130)}。`;
    const l = relatedOf({ [`canon/rules/billing/${BR(1)}.md`]: rule(1, "退款时记账。"), [`canon/rules/shipping/${BR(7)}.md`]: rule(7, long) }, BR(1));
    expect(l.lines[2]).toBe(`      ${long.slice(0, 119)}…`);
  });
});

describe("canon context shows them", () => {
  test("BR-2387: canon context of a rule ends with the related section, same domain included; of a path it has none", () => {
    const root = project();
    write(root, { ...domains, [`canon/rules/billing/${BR(1)}.md`]: rule(1, "写 `refund.issued` 事件。"), [`canon/rules/billing/sub/${BR(2)}.md`]: rule(2, `按 ${BR(1)} 读 \`refund.issued\`。`) });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "fixture");
    const run = (target: string) => Bun.spawnSync(["bun", MAIN, "context", target], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:test" } }).stdout.toString();
    expect(run(BR(1))).toContain(`Related to ${BR(1)} (references both ways, shared text and names; check they do not contradict it):\n  ${BR(2)} r2x  (names ${BR(1)}; \`refund.issued\`; words issued refund)\n      按 ${BR(1)} 读 \`refund.issued\`。`);
    expect(run("src/billing")).not.toContain("Related to");
  });
});
