import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh } from "../testkit.ts";

// reason: each case spawns canon several times; a loaded machine takes longer than bun's 5 s default (as in quality.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });

function cli(cwd: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")) } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const decision = (n: number, status: string, decide: string) =>
  `---\nid: D-${n}\ntitle: 决策${n}\nstatus: ${status}\n---\n\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n\n## 决定\n\n${decide}\n\n## 后果\n\nC.\n`;
const rule = (n: number, status: string, text: string) =>
  `---\nid: BR-${n}\ntitle: 规则${n}\nstatus: ${status}\nuntested: fixture\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;

function fixture(files: Record<string, string>): string {
  const root = project();
  roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

const judge = (root: string, actor = "agent:s1") =>
  (JSON.parse(cli(root, actor, "work", "due", "--json").out) as { judge: { key: string; kind: string; summary: string; next: string }[] }).judge.filter((i) => i.key.startsWith("commitments:"));

describe("decisions whose commitments no rule holds", () => {
  test("BR-2597: an accepted decision no current rule names, with a 决定 item naming no rule, is one judge item; a rule naming it, code-only names, proposed, superseded, not-doing and workers are handled", () => {
    const root = fixture({
      // no rule names D-1; its second item names no rule
      "canon/decisions/D-1.md": decision(1, "accepted", "1. 按 BR-9 做。\n2. 线索用途检查：加载时检查每条线索被引用。"),
      // a planned rule names D-2 in its prose
      "canon/decisions/D-2.md": decision(2, "accepted", "- 敌人有韧性值。"),
      // a rule names D-3 only inside backticks: that is not naming it
      "canon/decisions/D-3.md": decision(3, "accepted", "- 地图可以缩放。"),
      // every item names a rule
      "canon/decisions/D-4.md": decision(4, "accepted", "- 按 BR-9。"),
      "canon/decisions/D-5.md": decision(5, "proposed", "- 还没定的事。"),
      "canon/decisions/D-6.md": decision(6, "superseded", "- 被取代的事。"),
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n",
      "canon/rules/billing/BR-9.md": rule(9, "active", "退款三十天内通过。"),
      "canon/rules/billing/BR-10.md": rule(10, "planned", "按 D-2，敌人有韧性值。"),
      "canon/rules/billing/BR-11.md": rule(11, "active", "见 `D-3`。"),
    });
    const items = judge(root);
    expect(items.map((i) => [i.key, i.kind])).toEqual([["commitments:D-1", "commitments"], ["commitments:D-3", "commitments"]]);
    expect(items[0]!.summary).toContain("1 item(s)");
    expect(items[0]!.summary).toContain("线索用途检查");
    expect(items[0]!.next).toContain("canon work handled commitments:D-1 --not-doing");
    // a not-doing outcome keeps it out
    expect(cli(root, "agent:s1", "work", "handled", "commitments:D-3", "--not-doing", "只定流程").code).toBe(0);
    expect(judge(root).map((i) => i.key)).toEqual(["commitments:D-1"]);
    // a worker sees none of it
    expect(judge(root, "agent:s1:w1")).toEqual([]);
    // a rule that names D-1 takes it off
    writeFileSync(join(root, "canon/rules/billing/BR-12.md"), rule(12, "planned", "按 D-1，加载时检查每条线索被引用。"));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "rule for D-1");
    expect(judge(root)).toEqual([]);
  });
});
