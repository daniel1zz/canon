import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { relatedElsewhere, relatedLines } from "./related.ts";
import { project, sh } from "../../work/testkit.ts";

const id = (p: string, n: number) => [p, n].join("-");
const BR = (n: number) => id("BR", n);
const D = (n: number) => id("D", n);
const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

const readme = (name: string) => `---\ncode: [src/${name}]\n---\n# ${name}\n\n## 术语\n\n- **词**：意思\n`;
const rule = (n: number, body: string, status = "active") => `---\nid: ${BR(n)}\ntitle: 规则${n}\nstatus: ${status}\nuntested: fixture\n---\n## 规则\n\n${body}\n\n## 例子\n\n- a → b\n`;
const decision = (n: number, body: string, status = "accepted") => `---\nid: ${D(n)}\ntitle: 决策${n}\nstatus: ${status}\n---\n\n## 背景\n\n${body}\n`;

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** billing: BR-1 (names `refund.issued`); shipping: BR-7 shares it; billing/sub: BR-2 shares it too. */
function base(): Record<string, string> {
  return {
    "canon/rules/billing/README.md": readme("billing"),
    "canon/rules/billing/sub/README.md": "# sub\n\n## 术语\n\n- **词**：意思\n",
    "canon/rules/shipping/README.md": readme("shipping"),
    [`canon/rules/billing/${BR(1)}.md`]: rule(1, "退款时写 `refund.issued` 事件，输出 `--json`。"),
    [`canon/rules/billing/sub/${BR(2)}.md`]: rule(2, "读 `refund.issued`。"),
    [`canon/rules/shipping/${BR(7)}.md`]: rule(7, "发货前看 `refund.issued`。"),
  };
}

function relatedOf(files: Record<string, string>, target: string) {
  const root = mkdtempSync(join(tmpdir(), "canon-related-"));
  write(root, files);
  const { corpus } = readCorpus(root);
  const doc = corpus.docs.find((d) => d.id === target)!;
  return relatedElsewhere(corpus, doc);
}
const ids = (l: ReturnType<typeof relatedOf>) => l.related.map((r) => r.doc.id);

describe("related documents in other domains", () => {
  test("BR-2387: a rule in another domain sharing a code-span name is related; one in the same top-level domain is not", () => {
    const l = relatedOf(base(), BR(1));
    expect(ids(l)).toEqual([BR(7)]);
    expect(l.related[0]!.shared).toEqual(["refund.issued"]);
  });

  test("BR-2387: an accepted decision referring to the rule is related by that id; a proposed one and a retired rule are not", () => {
    const l = relatedOf({ ...base(), [`canon/decisions/${D(3)}.md`]: decision(3, `因为 ${BR(1)}。`), [`canon/decisions/${D(4)}.md`]: decision(4, `关于 ${BR(1)}。`, "proposed"), [`canon/rules/shipping/${BR(8)}.md`]: rule(8, "也看 `refund.issued`。", "retired") }, BR(1));
    expect(ids(l)).toEqual([BR(7), D(3)]);
    expect(l.related.find((r) => r.doc.id === D(3))!.shared).toEqual([BR(1)]);
  });

  test("BR-2387: a name in more than 10 live documents is too common, and an id in backticks is an example, not a name", () => {
    const common: Record<string, string> = {};
    for (let n = 20; n < 31; n++) common[`canon/rules/shipping/${BR(n)}.md`] = rule(n, "输出 `--json`。");
    const l = relatedOf({ ...base(), ...common, [`canon/rules/shipping/${BR(9)}.md`]: rule(9, `例如 \`${BR(1)}\`。`) }, BR(1));
    expect(ids(l)).toEqual([BR(7)]);
  });

  test("BR-2387: at most 10 are listed, most shared names first, with the rest counted; none gives no lines", () => {
    const many: Record<string, string> = {};
    for (let n = 40; n < 52; n++) many[`canon/rules/shipping/${BR(n)}.md`] = rule(n, `看 \`refund.issued\`${n === 51 ? " 和 `refund.window`" : ""}。`);
    const files = { ...base(), ...many, [`canon/rules/billing/${BR(1)}.md`]: rule(1, "写 `refund.issued` 和 `refund.window`。") };
    // reason: refund.issued is now in 14 documents, too common; refund.window only in BR-51
    expect(ids(relatedOf(files, BR(1)))).toEqual([BR(51)]);
    const ten: Record<string, string> = {};
    for (let n = 40; n < 52; n++) ten[`canon/rules/shipping/${BR(n)}.md`] = rule(n, `看 \`r.${n % 6}\`${n === 45 ? " 和 `r.x`" : ""}。`);
    const body = `写 ${[0, 1, 2, 3, 4, 5].map((k) => `\`r.${k}\``).join("、")} 和 \`r.x\`。`;
    const l = relatedOf({ ...base(), ...ten, [`canon/rules/billing/${BR(1)}.md`]: rule(1, body) }, BR(1));
    expect(l.related).toHaveLength(10);
    expect(l.more).toBe(2);
    expect(l.related[0]!.doc.id).toBe(BR(45));
    const lines = relatedLines(l.related[0]!.doc, l);
    expect(lines[0]).toBe(`Related to ${BR(45)} in other domains (shared names; check they do not contradict it):`);
    expect(lines.at(-1)).toBe("  … and 2 more");
    const alone = relatedOf({ "canon/rules/billing/README.md": readme("billing"), [`canon/rules/billing/${BR(1)}.md`]: rule(1, "没有名字。") }, BR(1));
    expect(relatedLines(alone.related[0]?.doc ?? ({ id: BR(1) } as never), alone)).toEqual([]);
  });
});

describe("the boundaries", () => {
  test("BR-2387: a name in exactly 10 other live documents still counts; a 2-character name does not, a 3-character one does", () => {
    const ten: Record<string, string> = {};
    for (let n = 20; n < 30; n++) ten[`canon/rules/shipping/${BR(n)}.md`] = rule(n, "输出 `--json`。");
    const l = relatedOf({ ...base(), ...ten, [`canon/rules/billing/${BR(1)}.md`]: rule(1, "输出 `--json`。") }, BR(1));
    expect(l.related).toHaveLength(10);
    expect(l.more).toBe(0);
    expect(relatedLines(l.related[0]!.doc, l).some((x) => x.includes("… and"))).toBe(false);
    const short = { ...base(), [`canon/rules/billing/${BR(1)}.md`]: rule(1, "写 `ab` 和 `abc`。"), [`canon/rules/shipping/${BR(7)}.md`]: rule(7, "写 `ab`。"), [`canon/rules/shipping/${BR(8)}.md`]: rule(8, "写 `abc`。") };
    expect(ids(relatedOf(short, BR(1)))).toEqual([BR(8)]);
  });

  test("BR-2387: for a decision no domain is left out: rules of any domain sharing its names are listed", () => {
    const l = relatedOf({ ...base(), [`canon/decisions/${D(3)}.md`]: decision(3, "写 `refund.issued`。") }, D(3));
    expect(ids(l)).toEqual([BR(1), BR(2), BR(7)]);
  });
});

describe("canon context shows them", () => {
  test("BR-2387: canon context of a rule ends with the related section; of a path it has none", () => {
    const root = project();
    write(root, base());
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "fixture");
    const run = (target: string) => Bun.spawnSync(["bun", MAIN, "context", target], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:test" } }).stdout.toString();
    const out = run(BR(1));
    expect(out).toContain(`Related to ${BR(1)} in other domains (shared names; check they do not contradict it):\n  ${BR(7)} 规则7  (\`refund.issued\`)`);
    expect(out).not.toContain(`  ${BR(2)} 规则2  (`);
    expect(run("src/billing")).not.toContain("Related to");
  });
});
