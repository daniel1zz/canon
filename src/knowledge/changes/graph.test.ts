import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";

// reason: each case spawns canon several times; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const cli = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

const BODY = "\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 教训\n\n无。\n";
const change = (n: number, status: string, extra = "") => `---\nid: C-${n}\ntitle: Change ${n}\nstatus: ${status}\nrules: []\n${extra}---\n${BODY}`;
const release = (n: number, features = "[]", criteria = "x") => `---\nid: R-${n}\ntitle: Release ${n}\nstatus: active\nfeatures: ${features}\n---\n\n## 目标\n\nx\n\n## 用户\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\n${criteria}\n\n## 故事地图切片\n\nx\n`;
const feature = (n: number) => `---\nid: F-${n}\ntitle: Feature ${n}\nstatus: active\n---\n\n## 目标\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\nx\n`;

function commit(root: string, files: Record<string, string>, message = "fixture"): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, "canon", p, ".."), { recursive: true });
    writeFileSync(join(root, "canon", p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", message);
}

/**
 * R-2 lists F-1. C-3 landed; C-5 depends on C-3 and has a change branch; C-6 depends on C-5; C-7 is F-1's; C-9 waits for
 * C-30, open and in no release; C-10 waits for the owner's criterion R-2/S1; C-4 is dropped; C-8 exists only on its branch.
 */
function fixture(): string {
  const root = project();
  commit(root, {
    "releases/R-2.md": release(2, "[F-1]", "- S1 负责人逐条回答。（待负责人）"),
    "releases/R-3.md": release(3),
    "features/F-1.md": feature(1),
    "changes/C-3.md": change(3, "done", "release: R-2\n"),
    "changes/C-4.md": change(4, "dropped", "release: R-2\n"),
    "changes/C-5.md": change(5, "open", "release: R-2\ndepends_on: [C-3]\n"),
    "changes/C-6.md": change(6, "open", "release: R-2\ndepends_on: [C-5]\n"),
    "changes/C-7.md": change(7, "open", "feature: F-1\n"),
    "changes/C-9.md": change(9, "open", "release: R-2\ndepends_on: [C-30]\n"),
    "changes/C-10.md": change(10, "open", "release: R-2\ndepends_on: [R-2/S1]\n"),
    "changes/C-30.md": change(30, "open"),
  });
  sh(root, "branch", "change/C-5");
  sh(root, "checkout", "-qb", "change/C-8");
  commit(root, { "changes/C-8.md": change(8, "open", "release: R-2\n") }, "C-8 on its branch");
  sh(root, "checkout", "-q", "main");
  return root;
}

describe("canon change graph", () => {
  test("BR-2570: a release's changes, its features' and those only on a branch, each in one state, dependencies first, with what each waits for", () => {
    const root = fixture();
    const r = cli(root, "change", "graph", "R-2");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n").map((l) => l.replace(/\s+/g, " "));
    expect(lines).toEqual([
      "R-2 Release 2 变更 7 个：已合入 1 进行中 2 在等 3 可开始 1",
      "C-3 已合入 Change 3",
      "C-5 进行中 Change 5 depends on C-3",
      "C-6 在等 Change 6 depends on C-5 waiting for C-5",
      "C-7 可开始 Change 7",
      "C-8 进行中 Change 8",
      "C-9 在等 Change 9 depends on C-30 waiting for C-30",
      "C-10 在等 Change 10 depends on R-2/S1 waiting for R-2/S1: 负责人逐条回答。",
    ]);
    expect(r.out).not.toContain("C-4");
    expect(cli(root, "change", "graph", "F-1").out.trim().split("\n").map((l) => l.replace(/\s+/g, " "))).toEqual(["F-1 Feature 1 变更 1 个：已合入 0 进行中 0 在等 0 可开始 1", "C-7 可开始 Change 7"]);
  });

  test("BR-2570: --json has the counts and each change with its state, depends_on and waiting_for; the same counts are the release's workload", () => {
    const root = fixture();
    const j = JSON.parse(cli(root, "change", "graph", "R-2", "--json").out) as { kind: string; counts: Record<string, number>; changes: { id: string; title: string; state: string; depends_on: string[]; waiting_for: { id: string; state: string }[] }[] };
    expect(j.kind).toBe("release");
    expect(j.counts).toEqual({ landed: 1, in_progress: 2, waiting: 3, ready: 1 });
    expect(j.changes.find((c) => c.id === "C-6")).toEqual({ id: "C-6", title: "Change 6", state: "waiting", depends_on: ["C-5"], waiting_for: [{ id: "C-5", state: "open" }] });
    const status = JSON.parse(cli(root, "release", "status", "--json").out) as { id: string; changes: Record<string, number> }[];
    expect(status.find((s) => s.id === "R-2")!.changes).toEqual(j.counts);
  });

  test("BR-2570: a dependency placed later by number still comes first; a cycle's changes come by number", () => {
    const root = project();
    commit(root, {
      "releases/R-2.md": release(2),
      "changes/C-1.md": change(1, "open", "release: R-2\ndepends_on: [C-2]\n"),
      "changes/C-2.md": change(2, "open", "release: R-2\n"),
      "changes/C-3.md": change(3, "open", "release: R-2\ndepends_on: [C-4]\n"),
      "changes/C-4.md": change(4, "open", "release: R-2\ndepends_on: [C-3]\n"),
    });
    const ids = cli(root, "change", "graph", "R-2").out.trim().split("\n").slice(1).map((l) => l.split(/\s+/)[0]);
    expect(ids).toEqual(["C-2", "C-1", "C-3", "C-4"]);
  });

  test("BR-2570: no linked change says so; an id that is no release or feature is exit 3 with nothing on stdout; no id is exit 2", () => {
    const root = fixture();
    expect(cli(root, "change", "graph", "R-3").out.trim().split("\n").map((l) => l.replace(/\s+/g, " "))).toEqual(["R-3 Release 3 变更 0 个：已合入 0 进行中 0 在等 0 可开始 0", "(no changes)"]);
    for (const target of ["BR-3", "R-9"]) {
      const r = cli(root, "change", "graph", target);
      expect([r.code, r.out]).toEqual([3, ""]);
    }
    expect(cli(root, "change", "graph").code).toBe(2);
  });
});
