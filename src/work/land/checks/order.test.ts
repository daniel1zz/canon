import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

/**
 * The floor runs after this change's own steps (BR-2014): a refusal from any of them leaves the floor unrun.
 * The floor here leaves a marker file outside the repository and fails when the tree has a FAIL file.
 */
function fixture(extraConfig = "") {
  const root = project();
  const marker = `${root}-floor-ran`;
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  writeFileSync(join(root, "canon/config.yaml"), `floor: "touch ${marker}; test ! -e FAIL"\ntests: ["src/**/*.test.ts"]\n${extraConfig}`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return { root, marker };
}

const ruleText = `---\nid: ${["BR", 1].join("-")}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds are fine.\n`;

function withRule(root: string) {
  const s = startNew(root, "New rule");
  writeFileSync(join(s.worktree, `canon/rules/billing/${["BR", 1].join("-")}.md`), ruleText);
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", "rule");
  return s;
}

describe("a single landing runs its own steps before the floor", () => {
  test("BR-2014: a review that blocks refuses with reason review and the floor never runs", async () => {
    const { root, marker } = fixture(`review: 'cat > /dev/null; echo ''{"verdict":"block","findings":["too vague"]}'''\n`);
    const out = await land(ws(withRule(root).worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(existsSync(marker)).toBe(false);
  });

  test("BR-2014: a review that passes and a floor that fails refuse with reason floor, and the floor ran", async () => {
    const { root, marker } = fixture(`review: 'cat > /dev/null; echo ''{"verdict":"ok","findings":[]}'''\n`);
    const s = withRule(root);
    writeFileSync(join(s.worktree, "FAIL"), "x");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "red");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("floor");
    expect(existsSync(marker)).toBe(true);
  });

  test("BR-2014: a review command that fails to run refuses with reason review and the floor never runs", async () => {
    const { root, marker } = fixture(`review: "exit 3"\n`);
    const out = await land(ws(withRule(root).worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(existsSync(marker)).toBe(false);
  });

  test("BR-2014 BR-2057: a failing before_land refuses with reason hook and the floor never runs", async () => {
    const { root, marker } = fixture("hooks:\n  before_land: \"exit 1\"\n");
    const s = startNew(root, "Hooked");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    sh(s.worktree, "commit", "-qam", "change");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("hook");
    expect(existsSync(marker)).toBe(false);
  });

  test("BR-2014 BR-2016: a canon check finding refuses with reason check and the floor never runs", async () => {
    const { root, marker } = fixture();
    const s = startNew(root, "Dangling");
    writeFileSync(join(s.worktree, "canon/changes/C-90-bad-ref.md"), "---\nid: C-90\ntitle: Bad ref\n---\n## 为什么\n\nSee D-99.\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [ ] X\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "dangling ref");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(existsSync(marker)).toBe(false);
  });

  test("BR-2014 BR-2344: a changed test file never run by canon work test is refused with test-report-missing and the floor never runs", async () => {
    const { root, marker } = fixture();
    const s = startNew(root, "Test change");
    writeFileSync(join(s.worktree, "src/a.test.ts"), "a\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "test file");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && out.message + JSON.stringify(out.findings)).toContain("test-report-missing");
    expect(existsSync(marker)).toBe(false);
  });

  test("BR-2014: a passing landing runs the floor once and lands", async () => {
    const { root, marker } = fixture();
    const s = startNew(root, "Plain");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    sh(s.worktree, "commit", "-qam", "change");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(marker)).toBe(true);
  });
});
