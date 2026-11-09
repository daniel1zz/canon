import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, quiet, sh, ws } from "../../work/testkit.ts";
import { start } from "../../work/session/session.ts";
import { planLink } from "../documents/planlink.ts";
import { readPlan } from "./parse.ts";
import type { PlanRead } from "./parse.ts";

// reason: each CLI case spawns canon several times; a loaded machine took longer than bun's 5 s default (as in the release tests)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const table = (...rows: string[]) => `| 步骤 | 内容 | 依赖 |\n|---|---|---|\n${rows.join("\n")}\n`;
const planBody = (t: string) => `## 为什么\n\nx\n\n## 计划\n\n${t}\n## 任务\n\n- [x] x\n`;
const stepsOf = (r: PlanRead) => (r.kind === "plan" ? r.steps.map((s) => [s.name, s.content, [...s.dependsOn]]) : r);
const problemOf = (body: string): string => {
  const r = readPlan(planBody(body));
  if (r.kind !== "invalid") throw new Error(`expected an invalid plan, got ${JSON.stringify(r)}`);
  return r.problem;
};

function changeFile(n: number, status: string, opts: { title?: string; link?: string; plan?: string; rules?: string } = {}): [string, string] {
  const body = opts.plan === undefined ? "" : `## 计划\n\n${opts.plan}\n`;
  return [`canon/changes/C-${n}.md`, `---\nid: C-${n}\ntitle: ${opts.title ?? `change ${n}`}\nstatus: ${status}\nrules: [${opts.rules ?? ""}]\n${opts.link ?? ""}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n${body}## 任务\n\n- [x] x\n`];
}

function write(root: string, files: [string, string][]) {
  for (const [p, text] of files) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** A repository with `files` committed. */
function repo(files: [string, string][]): string {
  const root = project();
  write(root, files);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

const FOUR = table("| 1 | 建表 | - |", "| 2 | 接口 | 1 |", "| 3 | 界面 | 1 |", "| 4 | 联调 | 2, 3 |");
const linked = (plan: string, ...steps: string[]) => `plan: ${plan}\nsteps: [${steps.join(", ")}]\n`;

describe("the plan table", () => {
  test("BR-2369: a table with 步骤, 内容 and 依赖 columns is the plan, each row a step with its dependencies", () => {
    expect(stepsOf(readPlan(planBody(table("| 1 | 建表 | - |", "| 2 | 接口 | 1 |"))))).toEqual([["1", "建表", []], ["2", "接口", ["1"]]]);
  });

  test("BR-2369: columns may come in any order, other columns are not read", () => {
    const t = "| 依赖 | 步骤 | 负责 | 内容 |\n|:--|:-:|---|---|\n| 1, 2 | 3 | 小王 | 联调 |\n| - | 1 | 小李 | 一 |\n| - | 2 | 小张 | 二 |\n";
    expect(stepsOf(readPlan(planBody(t)))).toEqual([["3", "联调", ["1", "2"]], ["1", "一", []], ["2", "二", []]]);
  });

  test("BR-2369: dependencies are separated by , ，or 、; 无, - and an empty cell mean none; names like 2a, 3.1 and db-1 are steps", () => {
    const r = readPlan(planBody(table("| 2a | a | 无 |", "| 3.1 | b | |", "| db-1 | c | - |", "| 9 | d | 2a、3.1 |", "| 10 | e | 2a，db-1 |", "| 11 | f | 2a,db-1 |")));
    expect(stepsOf(r)).toEqual([["2a", "a", []], ["3.1", "b", []], ["db-1", "c", []], ["9", "d", ["2a", "3.1"]], ["10", "e", ["2a", "db-1"]], ["11", "f", ["2a", "db-1"]]]);
  });

  test("BR-2369: a section heading inside a code fence, or a table under another heading, is no plan; a body without the section has none", () => {
    const fenced = `## 为什么\n\n\`\`\`\n## 计划\n\n${FOUR}\`\`\`\n`;
    expect(readPlan(fenced).kind).toBe("none");
    expect(readPlan(`## 计划\n\n\`\`\`\n${FOUR}\`\`\`\n`).kind).toBe("invalid"); // the section is there, its table is only an example (BR-2370)
    expect(readPlan(`## 总实施顺序\n\n${FOUR}`).kind).toBe("none");
    expect(readPlan("## 为什么\n\nx\n").kind).toBe("none");
  });
});

describe("a plan that breaks the format", () => {
  test("BR-2370: no table, two tables, a missing or doubled column, a bad separator, no rows, a short row", () => {
    expect(problemOf("只有说明。\n")).toContain("no table");
    expect(problemOf(`${FOUR}\n文字\n\n${FOUR}`)).toContain("2 tables");
    expect(problemOf("| 步骤 | 内容 |\n|---|---|\n| 1 | 建表 |\n")).toContain("no 依赖 column");
    expect(problemOf("| 步骤 | 内容 | 依赖 | 依赖 |\n|---|---|---|---|\n| 1 | x | - | - |\n")).toContain("依赖 column twice");
    expect(problemOf("| 步骤 | 内容 | 依赖 |\n| 1 | x | - |\n")).toContain("separator");
    expect(problemOf("| 步骤 | 内容 | 依赖 |\n|---|---|---|\n")).toContain("no steps");
    expect(problemOf(table("| 1 | 建表 |"))).toContain("step row 1 has 2 cells, the header has 3");
  });

  test("BR-2370: a bad step name, an empty 内容 and a bad name in 依赖", () => {
    expect(problemOf(table("| 第一步 | x | - |"))).toContain("not a step name");
    expect(problemOf(table("| 1 2 | x | - |"))).toContain("not a step name");
    expect(problemOf(table("| 1 |  | - |"))).toContain("step 1 has no 内容");
    expect(problemOf(table("| 1 | x | - |", "| 2 | y | 1 2 |"))).toContain("not a step name");
  });

  test("BR-2370: a repeated step, a dependency that is no step, a step that depends on itself, a circle", () => {
    expect(problemOf(table("| 2 | x | - |", "| 2 | y | - |"))).toContain("step 2 is written twice");
    expect(problemOf(table("| 2 | x | 9 |"))).toContain("9, which is not a step of this plan");
    expect(problemOf(table("| 2 | x | 2 |"))).toContain("depends on itself");
    expect(problemOf(table("| 1 | x | 2 |", "| 2 | y | 1 |"))).toContain("1 -> 2 -> 1");
    expect(problemOf(table("| 1 | x | - |", "| 2 | y | 3 |", "| 3 | z | 2 |"))).toContain("2 -> 3 -> 2");
  });

  test("BR-2370: a sound plan with a shared dependency is no problem", () => {
    expect(readPlan(planBody(table("| 1 | a | - |", "| 2 | b | 1 |", "| 3 | c | 1, 2 |"))).kind).toBe("plan");
  });

  test("BR-2370: canon check reports file-invalid for a broken plan and still reads the change and its rules", () => {
    const root = repo([
      changeFile(1, "open", { plan: table("| 1 | x | 9 |"), rules: "BR-77" }),
      changeFile(2, "open", { plan: FOUR }),
    ]);
    const r = canon(root, "check");
    expect(r.out).toMatch(/file-invalid\s+canon\/changes\/C-1\.md: C-1 ## 计划: step 1 depends on 9/);
    expect(r.out).not.toMatch(/file-invalid\s+canon\/changes\/C-2\.md/);
    // the change is still read: its rule list is checked as any change's (BR-77 does not exist)
    expect(r.out).toMatch(/ref-dangling\s+canon\/changes\/C-1\.md: names BR-77/);
  });
});

describe("a change naming the steps it does", () => {
  test("BR-2371: plan and steps are read; numbers and quoted names are step names, several changes may do one step", () => {
    expect(planLink({ plan: "C-1", steps: [3, "4", "3.1", "db-1"] }, "C")).toEqual({ plan: "C-1", steps: ["3", "4", "3.1", "db-1"] });
    expect(planLink({}, "C")).toEqual({});
  });

  test("BR-2371: only one of plan and steps, a plan that is no change id, an empty list, a decimal number or a bad name is a bad file", () => {
    expect(planLink({ plan: "C-1" }, "C")).toBeTypeOf("string");
    expect(planLink({ steps: [3] }, "C")).toBeTypeOf("string");
    expect(planLink({ plan: "BR-4", steps: [3] }, "C")).toContain("change id");
    expect(planLink({ plan: "C-1", steps: [] }, "C")).toContain("non-empty");
    expect(planLink({ plan: "C-1", steps: [3.1] }, "C")).toContain("quoted");
    expect(planLink({ plan: "C-1", steps: ["a b"] }, "C")).toContain("not a step name");
  });

  test("BR-2371: canon check accepts real links, including a plan change that does its own step, and reports the dangling ones", () => {
    const good = repo([changeFile(1, "open", { plan: FOUR, link: linked("C-1", "1") }), changeFile(2, "open", { link: linked("C-1", "2", "3") }), changeFile(5, "open", { link: linked("C-1", "2") })]);
    expect(canon(good, "check").out).not.toMatch(/ref-dangling|file-invalid/);
    const bad = repo([
      changeFile(1, "open", { plan: FOUR }),
      changeFile(2, "open", { link: linked("C-9", "1") }),
      changeFile(3, "open", { link: linked("C-4", "1") }),
      changeFile(4, "open"),
      changeFile(6, "open", { link: linked("C-1", "7") }),
      changeFile(7, "open", { link: "plan: C-1\n" }),
      changeFile(8, "open", { link: "steps: [3]\n" }),
      changeFile(9, "open", { link: "plan: BR-4\nsteps: [3]\n" }),
    ]);
    const out = canon(bad, "check").out;
    expect(out).toMatch(/ref-dangling\s+canon\/changes\/C-2\.md: C-2 `plan` names C-9, which does not exist/);
    expect(out).toMatch(/ref-dangling\s+canon\/changes\/C-3\.md: C-3 `plan` names C-4, which has no ## 计划 section/);
    expect(out).toMatch(/ref-dangling\s+canon\/changes\/C-6\.md: C-6 `steps` names 7, which is not a step of the plan in C-1/);
    for (const n of [7, 8, 9]) expect(out).toMatch(new RegExp(`file-invalid\\s+canon/changes/C-${n}\\.md`));
  });
});

/** C-1 holds FOUR (1 -> 2, 3 -> 4); the doers are `doers`. */
const withDoers = (doers: [string, string, string][]) =>
  repo([changeFile(1, "open", { plan: FOUR, title: "Build it" }), ...doers.map(([n, status, steps]) => changeFile(Number(n), status, { link: linked("C-1", ...steps.split(",").filter(Boolean)) }))]);
const jsonOf = (root: string) => JSON.parse(canon(root, "plan", "status", "C-1", "--json").out) as { done: number; working: number; ready: number; blocked: number; percent: number; steps: { step: string; state: string; changes: string[]; waiting_for: string[] }[] };
const statesOf = (root: string) => Object.fromEntries(jsonOf(root).steps.map((s) => [s.step, s.state]));

describe("the state of a step", () => {
  test("BR-2372: no change and no dependency is ready; a done change is done; a dependency that is not done blocks", () => {
    expect(statesOf(withDoers([]))).toEqual({ 1: "ready", 2: "blocked", 3: "blocked", 4: "blocked" });
    expect(statesOf(withDoers([["2", "done", "1"]]))).toEqual({ 1: "done", 2: "ready", 3: "ready", 4: "blocked" });
  });

  test("BR-2372: a step with a done change and an open one is working; an open change on a blocked step makes it working", () => {
    expect(statesOf(withDoers([["2", "done", "1"], ["3", "open", "1"]]))["1"]).toBe("working");
    expect(statesOf(withDoers([["2", "open", "2"]]))).toEqual({ 1: "ready", 2: "working", 3: "blocked", 4: "blocked" });
  });

  test("BR-2372: a dropped change counts for nothing, a step with only dropped changes is ready or blocked as if untouched", () => {
    expect(statesOf(withDoers([["2", "dropped", "1"], ["3", "dropped", "2"]]))).toEqual({ 1: "ready", 2: "blocked", 3: "blocked", 4: "blocked" });
  });

  test("BR-2372: a step waits for the dependencies not done, and the percentage rounds down", () => {
    const j = jsonOf(withDoers([["2", "done", "1"], ["3", "done", "2"]]));
    expect(j.steps.find((s) => s.step === "4")).toMatchObject({ state: "blocked", waiting_for: ["3"] });
    expect(j).toMatchObject({ done: 2, ready: 1, blocked: 1, percent: 50 });
    const three = repo([changeFile(1, "open", { plan: table("| 1 | a | - |", "| 2 | b | - |", "| 3 | c | - |") }), changeFile(2, "done", { link: linked("C-1", "1", "2") })]);
    const p = JSON.parse(canon(three, "plan", "status", "C-1", "--json").out) as { percent: number };
    expect(p.percent).toBe(66);
  });

  test("BR-2372: a change only on its own branch is working, even when it says done there", () => {
    const root = repo([changeFile(1, "open", { plan: FOUR })]);
    const s = start(ws(root), { title: "Do step one", plan: { id: "C-1", steps: ["1"] } }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    expect(statesOf(root)).toEqual({ 1: "working", 2: "blocked", 3: "blocked", 4: "blocked" });
    const dir = sh(s.value.worktree, "ls-files", "canon/changes").split("\n").find((f) => f.includes(s.value.change))!;
    writeFileSync(join(s.value.worktree, dir), sh(s.value.worktree, "show", `HEAD:${dir}`).replace("status: open", "status: done"));
    sh(s.value.worktree, "commit", "-qam", "done on the branch");
    expect(statesOf(root)).toEqual({ 1: "working", 2: "blocked", 3: "blocked", 4: "blocked" });
    expect(jsonOf(root).steps[0]!.changes).toEqual([s.value.change]);
  });
});

describe("canon plan status", () => {
  test("BR-2373: one line per plan, by number, with the counts; a done plan change still shows; a broken plan does not", () => {
    const root = repo([
      changeFile(10, "open", { plan: table("| 1 | a | - |"), title: "Ten" }),
      changeFile(3, "done", { plan: FOUR, title: "Three" }),
      changeFile(4, "open", { link: linked("C-3", "1") }),
      changeFile(5, "open", { plan: table("| 1 | a | 9 |"), title: "Broken" }),
      changeFile(6, "open"),
    ]);
    const r = canon(root, "plan", "status");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").map((l) => l.replace(/\s+/g, " "))).toEqual(["C-3 Three 已完成 0/4 (0%) 进行中 1 可开始 0 被挡住 3", "C-10 Ten 已完成 0/1 (0%) 进行中 0 可开始 1 被挡住 0"]);
  });

  test("BR-2373: with no plan it says so and exits 0; --json has one object per plan with whole-number counts", () => {
    const none = canon(repo([changeFile(1, "open")]), "plan", "status");
    expect([none.code, none.out.trim()]).toEqual([0, "(no plans)"]);
    const root = withDoers([["2", "done", "1"], ["3", "open", "2"]]);
    const all = JSON.parse(canon(root, "plan", "status", "--json").out) as { id: string; total: number; done: number; working: number; ready: number; blocked: number; percent: number }[];
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "C-1", total: 4, done: 1, working: 1, ready: 1, blocked: 1, percent: 25 });
    expect(all[0]!.done + all[0]!.working + all[0]!.ready + all[0]!.blocked).toBe(all[0]!.total);
  });

  test("BR-2374: a plan lists ready steps with their content, working ones with the change, blocked ones with what they wait for, done ones by name", () => {
    const root = withDoers([["2", "done", "1"], ["3", "open", "2"]]);
    const lines = canon(root, "plan", "status", "C-1").out.trim().split("\n");
    expect(lines.slice(1)).toEqual(["  可开始: 3 界面", "  进行中: 2 (C-3)", "  被挡住: 4 (等 2, 3)", "  已完成: 1"]);
    expect(lines[0]!.replace(/\s+/g, " ")).toBe("C-1 Build it 已完成 1/4 (25%) 进行中 1 可开始 1 被挡住 1");
  });

  test("BR-2374: a state with no steps has no line, a blocked step waits only for what is not done, and --json has the steps", () => {
    const root = withDoers([["2", "done", "1"], ["3", "done", "2"]]);
    const lines = canon(root, "plan", "status", "C-1").out.trim().split("\n");
    expect(lines.slice(1)).toEqual(["  可开始: 3 界面", "  被挡住: 4 (等 3)", "  已完成: 1, 2"]);
    const j = jsonOf(root);
    expect(j.steps[3]).toMatchObject({ step: "4", content: "联调", depends_on: ["2", "3"], state: "blocked", changes: [], waiting_for: ["3"] });
    expect(j.steps[0]).toMatchObject({ state: "done", waiting_for: [], changes: ["C-2"] });
  });

  test("BR-2374: an id that is a rule, no change, a change without a plan or with a broken plan is exit 3 with nothing on stdout", () => {
    const root = repo([changeFile(1, "open"), changeFile(2, "open", { plan: table("| 1 | a | 9 |") })]);
    for (const target of ["BR-1", "C-9", "C-1", "C-2"]) {
      const r = canon(root, "plan", "status", target);
      expect([target, r.code, r.out]).toEqual([target, 3, ""]);
    }
    expect(canon(root, "plan", "status", "C-1").err).toContain("has no plan");
  });
});

const planLines = (out: string) => out.split("\n").filter((l) => l.startsWith("Plan "));

describe("plans in canon brief", () => {
  test("BR-2383: where no change is claimed, a plan with ready steps gets one line with its progress and the ready steps", () => {
    const root = withDoers([["2", "done", "1"]]);
    expect(planLines(canon(root, "brief").out)).toEqual(["Plan C-1 Build it: 已完成 1/4 (25%); 可开始: 2 接口; 3 界面"]);
  });

  test("BR-2383: a plan whose steps are all working, blocked or done has no line, and with no plan nothing changes", () => {
    expect(planLines(canon(withDoers([["2", "done", "1"], ["3", "open", "2"], ["4", "open", "3"]]), "brief").out)).toEqual([]);
    expect(planLines(canon(withDoers([["2", "done", "1,2,3,4"]]), "brief").out)).toEqual([]);
    expect(planLines(canon(repo([changeFile(1, "open")]), "brief").out)).toEqual([]);
  });

  test("BR-2383: a plan of 50 steps with 8 ready takes one line naming 5 and counting the rest; a claimed worktree shows no plan", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `| ${i + 1} | s${i + 1} | ${i < 8 ? "-" : "1"} |`);
    const root = repo([changeFile(1, "open", { plan: table(...rows), title: "Big" })]);
    expect(planLines(canon(root, "brief").out)).toEqual(["Plan C-1 Big: 已完成 0/50 (0%); 可开始: 1 s1; 2 s2; 3 s3; 4 s4; 5 s5; 另有 3 步可开始 (canon plan status C-1)"]);
    const s = start(ws(root), { title: "Other work" }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    expect(planLines(canon(s.value.worktree, "brief").out)).toEqual([]);
  });
});

describe("plans in canon change list", () => {
  test("BR-2384: a change doing steps is marked with its plan and steps, the plan change with its progress", () => {
    const root = withDoers([["2", "done", "1"], ["3", "open", "2"], ["5", "open", "2,3"]]);
    const lines = canon(root, "change", "list").out.trim().split("\n");
    const line = (id: string) => lines.find((l) => l.startsWith(`${id} `)) ?? "";
    expect(line("C-1")).toContain("plan 已完成 1/4 (25%)");
    expect(line("C-3")).toContain("plan C-1 step 2");
    expect(line("C-5")).toContain("plan C-1 steps 2, 3");
    expect(line("C-1")).not.toContain("plan C-1 step");
  });

  test("BR-2384: a broken plan gets no progress; --json has plan_progress only on a plan change; no plans, no marks", () => {
    const broken = repo([changeFile(1, "open", { plan: table("| 1 | a | 9 |") })]);
    expect(canon(broken, "change", "list").out).not.toContain("已完成");
    const root = withDoers([["2", "done", "1"], ["3", "open", "2"]]);
    const all = JSON.parse(canon(root, "change", "list", "--json").out) as { id: string; plan_progress?: unknown; plan?: string; steps?: string[] }[];
    expect(all.find((c) => c.id === "C-1")?.plan_progress).toEqual({ total: 4, done: 1, percent: 25 });
    expect(all.find((c) => c.id === "C-3")).toMatchObject({ plan: "C-1", steps: ["2"] });
    expect(all.find((c) => c.id === "C-3")).not.toHaveProperty("plan_progress");
    const plain = canon(repo([changeFile(1, "open"), changeFile(2, "open")]), "change", "list").out;
    expect(plain).not.toContain("plan");
  });
});

describe("plan marks next to the other marks", () => {
  test("BR-2384: the step mark comes after on branch and handoff in change list; brief's order line has no plan mark", () => {
    const root = repo([changeFile(1, "open", { plan: FOUR, title: "Build it" })]);
    // reason: started and stopped through the CLI, so the same actor holds and releases the claim
    const started = canon(root, "work", "start", "--title", "Step one", "--plan", "C-1", "--step", "1").out;
    const id = started.match(/(C-\d+) →/)![1]!;
    const wt = started.match(/cd (.+)/)![1]!.trim();
    expect(canon(wt, "work", "stop", "--next", "write it", "--release").code).toBe(0);
    const line = canon(root, "change", "list").out.split("\n").find((l) => l.startsWith(`${id} `))!;
    expect(line).toMatch(new RegExp(`\\(on branch change/${id}-[^;]+; handoff: write it; plan C-1 step 1\\)$`));
    const order = canon(root, "brief").out.split("\n").find((l) => l.startsWith("Open changes in the owner's order"))!;
    expect(order).toContain(`${id} (on branch`);
    expect(order).not.toContain("plan C-1");
  });
});

describe("canon plan link", () => {
  const started = (root: string) => {
    const out = canon(root, "work", "start", "--title", "Started without a plan").out;
    return { id: out.match(/(C-\d+) →/)![1]!, wt: out.match(/cd (.+)/)![1]!.trim() };
  };

  test("BR-2389: a started change gets plan and steps written in its worktree, and the step shows as working", () => {
    const root = repo([changeFile(1, "open", { plan: FOUR, title: "Build it" })]);
    const s = started(root);
    const r = canon(s.wt, "plan", "link", s.id, "--plan", "C-1", "--step", "2, 3");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${s.id} → plan C-1 steps 2, 3`);
    sh(s.wt, "commit", "-qam", "link");
    const steps = (JSON.parse(canon(root, "plan", "status", "C-1", "--json").out) as { steps: { step: string; state: string; changes: string[] }[] }).steps;
    expect(steps.filter((x) => x.changes.includes(s.id)).map((x) => x.step)).toEqual(["2", "3"]);
    expect(steps.find((x) => x.step === "2")!.state).toBe("working");
  });

  test("BR-2389: an unknown step, a change without a plan, an existing plan, a closed change, and a change not in this checkout are refused with nothing written", () => {
    const root = repo([changeFile(1, "open", { plan: FOUR }), changeFile(7, "open"), changeFile(8, "done")]);
    const s = started(root);
    const file = () => sh(s.wt, "status", "--porcelain");
    expect(canon(s.wt, "plan", "link", s.id, "--plan", "C-1", "--step", "9").code).toBe(3);
    expect(canon(s.wt, "plan", "link", s.id, "--plan", "C-7", "--step", "1").code).toBe(3);
    expect(canon(s.wt, "plan", "link", s.id, "--plan", "C-1", "--step", "").code).toBe(2);
    expect(file()).toBe("");
    expect(canon(s.wt, "plan", "link", "C-8", "--plan", "C-1", "--step", "1").code).toBe(2);
    const elsewhere = canon(root, "plan", "link", s.id, "--plan", "C-1", "--step", "1");
    expect([elsewhere.code, elsewhere.err.includes("worktree")]).toEqual([3, true]);
    expect(canon(s.wt, "plan", "link", s.id, "--plan", "C-1", "--step", "1").code).toBe(0);
    const again = canon(s.wt, "plan", "link", s.id, "--plan", "C-1", "--step", "2");
    expect([again.code, again.err.includes("by hand")]).toEqual([5, true]);
  });
});
