import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { reviewPrompt } from "./review.ts";
import { reviewEntries } from "../../work/land/checks/review-scope.ts";
import { project, sh } from "../../work/testkit.ts";

const id = (p: string, n: number) => [p, n].join("-");
const Q = (n: number) => id("Q", n);
const BR = (n: number) => id("BR", n);

const standard = (n: number, aspect: string) => `---\nid: ${Q(n)}\ntitle: 标准${n}\naspect: ${aspect}\njudge: agent\ncovers: [.]\n---\n\n## 门槛\n\n打击后停顿 3 到 5 帧。\n\n## 来源\n\n- 暖雪录帧\n`;
const README = "canon/quality/README.md";

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

function fixture() {
  const root = project();
  write(root, {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n",
    [`canon/rules/billing/${BR(1)}.md`]: `---\nid: ${BR(1)}\ntitle: 退款\nstatus: active\nuntested: fixture\n---\n## 规则\n\n退款。\n`,
    [README]: "# 质量标准\n\n## 方面\n\n- **战斗手感**：\n- **音效**：推迟：「demo 之后」\n",
    [`canon/quality/${Q(1)}.md`]: standard(1, "战斗手感"),
  });
  const read = readCorpus(root);
  expect(read.problems).toEqual([]);
  return { root, corpus: read.corpus, doc: (n: string) => read.corpus.docs.find((d) => d.id === n)! };
}

describe("the rule review and quality standards", () => {
  test("BR-2559: a changed quality standard brings the aspect list and the untestable note on its 门槛; a changed rule alone brings neither", () => {
    const { root, corpus, doc } = fixture();
    const prompt = reviewPrompt(root, corpus, [doc(Q(1))]);
    const part = prompt.split(`# Quality aspects (${README})`)[1]!.split("\n# ")[0]!;
    expect(part).toContain(`- 战斗手感 (${Q(1)})`);
    expect(part).toContain("- 音效: 推迟：「demo 之后」");
    expect(prompt).toContain("打击后停顿 3 到 5 帧");
    expect(part).toContain("use the key `untestable` also for a changed quality standard whose 门槛");
    const ruleOnly = reviewPrompt(root, corpus, [doc(BR(1))]);
    expect(ruleOnly).not.toContain("# Quality aspects");
    expect(ruleOnly).not.toContain("门槛");
  });

  test("BR-2559: a landing that adds a quality standard is reviewed; one that only edits the aspect list is not", () => {
    const root = project();
    const base = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [README]: "# 质量标准\n\n## 方面\n\n- **战斗手感**：\n", [`canon/quality/${Q(1)}.md`]: standard(1, "战斗手感") });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "add");
    const added = sh(root, "rev-parse", "HEAD").trim();
    expect(reviewEntries(root, base, added).entries).toEqual([{ status: "A", path: `canon/quality/${Q(1)}.md` }]);
    write(root, { [README]: "# 质量标准\n\n## 方面\n\n- **战斗手感**：\n- **音效**：\n" });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "aspects");
    expect(reviewEntries(root, added, sh(root, "rev-parse", "HEAD").trim()).entries).toEqual([]);
  });
});
