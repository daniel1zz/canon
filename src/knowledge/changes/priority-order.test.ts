import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";

// reason: every case spawns canon several times; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
function cli(cwd: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:s1" };
  delete env["CLAUDECODE"];
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const BODY = "\n## 为什么\n\nx\n\n## 要改什么\n\nx\n";
const change = (n: number, extra = "") => `---\nid: C-${n}\ntitle: Change ${n}\nstatus: open\nrules: []\n${extra}---\n${BODY}`;

/** Open C-3, C-4, C-6 and C-7 on main; the backlog lists C-3 then C-4 (BR-2148). C-7 depends on C-6 when `dep`. */
function repo(dep = false): string {
  const root = project(); roots.push(root);
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nx\n");
  writeFileSync(join(root, "canon/backlog.md"), "# 待办\n\n1. C-3\n2. C-4\n");
  for (const n of [3, 4, 6]) writeFileSync(join(root, `canon/changes/C-${n}.md`), change(n));
  writeFileSync(join(root, "canon/changes/C-7.md"), change(7, dep ? "depends_on: [C-6]\n" : ""));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "changes");
  return root;
}
const listed = (root: string) => (JSON.parse(cli(root, "change", "list", "--json").out) as { id: string }[]).map((c) => c.id);
const takeLine = (root: string) => cli(root, "brief").out.split("\n").find((l) => l.startsWith("Open changes in the owner's order")) ?? "";
const set = (root: string, id: string, tier: string) => expect(cli(root, "priority", "set", id, tier, "--reason", "test").code).toBe(0);

describe("BR-2604: startable changes by tier first, the owner's order within a tier", () => {
  test("BR-2604: with no tier set the order is the same as before: the backlog's, then the rest by id", () => {
    const root = repo();
    expect(listed(root)).toEqual(["C-3", "C-4", "C-6", "C-7"]);
    expect(takeLine(root)).toEndWith(": C-3, C-4, C-6, C-7");
  });

  test("BR-2604: a P1 change the backlog does not list comes first; two P1 changes keep the backlog's order; P3 goes last", () => {
    const root = repo();
    set(root, "C-7", "P1");
    expect(listed(root)).toEqual(["C-7", "C-3", "C-4", "C-6"]);
    expect(takeLine(root)).toEndWith(": C-7, C-3, C-4, C-6");
    set(root, "C-3", "P1");
    expect(listed(root)).toEqual(["C-3", "C-7", "C-4", "C-6"]);
    set(root, "C-4", "P3");
    expect(listed(root)).toEqual(["C-3", "C-7", "C-6", "C-4"]);
    expect(takeLine(root)).toEndWith(": C-3, C-7, C-6, C-4");
  });

  test("BR-2604: a tier does not make a change whose dependency has not landed startable", () => {
    const root = repo(true);
    set(root, "C-7", "P1");
    const brief = cli(root, "brief").out;
    expect(takeLine(root)).toEndWith(": C-3, C-4, C-6");
    expect(brief).toContain("Waiting for dependencies, not ready to start: C-7 (waiting for C-6)");
    const c7 = (JSON.parse(cli(root, "change", "list", "--json").out) as { id: string; state: string; priority: string }[]).find((c) => c.id === "C-7");
    expect(c7).toMatchObject({ state: "waiting-deps", priority: "P1" });
  });
});
