import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../work/testkit.ts";

const MAIN = join(import.meta.dir, "main.ts");
const id = (prefix: string, n: number) => [prefix, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function change(root: string, n: number, extra = "") {
  writeFileSync(join(root, `canon/changes/${id("C", n)}.md`), `---\nid: ${id("C", n)}\ntitle: Change ${n}\nstatus: open\n${extra}---\n\n## 为什么\n\nx.\n\n## 要改什么\n\nx.\n\n## 任务\n\n- [ ] x\n`);
}

/** A project on main with open changes C-1..C-3, a done C-5 and a billing rule BR-1 under test. */
function fixture() {
  const root = project();
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  const rule = id("BR", 1);
  writeFileSync(join(root, `canon/rules/billing/${rule}.md`), `---\nid: ${rule}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nx.\n\n## 例子\n\n- a → b\n`);
  for (const n of [1, 2, 3]) change(root, n);
  writeFileSync(join(root, `canon/changes/${id("C", 5)}.md`), `---\nid: ${id("C", 5)}\ntitle: Done\nstatus: done\n---\n\n## 为什么\n\nx.\n\n## 要改什么\n\nx.\n\n## 任务\n\n- [ ] x\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

function backlog(root: string, text: string) {
  writeFileSync(join(root, "canon/backlog.md"), `---\ntitle: 待办顺序\n---\n# 待办顺序\n\n${text}`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "backlog");
}

const listed = (out: string) => out.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);

describe("backlog order", () => {
  test("BR-2148: change list follows canon/backlog.md, then the rest by id; first mention counts; mid-item ids do not", () => {
    const root = fixture();
    expect(listed(canon(root, "change", "list").out)).toEqual([id("C", 1), id("C", 2), id("C", 3)]); // no backlog: by id
    backlog(root, `1. ${id("C", 3)} first\n2. ${id("C", 1)}\n- ${id("C", 5)} done one\n- [ ] ${id("C", 3)} again\n- 先做 ${id("C", 2)}\n`);
    expect(listed(canon(root, "change", "list").out)).toEqual([id("C", 3), id("C", 1), id("C", 2)]);
    change(root, 4);
    expect(listed(canon(root, "change", "list").out)).toEqual([id("C", 3), id("C", 1), id("C", 2), id("C", 4)]);
    expect(listed(canon(root, "change", "list", "--all").out)).toEqual([id("C", 3), id("C", 1), id("C", 5), id("C", 2), id("C", 4)]);
    expect((JSON.parse(canon(root, "change", "list", "--json").out) as { id: string }[]).map((c) => c.id)).toEqual([id("C", 3), id("C", 1), id("C", 2), id("C", 4)]);
  });

  test("BR-2150: canon check reports a backlog id that is no change, by line; a done change and no backlog are fine", () => {
    const root = fixture();
    expect(canon(root, "check").code).toBe(0);
    backlog(root, `- ${id("C", 5)}\n- ${id("C", 99)}\n`);
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`ref-dangling       canon/backlog.md:7: lists ${id("C", 99)}, which is not a change`);
    expect(r.out).not.toContain(id("C", 5));
  });

  test("BR-2149: brief on the main checkout lists open changes in the owner's order and marks claimed ones; nothing when none are open", () => {
    const empty = project();
    expect(canon(empty, "brief").out).not.toContain("Open changes in the owner's order");
    const root = fixture();
    backlog(root, `- ${id("C", 2)}\n`);
    const started = canon(root, "work", "start", id("C", 2));
    expect(started.code).toBe(0);
    const wt = started.out.match(/cd (.+)/)![1]!.trim();
    expect(canon(root, "brief").out).toContain(`Open changes in the owner's order (canon change list); with no task, take the first unclaimed one: ${id("C", 2)} (claimed), ${id("C", 1)}, ${id("C", 3)}`);
    expect(canon(wt, "brief").out).not.toContain("Open changes in the owner's order");
  });
});

describe("open review notes", () => {
  function noted(root: string) {
    ws(root).db.event("agent:x", "land.ok", id("C", 9), { reviewed: [id("BR", 1)], notes: ["例子缺少边界另一侧"] });
  }

  test("BR-2146: canon context lists the open notes of the rules it covers, for a domain and for the rule itself; none, no section", () => {
    const root = fixture();
    expect(canon(root, "context", "billing").out).not.toContain("Open review notes");
    noted(root);
    for (const target of ["billing", id("BR", 1)]) {
      const out = canon(root, "context", target).out;
      expect(out).toContain("# Open review notes");
      expect(out).toContain(`- ${id("BR", 1)}: 例子缺少边界另一侧 (${id("C", 9)}, `);
    }
  });

  test("BR-2147: brief in a change's worktree shows the open notes of the rules the change names; not for ids in backticks, not on main", () => {
    const root = fixture();
    change(root, 6, `rules: [${id("BR", 1)}]\n`);
    writeFileSync(join(root, `canon/changes/${id("C", 7)}.md`), `---\nid: ${id("C", 7)}\ntitle: Seven\nstatus: open\n---\n\n## 为什么\n\n\`${id("BR", 1)}\` only as an example.\n\n## 要改什么\n\nx.\n\n## 任务\n\n- [ ] x\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "changes");
    noted(root);
    const wt = (c: string) => canon(root, "work", "start", c).out.match(/cd (.+)/)![1]!.trim();
    expect(canon(wt(id("C", 6)), "brief").out).toContain(`Open review note on ${id("BR", 1)}: 例子缺少边界另一侧`);
    expect(canon(wt(id("C", 7)), "brief").out).not.toContain("Open review note");
    expect(canon(root, "brief").out).not.toContain("Open review note");
  });
});
