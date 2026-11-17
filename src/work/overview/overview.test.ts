import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../humans/questions.ts";
import { project, sh, startNew, ws } from "../testkit.ts";

// reason: each case spawns the CLI, which under load can take seconds per run (as in brief.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const C = (n: number) => id("C", n);
const BR = (n: number) => id("BR", n);

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
}

const release = (n: number, status: string, criteria = "内容", extra = "") =>
  `---\nid: ${R(n)}\ntitle: 版本${n}\nstatus: ${status}\n${extra}---\n\n## 目标\n\n内容\n\n## 成功标准\n\n${criteria}\n\n## 故事地图切片\n\n内容\n`;
const change = (n: number, status: string, body = "", front = "") => `---\nid: ${C(n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n${body}`;
const PLAN = "## 计划\n\n| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | 建表 | - |\n| 2 | 接口 | 1 |\n";
const CRITERIA = `- 规则全过。（已满足：${C(4)}）\n- 负责人玩通。（待负责人）\n- 没人解释也能玩。`;

/**
 * R-1 shipped, R-2 planned, R-3 active with three criteria (met by C-4, owner, unmarked) and one planned rule; C-4 done;
 * C-5 open with a two-step plan; C-6..C-11 open. Landings: C-4, then a chore, then C-9. One pending question, a tier C
 * and a tier A finding.
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
  });
  const db = ws(root).db.db;
  const land = db.query("INSERT INTO events(ts, actor, kind, subject, detail) VALUES (?, 'agent:a', 'land.ok', ?, '{}')");
  land.run("2026-11-16T05:32:56.142Z", C(4));
  land.run("2026-11-16T06:00:00.000Z", "chore-0f0f0f0f-0000-4000-8000-000000000000");
  land.run("2026-11-16T07:42:40.496Z", C(9));
  ask(ws(root).db, "agent:a", null, "要不要发布？\n第二行", ["是", "否"]);
  const finding = db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, event, opened_at, tier) VALUES (?, 'contradiction', ?, ?, ?, 1, '2026-11-16T00:00:00Z', ?)");
  finding.run("c", JSON.stringify([BR(6)]), JSON.stringify([BR(6)]), "矛盾\n细节", "C");
  finding.run("a", JSON.stringify([BR(6)]), JSON.stringify([BR(6)]), "小问题", "A");
  return root;
}

const squash = (s: string) => s.replace(/ {2,}/g, " ");

describe("canon overview", () => {
  test("BR-2505: five sections in order, from the current release and its criteria down to recent landings; BR-2504: each criterion by its marker", () => {
    const r = canon(fixture(), "overview");
    expect(r.code).toBe(0);
    expect(squash(r.out).trim().split("\n")).toEqual([
      "## 当前版本",
      `${R(3)} active 版本3 规划中 1 已通过 0 待 main 测试 0 待重新执行 0`,
      "成功标准 3 条：已满足 1 未满足 0 待负责人 1 未证明 1",
      ` [已满足] 规则全过。 证据：${C(4)}`,
      " [待负责人] 负责人玩通。",
      " [未证明] 没人解释也能玩。",
      "",
      "## 计划",
      `${C(5)} 变更5 已完成 0/2 (0%) 进行中 0 可开始 1 被挡住 1`,
      "",
      "## 等负责人",
      "问题 #1 要不要发布？",
      `意见 #1 ${BR(6)}: 矛盾`,
      `成功标准 ${R(3)}: 负责人玩通。`,
      "",
      "## 待办顺序",
      ...[5, 6, 7, 8, 9].map((n) => `${C(n)} 变更${n}`),
      "… 还有 2 个（canon change list）",
      "",
      "## 最近合入",
      `${C(9)} 变更9 2026-11-16 07:42 UTC`,
      `${C(4)} 变更4 2026-11-16 05:32 UTC`,
    ]);
  });

  test("BR-2505: with no active release the lowest planned one stands in with a hint; with none at all the section says so and the rest still comes", () => {
    const root = fixture();
    write(root, { [`canon/releases/${R(3)}.md`]: release(3, "planned", CRITERIA), [`canon/releases/${R(10)}.md`]: release(10, "planned") });
    const fallback = canon(root, "overview").out.split("\n");
    expect(squash(fallback[1]!)).toStartWith(`${R(2)} planned 版本2 `);
    expect(fallback[2]).toBe("(没有 active 的版本，取编号最小的 planned；正在做的版本把 status 改成 active)");
    expect(fallback[3]).toBe("成功标准 0 条：已满足 0  未满足 0  待负责人 0  未证明 0");
    write(root, Object.fromEntries([2, 3, 10].map((n) => [`canon/releases/${R(n)}.md`, release(n, "shipped", "内容", `shipped_at: ${"b".repeat(40)}\n`)])));
    const none = canon(root, "overview");
    expect(none.code).toBe(0);
    expect(none.out.split("\n").slice(0, 4)).toEqual(["## 当前版本", "(no release in progress)", "", "## 计划"]);
    expect(none.out).toContain("## 最近合入");
  });

  test("BR-2505: with no plans, nothing waiting, no open change and no landing each section says so", () => {
    const root = project();
    const r = canon(root, "overview");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["## 当前版本", "(no release in progress)", "", "## 计划", "(no plans)", "", "## 等负责人", "(nothing)", "", "## 待办顺序", "(none)", "", "## 最近合入", "(none)"]);
  });

  test("BR-2505: a claimed change carries its mark in the order", () => {
    const root = project();
    const started = startNew(root, "做点事");
    const line = canon(root, "overview").out.split("\n").find((l) => l.startsWith(started.change));
    expect(line).toContain("claimed");
  });

  test("BR-2505: --json holds the same content", () => {
    const o = JSON.parse(canon(fixture(), "overview", "--json").out);
    expect(o.release).toMatchObject({ id: R(3), status: "active", counts: { planned: 1, passed: 0 } });
    expect(o.release.criteria).toEqual([
      { text: "规则全过。", state: "met", evidence: [C(4)] },
      { text: "负责人玩通。", state: "owner", evidence: [] },
      { text: "没人解释也能玩。", state: "unproven", evidence: [] },
    ]);
    expect(o.plans).toEqual([{ id: C(5), title: "变更5", total: 2, done: 0, percent: 0 }]);
    expect(o.waiting.questions.map((q: { id: number }) => q.id)).toEqual([1]);
    expect(o.waiting.findings.map((f: { id: number }) => f.id)).toEqual([1]);
    expect(o.waiting.criteria).toEqual([{ release: R(3), text: "负责人玩通。" }]);
    expect(o.backlog.map((b: { id: string }) => b.id)).toEqual([5, 6, 7, 8, 9].map(C));
    expect(o.backlog_more).toBe(2);
    expect(o.landed).toEqual([{ id: C(9), title: "变更9", at: "2026-11-16T07:42:40.496Z" }, { id: C(4), title: "变更4", at: "2026-11-16T05:32:56.142Z" }]);
    expect(JSON.parse(canon(project(), "overview", "--json").out).release).toBeNull();
  });
});

describe("canon brief: the overall progress summary", () => {
  test("BR-2506: where no change is claimed, the release without rule counts, its criteria counts, plans not done and what waits for the owner", () => {
    const lines = canon(fixture(), "brief").out.split("\n");
    const at = lines.indexOf("Overall progress (canon overview):");
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 5)).toEqual([
      `  ${R(3)}  active  版本3`,
      "  成功标准 3 条：已满足 1  未满足 0  待负责人 1  未证明 1",
      `  plans not done: ${C(5)} 0/2 (0%)`,
      "  waiting for the owner: 1 question(s), 1 tier-C finding(s), 1 criterion(s)",
    ]);
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith("Open changes in the owner's order")));
  });

  test("BR-2506: a fallback release is marked; a finished plan and nothing waiting add no line; a claimed worktree prints no summary", () => {
    const root = project();
    write(root, { [`canon/releases/${R(2)}.md`]: release(2, "planned"), [`canon/changes/${C(4)}.md`]: change(4, "done", PLAN.replace("| 2 | 接口 | 1 |\n", "")), [`canon/changes/${C(5)}.md`]: change(5, "done", "", `plan: ${C(4)}\nsteps: [1]\n`) });
    const lines = canon(root, "brief").out.split("\n");
    const at = lines.indexOf("Overall progress (canon overview):");
    expect(lines.slice(at + 1, at + 4)).toEqual([`  ${R(2)}  planned  版本2  (no release is active: the lowest planned one)`, "  成功标准 0 条：已满足 0  未满足 0  待负责人 0  未证明 0", expect.not.stringMatching(/^ {2}(plans|waiting)/)]);
    const started = startNew(root, "做点事");
    expect(canon(started.worktree, "brief").out).not.toContain("Overall progress");
  });

  test("BR-2506: with nothing at all there is no summary; with no release but a question waiting, the release line says so", () => {
    const root = project();
    expect(canon(root, "brief").out).not.toContain("Overall progress");
    ask(ws(root).db, "agent:a", null, "要不要发布？", ["是", "否"]);
    const lines = canon(root, "brief").out.split("\n");
    const at = lines.indexOf("Overall progress (canon overview):");
    expect(lines.slice(at + 1, at + 3)).toEqual(["  no release in progress", "  waiting for the owner: 1 question(s), 0 tier-C finding(s), 0 criterion(s)"]);
  });
});
