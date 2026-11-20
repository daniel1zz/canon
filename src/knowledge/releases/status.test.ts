import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";
import { behaviourHash } from "../documents/behaviour.ts";
import { parseDocFile } from "../documents/docfile.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default (as in releases.test.ts)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
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
    expect(lines[0]!.replace(/\s+/g, " ")).toBe(`${R(1)} shipped 版本1 规划中 0 已通过 3 待 main 测试 0 待重新执行 0 发布后又改了 1 成功标准 已满足 0/0 变更 已合入 0 进行中 0 在等 0 可开始 0 完成`);
    expect(lines[1]!.replace(/\s+/g, " ")).toBe(`${R(2)} active 版本2 规划中 1 已通过 0 待 main 测试 0 待重新执行 1 成功标准 已满足 0/0 变更 已合入 0 进行中 0 在等 0 可开始 0 未完成`);
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

const PLAN4 = "| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | 建表 | - |\n| 2 | 接口 | 1 |\n| 3 | 界面 | 1 |\n| 4 | 联调 | 2, 3 |\n";
const changeText = (n: number, status: string, front = "", plan = "") =>
  `---\nid: ${C(n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n${plan ? `## 计划\n\n${plan}\n` : ""}## 任务\n\n- [x] x\n`;
const commitAll = (root: string, msg: string) => {
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", msg);
};

const criteriaRelease = (n: number, status: string, criteria: string, extra = "") =>
  `---\nid: ${R(n)}\ntitle: 版本${n}\nstatus: ${status}\n${extra}---\n\n${SECTIONS.map((x) => `## ${x}\n\n${x === "成功标准" ? criteria : "内容"}\n`).join("\n")}`;

describe("progress: rules and criteria decide done, linked changes are workload", () => {
  test("BR-2328 BR-2568: the line adds the criteria met, the workload of linked changes and done; a plan's steps are not shown", () => {
    const root = fixture();
    write(root, {
      [`canon/releases/${R(2)}.md`]: criteriaRelease(2, "active", `- S1 能存档。（已满足：${C(7)}）\n- S2 能读档。\n- 验收方式：自己验收。`),
      [`canon/changes/${C(5)}.md`]: changeText(5, "done", `release: ${R(2)}\n`),
      [`canon/changes/${C(6)}.md`]: changeText(6, "open", `release: ${R(2)}\n`, PLAN4),
    });
    commitAll(root, "links");
    const lines = canon(root, "release", "status").out.trim().split("\n").map((l) => l.replace(/\s+/g, " "));
    expect(lines[1]).toBe(`${R(2)} active 版本2 规划中 1 已通过 0 待 main 测试 0 待重新执行 1 成功标准 已满足 1/2 变更 已合入 1 进行中 0 在等 0 可开始 1 未完成`);
    expect(lines.join("\n")).not.toContain("计划");
    const j = JSON.parse(canon(root, "release", "status", "--json").out) as Record<string, unknown>[];
    expect(j[1]).toMatchObject({ criteria: { met: 1, unmet: 0, owner: 0, unproven: 1 }, changes: { landed: 1, in_progress: 0, waiting: 0, ready: 1 }, done: false });
    expect(j[1]).not.toHaveProperty("plans");
    expect(j[0]).toMatchObject({ done: true });
  });

  test("BR-2568: done needs every rule passed and every criterion met, whatever the changes; nothing to judge is not done", () => {
    const root = fixture();
    // R-1: its rules all passed; a met criterion keeps it done, an unproven one does not; open linked changes do not matter
    write(root, {
      [`canon/releases/${R(1)}.md`]: criteriaRelease(1, "shipped", `- S1 甲（已满足：${C(7)}）`, `shipped_at: ${"a".repeat(40)}\n`),
      [`canon/changes/${C(5)}.md`]: changeText(5, "open", `release: ${R(1)}\n`),
      [`canon/releases/${R(3)}.md`]: releaseFile(3, "planned"),
    });
    commitAll(root, "done");
    const done = (n: number) => (JSON.parse(canon(root, "release", "status", R(n), "--json").out) as { done: boolean }).done;
    expect(done(1)).toBe(true);
    expect(done(3)).toBe(false); // no rule and no criterion
    write(root, { [`canon/releases/${R(1)}.md`]: criteriaRelease(1, "shipped", `- S1 甲（已满足：${C(7)}）\n- S2 乙`, `shipped_at: ${"a".repeat(40)}\n`) });
    expect(done(1)).toBe(false);
  });

  test("BR-2329: a release lists its criteria after its rules, its own then its features', each with its state", () => {
    const root = fixture();
    write(root, {
      [`canon/releases/${R(2)}.md`]: criteriaRelease(2, "active", `- S1 能存档。（已满足：${C(7)}）`, `features: [${id("F", 1)}]\n`),
      [`canon/features/${id("F", 1)}.md`]: `---\nid: ${id("F", 1)}\ntitle: 读档\nstatus: active\n---\n\n## 目标\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\n- S1 能读档。\n`,
    });
    const out = canon(root, "release", "status", R(2)).out.trim().split("\n");
    expect(out.slice(-2)).toEqual([`  ${R(2)}/S1 已满足 能存档。`, `  ${id("F", 1)}/S1 未证明 能读档。`]);
    const j = JSON.parse(canon(root, "release", "status", R(2), "--json").out) as { criteria_list: unknown[] };
    expect(j.criteria_list).toEqual([{ doc: R(2), id: "S1", text: "能存档。", state: "met", evidence: [C(7)] }, { doc: id("F", 1), id: "S1", text: "能读档。", state: "unproven", evidence: [] }]);
  });

  test("BR-2569: canon feature status gives each active feature's rules, criteria, workload and done; one feature in detail; not a feature is exit 3", () => {
    const root = fixture();
    const F = (n: number) => id("F", n);
    const feature = (n: number, status: string, criteria: string) => `---\nid: ${F(n)}\ntitle: 模块${n}\nstatus: ${status}\n---\n\n## 目标\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\n${criteria}\n`;
    write(root, {
      [`canon/features/${F(1)}.md`]: feature(1, "active", `- S1 甲（已满足：${C(7)}）\n- S2 乙`),
      [`canon/features/${F(2)}.md`]: feature(2, "dropped", "- S1 丙"),
      [`canon/rules/billing/${BR(9)}.md`]: ruleText(9, `feature: ${F(1)}\n`),
      [`canon/rules/billing/${BR(10)}.md`]: ruleText(10, `feature: ${F(1)}\n`, "planned"),
      [`canon/changes/${C(5)}.md`]: changeText(5, "done", `feature: ${F(1)}\n`),
    });
    commitAll(root, "features");
    const r = canon(root, "feature", "status");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").map((l) => l.replace(/\s+/g, " "))).toEqual([`${F(1)} active 模块1 规划中 1 已通过 1 待 main 测试 0 待重新执行 0 成功标准 已满足 1/2 变更 已合入 1 进行中 0 在等 0 可开始 0 未完成`]);
    const one = canon(root, "feature", "status", F(1)).out.trim().split("\n");
    expect(one.slice(1)).toEqual([`  规划中: ${BR(10)}`, `  已通过: ${BR(9)} (${C(7)})`, `  ${F(1)}/S1 已满足 甲`, `  ${F(1)}/S2 未证明 乙`]);
    expect(canon(root, "feature", "status", F(2)).code).toBe(0);
    const j = JSON.parse(canon(root, "feature", "status", "--json").out) as Record<string, unknown>[];
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ id: F(1), done: false, criteria: { met: 1 }, changes: { landed: 1 } });
    for (const target of [F(9), R(1)]) expect([canon(root, "feature", "status", target).code, canon(root, "feature", "status", target).out]).toEqual([3, ""]);
    expect(canon(project(), "feature", "status").out.trim()).toBe("(no features)");
  });

  test("BR-2386 BR-2561: release on a change names an existing release, with or without a plan; a bad id is file-invalid", () => {
    const root = fixture();
    write(root, {
      [`canon/changes/${C(5)}.md`]: changeText(5, "open", `release: ${R(2)}\n`, PLAN4),
      [`canon/changes/${C(6)}.md`]: changeText(6, "open", `release: ${R(9)}\n`, PLAN4),
      [`canon/changes/${C(10)}.md`]: changeText(10, "open", `release: ${R(2)}\n`),
      [`canon/changes/${C(11)}.md`]: changeText(11, "open", "release: 1\n", PLAN4),
    });
    const out = canon(root, "check").out;
    expect(out).not.toContain(`${C(5)}.md`);
    expect(out).toMatch(new RegExp(`ref-dangling\\s+canon/changes/${C(6)}\\.md: ${C(6)} \`release\` names ${R(9)}`));
    // a change without a plan may name its own release (D-148)
    expect(out).not.toContain(`${C(10)}.md`);
    expect(out).toMatch(new RegExp(`file-invalid\\s+canon/changes/${C(11)}\\.md: .*must be one release id`));
  });

  test("BR-2386: shipping freezes no plan: a plan retagged or newly tagged after shipping is no finding", () => {
    const root = project();
    write(root, {
      [`canon/releases/${R(1)}.md`]: releaseFile(1, "active"),
      [`canon/releases/${R(2)}.md`]: releaseFile(2, "active"),
      [`canon/changes/${C(1)}.md`]: changeText(1, "open", `release: ${R(1)}\n`, PLAN4),
      [`canon/changes/${C(2)}.md`]: changeText(2, "open", `release: ${R(1)}\n`, PLAN4),
      [`canon/changes/${C(3)}.md`]: changeText(3, "open", "", PLAN4),
    });
    commitAll(root, "before shipping");
    const at = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [`canon/releases/${R(1)}.md`]: releaseFile(1, "shipped", `shipped_at: ${at}\n`) });
    commitAll(root, "shipped");
    write(root, {
      [`canon/changes/${C(2)}.md`]: changeText(2, "open", `release: ${R(2)}\n`, PLAN4),
      [`canon/changes/${C(3)}.md`]: changeText(3, "open", `release: ${R(1)}\n`, PLAN4),
    });
    expect(canon(root, "check").out).not.toContain("release-frozen");
  });
});

describe("canon release migrate-criteria", () => {
  test("BR-2567: prints what it would do, writes with --write, moves --note items out of the list; again is nothing to migrate", () => {
    const root = fixture();
    write(root, { [`canon/releases/${R(2)}.md`]: criteriaRelease(2, "active", "- S1 甲\n- 乙（未满足）\n- 验收方式：自己验收。") });
    commitAll(root, "old criteria");
    const dry = canon(root, "release", "migrate-criteria");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`${R(2)}: 2 list item(s) without an id\n  ${R(2)}#2 → S2  乙（未满足）\n  ${R(2)}#3 → S3  验收方式：自己验收。\n`);
    expect(sh(root, "status", "--porcelain").trim()).toBe("");
    for (const bad of [`${R(2)}#1`, `${R(2)}-3`]) {
      const r = canon(root, "release", "migrate-criteria", "--write", "--note", bad);
      expect(r.code).toBe(2);
      expect(sh(root, "status", "--porcelain").trim()).toBe("");
    }
    expect(canon(root, "release", "migrate-criteria", BR(3)).code).toBe(3);
    const w = canon(root, "release", "migrate-criteria", R(2), "--write", "--note", `${R(2)}#3`);
    expect(w.code).toBe(0);
    expect(w.out).toContain(`${R(2)}: numbered S2; moved 1 item(s) out of the list (canon/releases/${R(2)}.md; commit it with your change)`);
    expect(canon(root, "show", R(2)).out).toContain("## 成功标准\n\n- S1 甲\n- S2 乙（未满足）\n\n验收方式：自己验收。\n");
    expect(canon(root, "release", "migrate-criteria").out.trim()).toBe("nothing to migrate");
  });

  test("BR-2566: canon check names the documents with unnumbered items in one hint and keeps its exit code; dropped ones and numbered items are not counted", () => {
    const root = fixture();
    write(root, {
      [`canon/releases/${R(2)}.md`]: criteriaRelease(2, "active", "- S1 甲\n- 验收方式：自己验收。\n- 乙（未满足）\n  - 子项"),
      [`canon/releases/${R(3)}.md`]: criteriaRelease(3, "dropped", "- 丙"),
    });
    const r = canon(root, "check");
    expect(r.err).toContain(`hint criteria-unnumbered: list items in ## 成功标准 without an S<k> id are not success criteria (BR-2504): ${R(2)} (2); give each criterion its id and move the rest out of the list: canon release migrate-criteria`);
    const clean = fixture();
    expect([canon(clean, "check").err.includes("criteria-unnumbered"), canon(clean, "check").code]).toEqual([false, r.code]);
  });
});
