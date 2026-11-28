import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { land } from "../../work/land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";
import { relatedTitles } from "./duplicates.ts";

// reason: each case spawns canon or makes worktrees; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(90_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const cli = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const STATED = ["--owner-gate", "none: test", "--advances", "none: test"];
const newId = (out: string) => out.match(/canon\/changes\/(C-\d+)/)?.[1] ?? out.match(/(C-\d+) →/)![1]!;

// Fixture ids are assembled at runtime, so this file's own text names no rule.
const br = (n: number) => ["BR", n].join("-");

const BODY = (extra = "") => `\n## 为什么\n\nx\n\n## 要改什么\n\nx${extra}\n\n## 教训\n\n无。\n`;
const change = (n: number, title: string, status = "open", meta = "", body = "") => `---\nid: C-${n}\ntitle: ${title}\nstatus: ${status}\nrules: []\n${meta}---\n${BODY(body)}`;

/** Closed changes with unrelated titles, so word weights are measured over a corpus like a real project's (D-171). */
const FILLER = ["合入后的代码评审按积压攒批", "移除旧的安装脚本", "更新装进项目的文件", "修复主分支上没通过的检查", "派发给子会话的名额", "按负载等待重活", "评审意见的定档和关闭", "版本发布前的评审", "会话开始时输出工作说明", "交接原因写进状态"];
const filler = (): Record<string, string> => Object.fromEntries(FILLER.map((t, i) => [`canon/changes/C-${100 + i}.md`, change(100 + i, t, "done")]));

function repo(files: Record<string, string>): string {
  const root = project();
  files = { ...filler(), ...files };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

type Ev = { subject: string; detail: Record<string, unknown> };
const events = (root: string, kind: string): Ev[] =>
  ws(root).db.db.query<{ subject: string; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => ({ subject: r.subject, detail: JSON.parse(r.detail) as Record<string, unknown> }));
const possible = (out: string) => out.split("\n").filter((l) => l.startsWith("possible duplicate: "));

const SIMILAR = "声明字段的格式：fields 声明、canon check 校验格式、canon doc set 改值";
const NEW_SIMILAR = "文档类型声明字段的格式和表态的步骤：新建命令当场要求、canon doc set 改值";

describe("BR-2656: a new change's title is compared with the unfinished changes", () => {
  test("BR-2656: canon change new lists a related open change, not a done or an unrelated one, and records duplicate.remind", () => {
    const root = repo({
      "canon/changes/C-1.md": change(1, SIMILAR),
      "canon/changes/C-2.md": change(2, "合入后的代码评审按积压攒批"),
      "canon/changes/C-3.md": change(3, "新建命令当场要求表态的步骤", "done"),
      "canon/changes/C-4.md": change(4, "移除 canon 项目里的旧 skill"),
    });
    const r = cli(root, "change", "new", ...STATED, "--title", NEW_SIMILAR);
    expect(r.code).toBe(0);
    const id = newId(r.out);
    const lines = possible(r.out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^possible duplicate: C-1 声明字段的格式.* \(relatedness 0\.\d\d; shared: .*\)$/);
    expect(r.out).toContain(`canon change duplicate ${id} C-1 --same`);
    const ev = events(root, "duplicate.remind");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ subject: id, detail: { stage: "new", with: "C-1" } });
    expect(Number(ev[0]!.detail["score"])).toBeGreaterThanOrEqual(0.4);
  });

  test("BR-2656: only unrelated or sibling-step titles: nothing printed, no event", () => {
    const root = repo({
      "canon/changes/C-1.md": change(1, "C-618 的 C 步：教训"),
      "canon/changes/C-2.md": change(2, "合入后的代码评审按积压攒批"),
    });
    const r = cli(root, "change", "new", ...STATED, "--title", "C-626 的 D 步：重复提醒");
    expect(r.code).toBe(0);
    expect(possible(r.out)).toEqual([]);
    expect(r.out).not.toContain("canon change duplicate");
    expect(events(root, "duplicate.remind")).toEqual([]);
  });

  test("BR-2656: at most 3 are listed, highest first", () => {
    const titles = ["导出报表为表格文件", "导出报表为表格文件并压缩", "导出报表为表格文件给负责人", "导出报表为表格", "导出报表"];
    const files: Record<string, string> = {};
    titles.forEach((t, i) => (files[`canon/changes/C-${i + 1}.md`] = change(i + 1, t)));
    files["canon/changes/C-9.md"] = change(9, "合入后的代码评审按积压攒批", "done");
    const root = repo(files);
    const r = cli(root, "change", "new", ...STATED, "--title", "导出报表为表格文件");
    expect(r.code).toBe(0);
    const lines = possible(r.out);
    expect(lines).toHaveLength(3);
    const scores = lines.map((l) => Number(/relatedness (\d\.\d\d)/.exec(l)![1]));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(events(root, "duplicate.remind")).toHaveLength(3);
  });

  test("BR-2656: relatedness 0.40 is listed, 0.36 is not", () => {
    // every token is in exactly two titles, so all weights are equal and the score is the plain share of shared tokens
    const at40 = relatedTitles("aa bb cc dd ee", [{ id: "C-2", title: "aa bb xx yy zz" }], ["aa bb cc dd ee", "aa bb xx yy zz", "cc dd ee", "xx yy zz"]);
    expect(at40.map((m) => [m.id, m.score])).toEqual([["C-2", 0.4]]);
    const below = relatedTitles("aa bb cc dd ee", [{ id: "C-3", title: "aa bb xx yy zz ww" }], ["aa bb cc dd ee", "aa bb xx yy zz ww", "cc dd ee", "xx yy zz ww"]);
    expect(below).toEqual([]);
  });

  test("BR-2656: canon work start --title reminds too; a refused start compares nothing", () => {
    const root = repo({ "canon/changes/C-1.md": change(1, SIMILAR) });
    const refused = cli(root, "work", "start", ...STATED, "--title", NEW_SIMILAR, "--release", "R-9");
    expect(refused.code).toBe(3);
    expect(possible(refused.out)).toEqual([]);
    expect(events(root, "duplicate.remind")).toEqual([]);
    const r = cli(root, "work", "start", ...STATED, "--title", NEW_SIMILAR);
    expect(r.code).toBe(0);
    expect(possible(r.out).map((l) => l.split(" ")[2])).toEqual(["C-1"]);
    expect(events(root, "duplicate.remind")).toMatchObject([{ subject: newId(r.out), detail: { stage: "new", with: "C-1" } }]);
  });
});

describe("BR-2658: canon change duplicate records the session's answer", () => {
  test("BR-2658 BR-2571: same or not, in either order, latest counts; overlap holds on both sides until answered", () => {
    const root = repo({ "canon/changes/C-1.md": change(1, SIMILAR), "canon/changes/C-2.md": change(2, "合入后的代码评审按积压攒批") });
    const id = newId(cli(root, "change", "new", ...STATED, "--title", NEW_SIMILAR).out);
    const flags = () => Object.fromEntries((JSON.parse(cli(root, "change", "list", "--json").out) as { id: string; flags: { overlap: boolean } }[]).map((r) => [r.id, r.flags.overlap]));
    expect(flags()).toMatchObject({ [id]: true, "C-1": true, "C-2": false });
    const same = cli(root, "change", "duplicate", id, "C-1", "--same");
    expect(same.code).toBe(0);
    expect(same.out).toContain(`${id} and C-1: recorded "same work"`);
    expect(flags()).toMatchObject({ [id]: false, "C-1": false });
    const not = cli(root, "change", "duplicate", "C-1", id, "--not", "C-1 只改输出格式");
    expect(not.code).toBe(0);
    expect(not.out).toContain(`C-1 and ${id}: recorded "not the same work: C-1 只改输出格式"`);
    expect(events(root, "duplicate.answer").map((e) => [e.subject, e.detail["with"], e.detail["same"], e.detail["reason"]])).toEqual([[id, "C-1", true, null], ["C-1", id, false, "C-1 只改输出格式"]]);
  });

  test("BR-2658 BR-2571: an unanswered pair whose other side is dropped no longer sets overlap", () => {
    const root = repo({ "canon/changes/C-1.md": change(1, SIMILAR) });
    const id = newId(cli(root, "change", "new", ...STATED, "--title", NEW_SIMILAR).out);
    expect(cli(root, "change", "drop", "C-1").code).toBe(0);
    const rows = JSON.parse(cli(root, "change", "list", "--json").out) as { id: string; flags: { overlap: boolean } }[];
    expect(rows.find((r) => r.id === id)!.flags.overlap).toBe(false);
  });

  test("BR-2658: usage errors exit 2, a pair never reminded exits 3; no event either way", () => {
    const root = repo({ "canon/changes/C-1.md": change(1, SIMILAR), "canon/changes/C-9.md": change(9, "别的事") });
    const id = newId(cli(root, "change", "new", ...STATED, "--title", NEW_SIMILAR).out);
    for (const [args, code] of [
      [[id, "C-1"], 2],
      [[id, "C-1", "--same", "--not", "x"], 2],
      [[id, "C-1", "--not", "  "], 2],
      [[id], 2],
      [[id, id, "--same"], 2],
      [[id, "C-9", "--same"], 3],
    ] as const) {
      const r = cli(root, "change", "duplicate", ...args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), code]);
    }
    expect(events(root, "duplicate.answer")).toEqual([]);
  });
});

const ruleText = (n: number) => `---\nid: ${br(n)}\ntitle: Rule ${n}\nuntested: fixture\nbusiness: x\n---\n## 规则\n\nStatement ${n}.\n\n## 例子\n\n- input ${n} → output ${n}\n`;
const DOMAIN = { "src/billing/a.ts": "export {};\n", "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n" };

function commit(wt: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), text);
  }
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", "work");
}

function setRules(wt: string, id: string, rules: string[]) {
  const dir = join(wt, "canon/changes");
  const file = join(dir, readdirSync(dir).find((f) => f === `${id}.md` || f.startsWith(`${id}-`))!);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^rules:.*$/m, `rules: [${rules.join(", ")}]`));
}

describe("BR-2657: a landing change is compared with what unfinished changes wrote down", () => {
  test("BR-2657: a rule file it changes that another open change lists: reminded, one event across two landings, the landing goes on", async () => {
    const root = repo({ ...DOMAIN, [`canon/rules/billing/${br(7)}.md`]: ruleText(7), "canon/changes/C-50.md": change(50, "退款规则", "open").replace("rules: []", `rules: [${br(7)}]`), "canon/changes/C-51.md": change(51, "退款完成", "done").replace("rules: []", `rules: [${br(7)}]`) });
    const s = startNew(root, "Edit rule");
    commit(s.worktree, { [`canon/rules/billing/${br(7)}.md`]: ruleText(7).replace("Statement 7.", "Statement seven.") });
    const said: string[] = [];
    // a dirty worktree is refused before the comparison: nothing printed, no event (BR-2062's refusals before the queue)
    writeFileSync(join(s.worktree, "scratch.txt"), "x");
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("refused");
    expect(possible(said.join("\n"))).toEqual([]);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "scratch");
    commit(root, { "FAIL": "x" });
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("refused");
    sh(root, "rm", "-q", "FAIL");
    sh(root, "commit", "-qm", "unfail");
    const out = await land(ws(s.worktree), FAST, (l) => said.push(l));
    expect([out.kind, "message" in out ? `${out.message} ${JSON.stringify(out.findings ?? [])}` : ""]).toEqual(["landed", ""]);
    const lines = possible(said.join("\n"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`possible duplicate: C-50 退款规则 (shared rules: ${br(7)})`);
    expect(said.join("\n")).toContain(`canon change duplicate ${s.change} C-50 --same`);
    expect(events(root, "duplicate.remind")).toMatchObject([{ subject: s.change, detail: { stage: "land", with: "C-50", rules: [br(7)] } }]);
  });

  test("BR-2657: a path written in backticks matches files under it; a mere name prefix, a shared feature alone and an answered pair do not", async () => {
    const root = repo({
      "canon/changes/C-50.md": change(50, "改合入", "open", "", "：改 `src/work/land/` 里的排队"),
      "canon/changes/C-52.md": change(52, "改合入二", "open", "", "：改 `src/work/land` 的说明"),
      "canon/changes/C-53.md": change(53, "改别处", "open", "", "：只改 `src/other/x.ts`"),
      "canon/changes/C-54.md": change(54, "已答过", "open", "", "：也改 `src/work/land/land.ts`"),
    });
    const s = startNew(root, "Land change");
    commit(s.worktree, { "src/work/land/land.ts": "x\n", "src/work/landing.ts": "y\n" });
    ws(root).db.event("agent:a", "duplicate.remind", s.change, { stage: "new", with: "C-54" });
    ws(root).db.event("agent:a", "duplicate.answer", "C-54", { with: s.change, same: false, reason: "different" });
    const said: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("landed");
    const lines = possible(said.join("\n"));
    expect(lines.sort()).toEqual(["possible duplicate: C-50 改合入 (shared paths: src/work/land/land.ts)", "possible duplicate: C-52 改合入二 (shared paths: src/work/land/land.ts)"]);
  });

  test("BR-2657: same feature alone does not remind; with a shared path the feature is shown", async () => {
    const root = repo({
      "canon/features/F-2.md": "---\nid: F-2\ntitle: Feature 2\nstatus: active\n---\n\n## 目标\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\nx\n",
      "canon/changes/C-50.md": change(50, "同模块", "open", "feature: F-2\n"),
      "canon/changes/C-53.md": change(53, "同模块且同路径", "open", "feature: F-2\n", "：改 `src/app.ts`"),
    });
    const s = startNew(root, "Feature work");
    const file = join(s.worktree, "canon/changes", readdirSync(join(s.worktree, "canon/changes")).find((f) => f.startsWith(s.change))!);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^rules:/m, "feature: F-2\nrules:"));
    commit(s.worktree, { "src/app.ts": "changed\n" });
    const said: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("landed");
    expect(possible(said.join("\n"))).toEqual(["possible duplicate: C-53 同模块且同路径 (shared paths: src/app.ts; same feature F-2)"]);
  });

  test("BR-2657: rules the landing change lists in its front matter count too", async () => {
    const root = repo({ ...DOMAIN, [`canon/rules/billing/${br(7)}.md`]: ruleText(7), "canon/changes/C-50.md": change(50, "退款规则").replace("rules: []", `rules: [${br(7)}]`) });
    const s = startNew(root, "Lists the rule");
    setRules(s.worktree, s.change, [br(7)]);
    commit(s.worktree, { "app.txt": "changed\n" });
    const said: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("landed");
    expect(possible(said.join("\n"))).toEqual([`possible duplicate: C-50 退款规则 (shared rules: ${br(7)})`]);
  });
});

void quiet;
