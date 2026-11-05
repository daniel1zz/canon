import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";
import { behaviourHash } from "../documents/behaviour.ts";
import { parseDocFile } from "../documents/docfile.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default (as in releases.test.ts)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const BR = (n: number) => id("BR", n);
const C = (n: number) => id("C", n);

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const SECTIONS = ["目标", "用户", "范围", "不做", "成功标准", "故事地图切片"];
const releaseFile = (n: number, status: string, extra = "") => `---\nid: ${R(n)}\ntitle: 版本${n}\nstatus: ${status}\n${extra}---\n\n${SECTIONS.map((s) => `## ${s}\n\n内容\n`).join("\n")}`;
const ruleText = (n: number, front: string, status = "active") => `---\nid: ${BR(n)}\ntitle: 规则${n}\nstatus: ${status}\nuntested: fixture\n${front}---\n## 规则\n\n规则${n}的行为。\n\n## 例子\n\n- 输入 → 结果\n`;
const hashOf = (text: string) => behaviourHash((parseDocFile(text, "x") as { ok: true; value: { body: string } }).value.body);

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/**
 * R-1 shipped: BR-3 (changed_in R-2), BR-4 and BR-5 passed by C-7, BR-8 retired. R-2 active: BR-6 planned, BR-7 never executed.
 * BR-9 belongs to no release.
 */
function fixture(): string {
  const root = project();
  const rules: Record<number, string> = {
    3: ruleText(3, `release: ${R(1)}\nchanged_in: [${R(2)}]\n`),
    4: ruleText(4, `release: ${R(1)}\n`),
    5: ruleText(5, `release: ${R(1)}\n`),
    6: ruleText(6, `release: ${R(2)}\n`, "planned"),
    7: ruleText(7, `release: ${R(2)}\n`),
    8: ruleText(8, `release: ${R(1)}\n`, "retired"),
    9: ruleText(9, ""),
  };
  const passed = [3, 4, 5, 9];
  write(root, {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
    "src/billing/.keep": "",
    [`canon/releases/${R(1)}.md`]: releaseFile(1, "shipped", `shipped_at: ${"a".repeat(40)}\n`),
    [`canon/releases/${R(2)}.md`]: releaseFile(2, "active"),
    ...Object.fromEntries(Object.entries(rules).map(([n, t]) => [`canon/rules/billing/${BR(Number(n))}.md`, t])),
    [`canon/changes/${C(7)}.md`]: `---\nid: ${C(7)}\ntitle: 做了\nstatus: done\nrules: [${passed.map(BR).join(", ")}]\npasses:\n${passed.map((n) => `  ${BR(n)}: "${hashOf(rules[n]!)} acceptance"`).join("\n")}\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [x] x\n`,
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

describe("canon release status", () => {
  test("BR-2328: one line per release with the count of each state, shipped ones with the changed-after-ship count; retired and untagged rules are not counted", () => {
    const r = canon(fixture(), "release", "status");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.replace(/\s+/g, " ")).toBe(`${R(1)} shipped 版本1 规划中 0 已通过 3 待 main 测试 0 待重新执行 0 发布后又改了 1`);
    expect(lines[1]!.replace(/\s+/g, " ")).toBe(`${R(2)} active 版本2 规划中 1 已通过 0 待 main 测试 0 待重新执行 1`);
  });

  test("BR-2328: --json has one object per release with counts keyed by state, shipped_at null when not shipped", () => {
    const r = JSON.parse(canon(fixture(), "release", "status", "--json").out) as { id: string; shipped_at: string | null; counts: Record<string, number>; changed_after_ship: number }[];
    expect(r.map((x) => x.id)).toEqual([R(1), R(2)]);
    expect(r[0]).toMatchObject({ shipped_at: "a".repeat(40), counts: { planned: 0, passed: 3, waiting: 0, rerun: 0 }, changed_after_ship: 1 });
    expect(r[1]).toMatchObject({ shipped_at: null, counts: { planned: 1, passed: 0, waiting: 0, rerun: 1 } });
  });

  test("BR-2328: releases are in numeric order, and none says so with exit 0", () => {
    const root = fixture();
    write(root, { [`canon/releases/${R(10)}.md`]: releaseFile(10, "planned") });
    expect(canon(root, "release", "status").out.trim().split("\n").map((l) => l.split(/\s+/)[0])).toEqual([R(1), R(2), R(10)]);
    const none = canon(project(), "release", "status");
    expect([none.code, none.out.trim()]).toEqual([0, "(no releases)"]);
  });

  test("BR-2329: a release lists each state's rules with the change that passed them; shipped ones add the rules changed after shipping", () => {
    const root = fixture();
    const two = canon(root, "release", "status", R(2)).out.trim().split("\n");
    expect(two.slice(1)).toEqual([`  规划中: ${BR(6)}`, `  待重新执行: ${BR(7)}`]);
    const one = canon(root, "release", "status", R(1)).out.trim().split("\n");
    expect(one.slice(1)).toEqual([`  已通过: ${BR(3)} (${C(7)}), ${BR(4)} (${C(7)}), ${BR(5)} (${C(7)})`, `  发布后又改了: ${BR(3)} (changed in ${R(2)})`]);
    write(root, { [`canon/rules/billing/${BR(7)}.md`]: ruleText(7, `release: ${R(2)}\nchanged_in: [${R(3)}]\n`) });
    expect(canon(root, "release", "status", R(2)).out).not.toContain("发布后又改了"); // not shipped
  });

  test("BR-2329: --json of a release has its rules and the ids changed after shipping; a release with no rules has only the summary line", () => {
    const root = fixture();
    const one = JSON.parse(canon(root, "release", "status", R(1), "--json").out) as { rules: { id: string; state: string; change: string | null; changed_in: string[] }[]; changed_after_ship_rules: string[] };
    expect(one.rules.map((x) => [x.id, x.state, x.change])).toEqual([[BR(3), "passed", C(7)], [BR(4), "passed", C(7)], [BR(5), "passed", C(7)]]);
    expect(one.changed_after_ship_rules).toEqual([BR(3)]);
    const two = JSON.parse(canon(root, "release", "status", R(2), "--json").out) as { rules: { state: string }[] };
    expect(two.rules.map((x) => x.state)).toEqual(["planned", "rerun"]);
    write(root, { [`canon/releases/${R(3)}.md`]: releaseFile(3, "planned") });
    expect(canon(root, "release", "status", R(3)).out.trim().split("\n")).toHaveLength(1);
  });

  test("BR-2329: an id that is no release, or that does not exist, is exit 3 with nothing on stdout", () => {
    const root = fixture();
    for (const target of [R(9), BR(3)]) {
      const r = canon(root, "release", "status", target);
      expect([r.code, r.out]).toEqual([3, ""]);
      expect(r.err).toContain("is not a release");
    }
  });
});

describe("show and context mark a rule's release", () => {
  test("BR-2330: show's path line and context's rule lines carry the release, changed_in and the planned mark in order; untagged rules are unchanged", () => {
    const root = fixture();
    const show = (n: number) => canon(root, "show", BR(n)).out.split("\n")[0];
    expect(show(4)).toBe(`canon/rules/billing/${BR(4)}.md  [release ${R(1)}]`);
    expect(show(3)).toBe(`canon/rules/billing/${BR(3)}.md  [release ${R(1)}, changed in ${R(2)}]`);
    write(root, { [`canon/rules/billing/${BR(6)}.md`]: ruleText(6, `release: ${R(2)}\nchanged_in: [${R(3)}, ${R(4)}]\n`, "planned") });
    expect(show(6)).toBe(`canon/rules/billing/${BR(6)}.md  [规划中]  [release ${R(2)}, changed in ${R(3)}, ${R(4)}]`);
    expect(show(9)).toBe(`canon/rules/billing/${BR(9)}.md`);
    const brief = canon(root, "context", "billing").out;
    expect(brief).toContain(`- ${BR(4)} [release ${R(1)}] 规则4`);
    expect(brief).toContain(`- ${BR(6)} [规划中] [release ${R(2)}, changed in ${R(3)}, ${R(4)}] 规则6`);
    expect(brief).toContain(`- ${BR(9)} 规则9\n`);
    expect(canon(root, "context", "billing", "--full").out).toContain(`## ${BR(6)} [规划中] [release ${R(2)}, changed in ${R(3)}, ${R(4)}] 规则6`);
    expect(canon(root, "show", R(1)).out.split("\n")[0]).toBe(`canon/releases/${R(1)}.md`);
  });
});
