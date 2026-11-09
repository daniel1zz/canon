import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocFile } from "../../knowledge/documents/docfile.ts";
import { project, quiet, sh, ws } from "../testkit.ts";
import { start } from "./session.ts";

// reason: each case spawns canon or a worktree setup; a loaded machine took longer than bun's 5 s default (as in session.test.ts)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const cli = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

const PLAN = "| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | 建表 | - |\n| 2 | 接口 | 1 |\n| 3.1 | 界面 | 1 |\n";
const planRepo = (plan = PLAN): string => {
  const root = project();
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, "canon/changes/C-1.md"), `---\nid: C-1\ntitle: The plan\nstatus: open\nrules: []\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 计划\n\n${plan}\n## 任务\n\n- [x] x\n`);
  writeFileSync(join(root, "canon/changes/C-7.md"), "---\nid: C-7\ntitle: Another\nstatus: open\nrules: []\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [x] x\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "plan");
  return root;
};

const metaOf = (worktree: string, id: string) => {
  const file = readdirSync(join(worktree, "canon/changes")).find((f) => f.startsWith(`${id}-`) || f === `${id}.md`)!;
  const parsed = parseDocFile(sh(worktree, "show", `HEAD:canon/changes/${file}`), file);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.meta;
};

const nothingLeft = (root: string): void => {
  expect(sh(root, "branch", "--list", "change/*")).toBe("");
  expect(sh(root, "worktree", "list").split("\n")).toHaveLength(1);
};

describe("work start with a plan step", () => {
  test("BR-2376: a new change gets plan and steps in the commit that opens it; several steps are comma separated", () => {
    const root = planRepo();
    const one = start(ws(root), { title: "Do the schema", plan: { id: "C-1", steps: ["1"] } }, quiet);
    if (!one.ok) throw new Error(one.error.message);
    expect(metaOf(one.value.worktree, one.value.change)).toMatchObject({ plan: "C-1", steps: ["1"] });
    const two = cli(root, "work", "start", "--title", "Do two steps", "--plan", "c-1", "--step", "2, 3.1");
    expect(two.code).toBe(0);
    const id = two.out.match(/(C-\d+) →/)![1]!;
    const wt = two.out.match(/cd (.+)/)![1]!.trim();
    expect(metaOf(wt, id)).toMatchObject({ plan: "C-1", steps: ["2", "3.1"] });
    expect(sh(wt, "log", "-1", "--format=%s")).toContain(`canon: open ${id}`);
  });

  test("BR-2376: --plan without --step, --step without --plan, and either with an existing change or --fix-main are usage errors", () => {
    const root = planRepo();
    for (const args of [["--title", "x", "--plan", "C-1"], ["--title", "x", "--step", "1"], ["C-7", "--plan", "C-1", "--step", "1"], ["--fix-main", "--plan", "C-1", "--step", "1"], ["--plan", "C-1", "--step", "1"]]) {
      const r = cli(root, "work", "start", ...args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 2]);
    }
    nothingLeft(root);
  });

  test("BR-2376: a plan that is not there, a step that is not in it, a change without a plan or with a broken one is exit 3 before anything is made", () => {
    const root = planRepo();
    const before = readdirSync(join(root, "canon/changes")).length;
    for (const [plan, step, why] of [["C-9", "1", "is not a change"], ["C-1", "9", "9 is not a step"], ["C-7", "1", "has no valid"], ["BR-1", "1", "is not a change"]] as const) {
      const r = cli(root, "work", "start", "--title", "x", "--plan", plan, "--step", step);
      expect([plan, r.code]).toEqual([plan, 3]);
      expect(r.err).toContain(why);
    }
    const broken = planRepo("| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | a | 9 |\n");
    expect(cli(broken, "work", "start", "--title", "x", "--plan", "C-1", "--step", "1").code).toBe(3);
    nothingLeft(root);
    nothingLeft(broken);
    expect(readdirSync(join(root, "canon/changes")).length).toBe(before);
    // no number was taken: the next change is C-8
    const next = start(ws(root), { title: "next" }, quiet);
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.change).toBe("C-8");
    expect(readFileSync(join(next.value.worktree, "canon/changes/C-1.md"), "utf8")).toContain("## 计划");
  });
});

describe("work start on a step another change is doing", () => {
  const doer = (root: string, n: number, status: string, steps: string) => {
    writeFileSync(join(root, `canon/changes/C-${n}.md`), `---\nid: C-${n}\ntitle: Doer ${n}\nstatus: ${status}\nrules: []\nplan: C-1\nsteps: [${steps.split(",").map((x) => JSON.stringify(x)).join(", ")}]\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [x] x\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", `doer ${n}`);
  };
  const taken = (out: string) => out.split("\n").filter((l) => l.startsWith("step "));

  test("BR-2385: a step an open change is doing is said and the start goes on with exit 0; only the steps taken are named", () => {
    const root = planRepo();
    doer(root, 300, "open", "3.1");
    const r = cli(root, "work", "start", "--title", "Also step two", "--plan", "C-1", "--step", "2,3.1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("cd ");
    expect(taken(r.out)).toEqual(["step 3.1 is already being done by C-300"]);
  });

  test("BR-2385: a step whose changes were all dropped or landed done, or that nobody does, is not said", () => {
    const root = planRepo();
    doer(root, 301, "dropped", "2");
    doer(root, 302, "done", "2");
    const r = cli(root, "work", "start", "--title", "Step two again", "--plan", "C-1", "--step", "2");
    expect(r.code).toBe(0);
    expect(taken(r.out)).toEqual([]);
    expect(taken(cli(root, "work", "start", "--title", "Step one", "--plan", "C-1", "--step", "1").out)).toEqual([]);
  });

  test("BR-2385: a change done only on its own branch still does the step", () => {
    const root = planRepo();
    const first = start(ws(root), { title: "First on two", plan: { id: "C-1", steps: ["2"] } }, quiet);
    if (!first.ok) throw new Error(first.error.message);
    const wt = first.value.worktree;
    const file = sh(wt, "ls-files", "canon/changes").split("\n").find((f) => f.includes(first.value.change))!;
    writeFileSync(join(wt, file), readFileSync(join(wt, file), "utf8").replace("status: open", "status: done"));
    sh(wt, "commit", "-qam", "done on the branch");
    const r = cli(root, "work", "start", "--title", "Second on two", "--plan", "C-1", "--step", "2");
    expect(r.code).toBe(0);
    expect(taken(r.out)).toEqual([`step 2 is already being done by ${first.value.change}`]);
  });
});
