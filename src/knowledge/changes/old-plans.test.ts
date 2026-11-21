import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../work/land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";

// reason: each case spawns canon or makes worktrees; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const cli = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

const BODY = "\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 教训\n\n无。\n";
/** A change file with front matter lines `extra` and `plan` as its 计划 section's text (none when undefined). */
const change = (n: number, status: string, extra = "", plan?: string) =>
  `---\nid: C-${n}\ntitle: Change ${n}\nstatus: ${status}\nrules: []\n${extra}---\n${BODY}${plan === undefined ? "" : `\n## 计划\n\n${plan}\n`}`;
const TABLE = "| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | 建表 | - |\n| 2 | 接口 | 1 |\n";

function repo(files: Record<string, string>): string {
  const root = project();
  write(root, files);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}
function write(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, "canon", p, ".."), { recursive: true });
    writeFileSync(join(root, "canon", p), text);
  }
}
const notes = (err: string) => err.split("\n").filter((l) => l.includes("(BR-2595)"));

describe("old plan data (D-148)", () => {
  test("BR-2594: plan and steps of any shape, and a broken plan table, are no finding; the change is read as usual", () => {
    const root = repo({
      "changes/C-1.md": change(1, "open", "", "| 步骤 | 内容 |\n|---|---|\n| 1 | a |\n"),
      "changes/C-2.md": change(2, "open", "plan: C-9\nsteps: [\"3\"]\n"),
      "changes/C-3.md": change(3, "open", "plan: C-1\n"),
      "changes/C-4.md": change(4, "open", "steps: [3.1]\n"),
      "changes/C-5.md": change(5, "open", "", "| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | a | 2 |\n| 2 | b | 1 |\n"),
    });
    const r = cli(root, "check");
    expect([r.code, r.out.trim().split("\n").at(-1)]).toEqual([0, expect.stringMatching(/^ok: /)]);
    const listed = JSON.parse(cli(root, "change", "list", "--json").out) as Record<string, unknown>[];
    expect(listed.map((c) => c["id"])).toEqual(expect.arrayContaining(["C-1", "C-2", "C-3", "C-4", "C-5"]));
    for (const c of listed) for (const key of ["plan", "steps", "plan_progress"]) expect(c).not.toHaveProperty(key);
    expect(cli(root, "change", "list").out).not.toContain("plan C-");
  });

  test("BR-2594: canon plan is no command and canon work start takes no --plan or --step: exit 2, nothing made", () => {
    const root = repo({ "changes/C-1.md": change(1, "open", "", TABLE) });
    expect(cli(root, "plan", "status").code).toBe(2);
    const head = sh(root, "rev-parse", "HEAD").trim();
    const r = cli(root, "work", "start", "--owner-gate", "none: test", "--advances", "none: test", "--title", "x", "--plan", "C-1", "--step", "1");
    expect(r.code).toBe(2);
    expect(sh(root, "rev-parse", "HEAD").trim()).toBe(head);
    expect(sh(root, "branch", "--list", "change/*").trim()).toBe("");
    expect(sh(root, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  test("BR-2594: a branch whose change still carries plan and steps lands", async () => {
    const root = repo({ "changes/C-1.md": change(1, "done", "", TABLE) });
    const s = startNew(root, "Old style step");
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((n) => n.startsWith(`${s.change}`) && n.endsWith(".md"))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("rules: []\n", "rules: []\nplan: C-1\nsteps: [\"2\", 3.1]\n"));
    sh(s.worktree, "commit", "-qam", "old plan link");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
  });

  test("BR-2595: one note per change with old steps no done change names, on stderr only; the exit code and stdout stay", () => {
    const files = {
      "changes/C-1.md": change(1, "open", "", TABLE),
      "changes/C-2.md": change(2, "done", "plan: C-1\nsteps: [1]\n"),
    };
    const root = repo(files);
    const r = cli(root, "check");
    expect(r.code).toBe(0);
    expect(notes(r.err)).toHaveLength(1);
    expect(notes(r.err)[0]).toContain("C-1 ## 计划 has step(s) no landed change names: 2;");
    expect(notes(r.err)[0]).toContain("canon change new --title");
    expect(notes(r.err)[0]).toContain("--depends");
    expect(r.out).not.toContain("BR-2595");
    expect(cli(root, "check", "--json").out).not.toContain("BR-2595");
    // step 2 done by a landed change too: nothing to say
    const done = repo({ ...files, "changes/C-3.md": change(3, "done", "plan: C-1\nsteps: [\"2\"]\n") });
    expect(notes(cli(done, "check").err)).toEqual([]);
  });

  test("BR-2595: a step only open or dropped changes name is still said; several steps share the change's one line", () => {
    const root = repo({
      "changes/C-1.md": change(1, "open", "", "| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | a | - |\n| 2 | b | - |\n| 3 | c | - |\n"),
      "changes/C-2.md": change(2, "done", "plan: C-1\nsteps: [2]\n"),
      "changes/C-3.md": change(3, "open", "plan: C-1\nsteps: [1]\n"),
      "changes/C-4.md": change(4, "dropped", "plan: C-1\nsteps: [3]\n"),
    });
    const lines = notes(cli(root, "check").err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no landed change names: 1, 3;");
  });

  test("BR-2595: a migrated table, a dropped holder, a table in a fence and a section without a table are not said", () => {
    const root = repo({
      "changes/C-1.md": change(1, "done", "", `| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | a | - |\n\n未做的步骤已转成变更：2 → C-9。\n`),
      "changes/C-2.md": change(2, "done", "plan: C-1\nsteps: [1]\n"),
      "changes/C-3.md": change(3, "dropped", "", TABLE),
      "changes/C-4.md": change(4, "open", "", "```\n" + TABLE + "```\n"),
      "changes/C-5.md": change(5, "open", "", "只有文字，没有表。\n"),
    });
    const fenced = "changes/C-6.md";
    write(root, { [fenced]: change(6, "open").replace("## 为什么", "```\n## 计划\n\n" + TABLE + "```\n\n## 为什么") });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "fenced heading");
    expect(notes(cli(root, "check").err)).toEqual([]);
  });
});
