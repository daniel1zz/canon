import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../humans/questions.ts";
import { project, sh, startNew, ws } from "../testkit.ts";

/** The overview's quality line in a project without canon/quality (BR-2558). */
const NO_QUALITY = "质量标准：还没有（canon/quality）。用 canon-product 按产品类型调研同类产品，列出方面、写 Q-n";

// reason: each case spawns the CLI, which under load can take seconds per run (as in brief.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const C = (n: number) => id("C", n);
const BR = (n: number) => id("BR", n);

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a", CANON_MACHINE: "normal,1,8" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  // reason: fixtures predate the 7-day window, so only the cases about recent goal changes see one (BR-2505)
  const date = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const r = Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const release = (n: number, status: string, criteria = "内容", extra = "") =>
  `---\nid: ${R(n)}\ntitle: 版本${n}\nstatus: ${status}\n${extra}---\n\n## 目标\n\n内容\n\n## 成功标准\n\n${criteria}\n\n## 故事地图切片\n\n内容\n`;
const change = (n: number, status: string, body = "", front = "") => `---\nid: ${C(n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n${body}`;
const PLAN = "## 计划\n\n| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | 建表 | - |\n| 2 | 接口 | 1 |\n";
const CHORE = "chore-0f0f0f0f-0000-4000-8000-000000000000";
const CRITERIA = `- S1 规则全过。（已满足：${C(4)}）\n- S2 负责人玩通。（待负责人）\n- S3 没人解释也能玩。`;

/**
 * R-1 shipped, R-2 planned, R-3 active with three criteria (met by C-4, owner, unmarked) and one planned rule; C-4 done;
 * C-5 open with a two-step plan; C-6..C-11 open; C-12 a light change done for a chore. Landings: C-4, then the chore,
 * then C-9. One pending question, a tier C and a tier A finding.
 */
function fixture(): string {
  const root = project();
  write(root, {
    [`canon/releases/${R(1)}.md`]: release(1, "shipped", "内容", `shipped_at: ${"a".repeat(40)}\n`),
    [`canon/releases/${R(2)}.md`]: release(2, "planned"),
    [`canon/releases/${R(3)}.md`]: release(3, "active", CRITERIA),
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n",
    [`canon/rules/billing/${BR(6)}.md`]: `---\nid: ${BR(6)}\ntitle: 规则6\nstatus: planned\nrelease: ${R(3)}\n---\n## 规则\n\nx\n\n## 例子\n\n- a → b\n`,
    [`canon/changes/${C(4)}.md`]: change(4, "done"),
    [`canon/changes/${C(5)}.md`]: change(5, "open", PLAN),
    ...Object.fromEntries([6, 7, 8, 9, 10, 11].map((n) => [`canon/changes/${C(n)}.md`, change(n, "open")])),
    [`canon/changes/${C(12)}.md`]: change(12, "done", "", `chore: ${CHORE}\n`).replace("title: 变更12", "title: 轻变更12"),
  });
  const db = ws(root).db.db;
  const land = db.query("INSERT INTO events(ts, actor, kind, subject, detail) VALUES (?, 'agent:a', 'land.ok', ?, '{}')");
  land.run("2026-11-16T05:32:56.142Z", C(4));
  land.run("2026-11-16T06:00:00.000Z", CHORE);
  land.run("2026-11-16T07:42:40.496Z", C(9));
  ask(ws(root).db, "agent:a", null, "要不要发布？\n第二行", ["是", "否"]);
  const finding = db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, event, opened_at, tier) VALUES (?, 'contradiction', ?, ?, ?, 1, '2026-11-16T00:00:00Z', ?)");
  finding.run("c", JSON.stringify([BR(6)]), JSON.stringify([BR(6)]), "矛盾\n细节", "C");
  finding.run("a", JSON.stringify([BR(6)]), JSON.stringify([BR(6)]), "小问题", "A");
  return root;
}

const squash = (s: string) => s.replace(/ {2,}/g, " ");
const HISTORY = "细节：canon overview --history";

describe("canon overview", () => {
  test("BR-2505: four sections, the current release with one line per criterion, the agenda, what is in flight, the history outline; no plan section", () => {
    const r = canon(fixture(), "overview");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      "## 当前版本",
      `${R(3)}  active  版本3`,
      "规则 1 条：规划中 1  已通过 0  待 main 测试 0  待重新执行 0",
      "成功标准 3 条：已满足 1  未满足 0  待负责人 1  未证明 1",
      `  [已满足] ${R(3)}/S1 规则全过。`,
      `  [待负责人] ${R(3)}/S2 负责人玩通。`,
      `  [未证明] ${R(3)}/S3 没人解释也能玩。`,
      NO_QUALITY,
      "",
      "## 议程",
      "judge: 1: finding:2",
      `owner: 3: finding:1, question:1, criterion:${R(3)}/S2`,
      "",
      "## 正在做和在等",
      "(none)",
      "",
      "## 历史",
      `${C(9)} 变更9  2026-11-16 07:42 UTC`,
      `${C(12)} 轻变更12  2026-11-16 06:00 UTC`,
      `${C(4)} 变更4  2026-11-16 05:32 UTC`,
      HISTORY,
    ]);
    expect(r.out).not.toContain("## 计划");
  });

  test("BR-2505: with no active release the lowest planned one stands in with a hint; with none at all the section says so and the rest still comes", () => {
    const root = fixture();
    write(root, { [`canon/releases/${R(3)}.md`]: release(3, "planned", CRITERIA), [`canon/releases/${R(10)}.md`]: release(10, "planned") });
    const fallback = canon(root, "overview").out.split("\n");
    expect(fallback.slice(1, 5)).toEqual([`${R(2)}  planned  版本2`, "(没有 active 的版本，取编号最小的 planned；正在做的版本把 status 改成 active)", "规则 0 条：规划中 0  已通过 0  待 main 测试 0  待重新执行 0", "成功标准 0 条：已满足 0  未满足 0  待负责人 0  未证明 0"]);
    write(root, Object.fromEntries([2, 3, 10].map((n) => [`canon/releases/${R(n)}.md`, release(n, "shipped", "内容", `shipped_at: ${"b".repeat(40)}\n`)])));
    const none = canon(root, "overview");
    expect(none.code).toBe(0);
    expect(none.out.split("\n").slice(0, 5)).toEqual(["## 当前版本", "(no release in progress)", NO_QUALITY, "", "## 议程"]);
    expect(none.out).toContain("## 历史");
  });

  test("BR-2505: with nothing on the agenda, nothing in flight and no landing each section says so", () => {
    const r = canon(project(), "overview");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["## 当前版本", "(no release in progress)", NO_QUALITY, "", "## 议程", "(nothing)", "", "## 正在做和在等", "(none)", "", "## 历史", HISTORY]);
  });

  test("BR-2505: changes in progress or waiting are listed with their state or what they wait for; ready ones are not", () => {
    const root = project();
    write(root, {
      [`canon/changes/${C(6)}.md`]: change(6, "open"),
      [`canon/changes/${C(7)}.md`]: change(7, "open", "", `depends_on: [${C(6)}]\n`),
    });
    const started = startNew(root, "做点事");
    const out = canon(root, "overview").out.split("\n");
    const at = out.indexOf("## 正在做和在等");
    expect(out.slice(at + 1, out.indexOf("## 历史") - 1)).toEqual([`${C(7)} 变更7  waiting-deps: ${C(6)}`, `${started.change} 做点事  in-progress`]);
    const json = JSON.parse(canon(root, "overview", "--json").out);
    expect(json.changes.map((c: { id: string; state: string }) => [c.id, c.state])).toEqual([[C(7), "waiting-deps"], [started.change, "in-progress"]]);
  });

  test("BR-2505: --json holds the same content", () => {
    const o = JSON.parse(canon(fixture(), "overview", "--json").out);
    expect(o.releases).toHaveLength(1);
    expect(o.releases[0]).toMatchObject({ id: R(3), status: "active", fallback: false, rules: { planned: 1, passed: 0 }, merged: { ids: [] } });
    expect(o.releases[0].criteria).toEqual([
      { doc: R(3), id: "S1", text: "规则全过。", state: "met" },
      { doc: R(3), id: "S2", text: "负责人玩通。", state: "owner" },
      { doc: R(3), id: "S3", text: "没人解释也能玩。", state: "unproven" },
    ]);
    expect(o.plans).toBeUndefined();
    expect(o.agenda.owner.map((i: { key: string }) => i.key)).toEqual(["finding:1", "question:1", `criterion:${R(3)}/S2`]);
    expect(o.agenda.judge.map((i: { key: string }) => i.key)).toEqual(["finding:2"]);
    expect(o.changes).toEqual([]);
    expect(o.landed).toEqual([{ id: C(9), title: "变更9", at: "2026-11-16T07:42:40.496Z" }, { id: C(12), title: "轻变更12", at: "2026-11-16T06:00:00.000Z" }, { id: C(4), title: "变更4", at: "2026-11-16T05:32:56.142Z" }]);
    expect(JSON.parse(canon(project(), "overview", "--json").out).releases).toEqual([]);
  });

  test("BR-2505: --history gives the landings with what they advanced", () => {
    const r = canon(fixture(), "overview", "--history");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      "## 最近 7 天的目标改动",
      "(none)",
      "",
      "## 最近合入",
      `${C(9)} 变更9 2026-11-16 07:42 UTC  （没写 advances）`,
      `${C(12)} 轻变更12 2026-11-16 06:00 UTC  （没写 advances）`,
      `${C(4)} 变更4 2026-11-16 05:32 UTC  （没写 advances）`,
    ]);
    expect(JSON.parse(canon(fixture(), "overview", "--history", "--json").out).landed[0]).toEqual({ id: C(9), title: "变更9", at: "2026-11-16T07:42:40.496Z", advances: null });
  });
});

describe("canon brief: the overall progress summary", () => {
  test("BR-2506: where no change is claimed, the release with its criteria counts and no plan, owner or stall line; those are the agenda's", () => {
    const lines = canon(fixture(), "brief").out.split("\n");
    const at = lines.indexOf("Overall progress (canon overview):");
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual([`  ${R(3)}  active  版本3  成功标准 3 条：已满足 1  未满足 0  待负责人 1  未证明 1`, `  quality: ${lines[at + 2]!.slice("  quality: ".length)}`]);
    expect(lines.join("\n")).not.toContain("plans not done");
    expect(lines.join("\n")).not.toContain("waiting for the owner:");
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith("Open changes in the owner's order")));
  });

  test("BR-2506: a fallback release is marked; a claimed worktree prints no summary", () => {
    const root = project();
    write(root, { [`canon/releases/${R(2)}.md`]: release(2, "planned") });
    const lines = canon(root, "brief").out.split("\n");
    const at = lines.indexOf("Overall progress (canon overview):");
    expect(lines[at + 1]).toBe(`  ${R(2)}  planned  版本2  成功标准 0 条：已满足 0  未满足 0  待负责人 0  未证明 0  (no release is active: the lowest planned one)`);
    const started = startNew(root, "做点事");
    expect(canon(started.worktree, "brief").out).not.toContain("Overall progress");
  });

  test("BR-2506: with nothing at all there is no summary, also with a question waiting (the agenda has it)", () => {
    const root = project();
    // reason: quality standards all accounted for (BR-2558 case 3), so only this rule's own parts could print a summary
    write(root, { "canon/quality/README.md": "# 质量\n\n## 方面\n\n- **联机**：不适用：canon human #3\n" });
    expect(canon(root, "brief").out).not.toContain("Overall progress");
    ask(ws(root).db, "agent:a", null, "要不要发布？", ["是", "否"]);
    const out = canon(root, "brief").out;
    expect(out).not.toContain("Overall progress");
    expect(out).toContain("  owner: 1: question:1");
  });
});

describe("recent changes to the goal", () => {
  const commitAt = (root: string, files: Record<string, string>, message: string, daysAgo: number) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    sh(root, "add", "-A");
    const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const r = Bun.spawnSync(["git", "commit", "-qm", message], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };

  test("BR-2505 BR-2506: a commit of the last 7 days that changed a criterion is counted in the outline, given in full by --history and named in the brief; an older one is not", () => {
    const root = project();
    commitAt(root, { [`canon/releases/${R(3)}.md`]: release(3, "active", "- S1 甲") }, "add release", 20);
    commitAt(root, { [`canon/releases/${R(3)}.md`]: release(3, "active", "- S1 甲\n- S2 乙") }, "old goal change", 8);
    expect(canon(root, "overview").out).not.toContain("最近 7 天的目标改动");
    commitAt(root, { [`canon/releases/${R(3)}.md`]: release(3, "active", "- S1 甲\n- S2 乙\n- S3 支持手柄。") }, "加手柄", 3);
    expect(canon(root, "overview").out).toContain(`最近 7 天的目标改动：${R(3)} 1 处\n`);
    const lines = canon(root, "overview", "--history").out.split("\n");
    expect(lines.slice(0, 3)).toEqual(["## 最近 7 天的目标改动", expect.stringMatching(/^[0-9a-f]{9} 加手柄$/), `  ${R(3)}: success criterion added or reworded: 支持手柄。`]);
    const sha = sh(root, "rev-parse", "--short=9", "HEAD").trim();
    expect(canon(root, "brief").out).toContain(`  goal changed in the last 7 days: ${sha} (canon overview --history)`);
    expect(JSON.parse(canon(root, "overview", "--json").out).goal_changes).toEqual([{ doc: R(3), count: 1 }]);
  });
});

describe("releases made of features", () => {
  const F = (n: number) => id("F", n);
  const feature = (n: number, status: string, criteria: string) => `---\nid: ${F(n)}\ntitle: 模块${n}\nstatus: ${status}\n---\n\n## 目标\n\n内容\n\n## 范围\n\n内容\n\n## 不做\n\n内容\n\n## 成功标准\n\n${criteria}\n`;
  const advancing = (n: number, status: string, advances: string) => `---\nid: ${C(n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\nadvances: ${advances}\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`;

  test("BR-2505 BR-2506: every active release with its features' criteria by their first sentence, dropped features left out; the brief counts a release with its features", () => {
    const root = project();
    write(root, {
      [`canon/releases/${R(3)}.md`]: release(3, "active", "- S1 负责人玩通。还要录屏。（待负责人）").replace("status: active\n", `status: active\nfeatures: [${F(1)}, ${F(2)}]\n`),
      [`canon/releases/${R(5)}.md`]: release(5, "active", "- S1 甲"),
      [`canon/features/${F(1)}.md`]: feature(1, "active", "- S1 五个分支各有构筑通关。（未满足）\n- S2 有引导。"),
      [`canon/features/${F(2)}.md`]: feature(2, "dropped", "- S1 不做了"),
      [`canon/changes/${C(7)}.md`]: advancing(7, "done", `[${F(1)}/S1]`),
      [`canon/changes/${C(11)}.md`]: advancing(11, "done", '"none: 修 YAML"'),
    });
    const land = ws(root).db.db.query("INSERT INTO events(ts, actor, kind, subject, detail) VALUES (?, 'agent:a', 'land.ok', ?, '{}')");
    land.run("2026-11-16T05:00:00.000Z", C(7));
    land.run("2026-11-16T06:00:00.000Z", C(11));
    const lines = canon(root, "overview").out.split("\n");
    expect(lines.slice(1, lines.indexOf("## 议程") - 2)).toEqual([
      `${R(3)}  active  版本3`,
      "规则 0 条：规划中 0  已通过 0  待 main 测试 0  待重新执行 0",
      "成功标准 3 条：已满足 0  未满足 1  待负责人 1  未证明 1",
      `  [待负责人] ${R(3)}/S1 负责人玩通。`,
      `  [未满足] ${F(1)}/S1 五个分支各有构筑通关。`,
      `  [未证明] ${F(1)}/S2 有引导。`,
      `${R(5)}  active  版本5`,
      "规则 0 条：规划中 0  已通过 0  待 main 测试 0  待重新执行 0",
      "成功标准 1 条：已满足 0  未满足 0  待负责人 0  未证明 1",
      `  [未证明] ${R(5)}/S1 甲`,
    ]);
    expect(lines).toContain(`owner: 1: criterion:${R(3)}/S1`);
    const history = canon(root, "overview", "--history").out.split("\n").map(squash);
    expect(history).toContain(`${C(11)} 变更11 2026-11-16 06:00 UTC （不推进：修 YAML）`);
    expect(history).toContain(`${C(7)} 变更7 2026-11-16 05:00 UTC → ${F(1)}/S1`);
    const brief = canon(root, "brief").out.split("\n");
    const at = brief.indexOf("Overall progress (canon overview):");
    expect(brief.slice(at + 1, at + 3)).toEqual([`  ${R(3)}  active  版本3  成功标准 3 条：已满足 0  未满足 1  待负责人 1  未证明 1`, `  ${R(5)}  active  版本5  成功标准 1 条：已满足 0  未满足 0  待负责人 0  未证明 1`]);
  });
});
