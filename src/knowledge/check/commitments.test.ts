import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew } from "../../work/testkit.ts";

// reason: these cases run the CLI in a throwaway repository and a change worktree; under load one run takes seconds (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), all: r.stdout.toString() + r.stderr.toString() };
}

function put(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const rule = (n: number, text = "x。", status = "active") =>
  `---\nid: BR-${n}\ntitle: Rule ${n}\nstatus: ${status}\nuntested: 这个例子不验证行为\nbusiness: 退款\n---\n## 规则\n\n${text}\n\n## 例子\n\n- x → y\n`;
const decision = (n: number, decided: string, after = "无。") =>
  `---\nid: D-${n}\ntitle: Decision ${n}\nstatus: accepted\n---\n\n## 背景\n\n事实。\n\n## 方案\n\n1. 甲：采用，因为快。\n2. 乙：否决，因为慢。\n\n## 决定\n\n${decided}\n\n## 后果\n\n${after}\n`;

/** BR-9 names nothing; BR-10 names D-1; D-1's 决定 names BR-10. */
function fixture() {
  const root = project();
  put(root, {
    "canon/rules/billing/README.md": "# billing\n\n## 业务\n\n- **退款**：钱怎么退回去\n",
    "canon/rules/billing/BR-9.md": rule(9),
    "canon/rules/billing/BR-10.md": rule(10, "按 D-1 退款。"),
    "canon/decisions/D-1.md": decision(1, "采用方案 1，按 BR-10。"),
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

describe("a decision's commitments reach the rules that hold them", () => {
  test("BR-2469: a rule 决定 names in a new decision must name it back; a planned rule does, a retired one or one cited in backticks does not count", () => {
    const root = fixture();
    const wt = startNew(root, "新决策").worktree;
    put(wt, { "canon/decisions/D-2.md": decision(2, "1. 退款立即到账，按 BR-9。\n2. 对账按 BR-10。\n3. 新的提醒按 BR-11。\n4. 背景里的 `BR-12` 不算。"), "canon/rules/billing/BR-11.md": rule(11, "提醒，见 D-2。", "planned") });
    const r = canon(wt, "check");
    expect(r.code).toBe(1);
    expect(r.all).toContain("decision-rule-unlinked");
    expect(r.all).toContain("D-2's 决定 names BR-9 in a line this work wrote, but BR-9 does not name D-2");
    expect(r.all).toContain("D-2's 决定 names BR-10 in a line this work wrote, but BR-10 does not name D-2");
    expect(r.all).not.toContain("names BR-11 in a line");
    expect(r.all).not.toContain("names BR-12 in a line");
    put(wt, { "canon/rules/billing/BR-9.md": rule(9, "立即到账（D-2）。"), "canon/rules/billing/BR-10.md": rule(10, "按 D-1、D-2 退款。") });
    expect(canon(wt, "check").all).not.toContain("decision-rule-unlinked");
    put(wt, { "canon/rules/billing/BR-11.md": rule(11, "提醒，见 D-2。", "retired") });
    expect(canon(wt, "check").all).toContain("D-2's 决定 names BR-11 in a line this work wrote, but BR-11 is retired");
  });

  test("BR-2469: only lines of 决定 this work wrote are checked, so an old decision touched elsewhere needs no migration", () => {
    const root = fixture();
    put(root, { "canon/decisions/D-3.md": decision(3, "按 BR-9。") });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "an old decision whose rule does not name it");
    const wt = startNew(root, "改后果").worktree;
    put(wt, { "canon/decisions/D-3.md": decision(3, "按 BR-9。", "后果改了。") });
    expect(canon(wt, "check").all).not.toContain("decision-rule-unlinked");
    put(wt, { "canon/decisions/D-3.md": decision(3, "按 BR-9，立即到账。", "后果改了。") });
    expect(canon(wt, "check").all).toContain("D-3's 决定 names BR-9 in a line this work wrote, but BR-9 does not name D-3");
  });

  test("BR-2469: in the main checkout, outside any change, nothing is reported", () => {
    const root = fixture();
    put(root, { "canon/decisions/D-2.md": decision(2, "按 BR-9。") });
    expect(canon(root, "check").all).not.toContain("decision-rule-unlinked");
  });

  test("BR-2470: a line this work wrote that puts a behaviour off to later work is a note that never fails the check; an old one is not said", () => {
    const root = fixture();
    put(root, { "canon/rules/billing/BR-13.md": rule(13, "真实击退由击退变更实现，在那之前只在画面上。") });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "an old deferral");
    const wt = startNew(root, "推迟").worktree;
    put(wt, { "canon/rules/billing/BR-9.md": rule(9, "x。\n\n真实退款由退款变更实现，在那之前只退积分。") });
    const r = canon(wt, "check");
    expect(r.out).not.toContain("puts off"); // a note on standard error, never one of the findings that fail the check
    expect(r.err).toMatch(/note: canon\/rules\/billing\/BR-9\.md:\d+ puts off a behaviour to later work \(“由退款变更实现”\): give it a rule with status: planned/);
    expect(r.err).not.toContain("BR-13.md");
    put(wt, { "canon/rules/billing/BR-9.md": rule(9, "x。\n\n`在那之前` 这几个字写在反引号里。") });
    expect(canon(wt, "check").err).not.toContain("puts off a behaviour");
    const between = (n: number) => `由${"字".repeat(n)}变更实现`;
    put(wt, { "canon/rules/billing/BR-9.md": rule(9, `x。\n\n${between(30)}。`) });
    expect(canon(wt, "check").err).toContain("puts off a behaviour");
    put(wt, { "canon/rules/billing/BR-9.md": rule(9, `x。\n\n${between(31)}。`) });
    expect(canon(wt, "check").err).not.toContain("puts off a behaviour");
    put(wt, { "canon/rules/billing/BR-9.md": rule(9, "x。\n\n由下一步做。新的变更实现。") });
    expect(canon(wt, "check").err).not.toContain("puts off a behaviour");
  });

  test("BR-2471: an item of a 决定 this work wrote that names no rule is a note, never a finding; an item naming one, or one this work did not write, is not said", () => {
    const root = fixture();
    put(root, { "canon/decisions/D-3.md": decision(3, "1. 旧的一条没写规则。") });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "an old item with no rule");
    const wt = startNew(root, "新决策").worktree;
    put(wt, {
      "canon/decisions/D-2.md": decision(2, "1. 退款立即到账，按 BR-9。\n2. 敌人有韧性值：\n   - 韧性打空进入硬直。\n3. 背景里的 `BR-12` 不算点名。"),
      "canon/rules/billing/BR-9.md": rule(9, "立即到账（D-2）。"),
      "canon/decisions/D-3.md": decision(3, "1. 旧的一条没写规则。", "后果改了。"),
    });
    const r = canon(wt, "check");
    expect(r.out).not.toContain("names no rule");
    const notes = r.err.split("\n").filter((l) => l.includes("names no rule"));
    expect(notes.length).toBe(2);
    expect(notes[0]).toMatch(/^note: canon\/decisions\/D-2\.md:\d+ an item of D-2's 决定 this work wrote names no rule/);
    expect(notes.join("\n")).not.toContain("D-3");
  });
});
