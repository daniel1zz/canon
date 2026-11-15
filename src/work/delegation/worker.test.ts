import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(root: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
function fixture(delegated = true) {
  const root = project(); roots.push(root); mkdirSync(join(root, "canon"), { recursive: true }); writeFileSync(join(root, "canon/product.md"), "# Product\n\nFirst design.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Worker task", "agent:s1");
  if (delegated) expect(cli(root, "agent:s1", "work", "delegate", s.change, "--to", "w1").code).toBe(0);
  return { root, ...s };
}
function claim(root: string, change: string) {
  const w = ws(root); try { return w.db.db.query<{ holder: string; delegation_epoch: number; expires_at: string }, [string]>("SELECT holder,delegation_epoch,expires_at FROM claims WHERE subject = ?").get(change); } finally { w.db.close(); }
}
function redispatch(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.root, "canon/product.md"), readFileSync(join(f.root, "canon/product.md"), "utf8") + "\nUpdated design.\n"); sh(f.root, "commit", "-qam", "new design");
  expect(cli(f.root, "agent:s1", "work", "delegate", f.change, "--to", "w1").code).toBe(0);
}

test("BR-2498: only the named worker can claim, binding the first full actor and preserving its worktree", () => {
  const f = fixture();
  const wrong = cli(f.root, "agent:s7:w2", "work", "start", f.change); expect(wrong.code).toBe(1); expect(wrong.text).toContain("w1"); expect(claim(f.root, f.change)).toBeNull();
  const started = cli(f.root, "agent:s7:w1", "work", "start", f.change); expect(started).toMatchObject({ code: 0 }); expect(started.text).toContain(f.worktree); expect(started.text).toContain("agent:s1"); expect(started.text).toContain(sh(f.root, "rev-parse", "main")); expect(started.text).toContain("epoch 1");
  expect(claim(f.root, f.change)).toMatchObject({ holder: "agent:s7:w1", delegation_epoch: 1 });
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--next", "resume", "--release").code).toBe(0);
  const other = cli(f.root, "agent:s8:w1", "work", "start", f.change); expect(other.code).toBe(1); expect(other.text).toContain("agent:s7:w1"); expect(claim(f.root, f.change)).toBeNull();
  expect(cli(f.root, "agent:s7:w1", "work", "start", f.change).code).toBe(0);
});

test("BR-2498 BR-2011 BR-2012 BR-2457 BR-2022: workers cannot claim undelegated work or allocate new changes, fixes or chores", () => {
  const f = fixture(false); const before = sh(f.root, "for-each-ref", "--format=%(refname)", "refs/heads");
  const no = cli(f.root, "agent:s7:w1", "work", "start", f.change); expect(no.code).toBe(1); expect(no.text).toContain("未派发");
  for (const args of [["work", "start", "--title", "x"], ["work", "start", "--fix-main"], ["chore", "start", "tidy"]]) {
    const r = cli(f.root, "agent:s7:w1", ...args); expect(r.code).toBe(1); expect(r.text).toContain("delegate");
  }
  expect(sh(f.root, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(before);
  expect(claim(f.root, f.change)).toMatchObject({ holder: "agent:s1" });
  const w = ws(f.root); expect(w.db.db.query<{ next: number }, []>("SELECT next FROM ids WHERE prefix='C'").get()?.next).toBe(2); w.db.close();
  expect(cli(f.root, "agent:s2", "work", "start", "--title", "primary change").code).toBe(0);
  expect(cli(f.root, "agent:s2", "chore", "start", "primary chore").code).toBe(0);
});

test("BR-2498: accept-design reports every intervening contract change and answered request before advancing the claim", () => {
  const f = fixture(); expect(cli(f.root, "agent:s7:w1", "work", "start", f.change).code).toBe(0);
  redispatch(f);
  let w = ws(f.root); w.db.event("agent:s1", "design.answer", f.change, { request: 7, answer: "Keep compatibility.", main: sh(f.root, "rev-parse", "main") }); w.db.close();
  redispatch(f);
  const status = cli(f.worktree, "agent:s7:w1", "work", "status"); expect(status.code).toBe(0); expect(status.text).toContain("accept-design"); expect(status.text).toContain("epoch 3");
  const before = claim(f.root, f.change); expect(before?.delegation_epoch).toBe(1);
  const other = cli(f.worktree, "agent:s8:w1", "work", "accept-design", f.change); expect(other.code).toBe(5); expect(claim(f.root, f.change)).toEqual(before);
  const r = cli(f.worktree, "agent:s7:w1", "work", "accept-design", f.change); expect(r).toMatchObject({ code: 0 }); expect(r.text).toContain("canon/product.md"); expect(r.text).toContain("#7"); expect(r.text).toContain("Keep compatibility."); expect(claim(f.root, f.change)?.delegation_epoch).toBe(3);
  const again = cli(f.worktree, "agent:s7:w1", "work", "accept-design", f.change); expect(again.code).toBe(0); expect(again.text).toContain("已是最新");
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--next", "done", "--release").code).toBe(0);
  expect(cli(f.root, "agent:s7:w1", "work", "accept-design", f.change).code).toBe(5);
});

test("BR-2498: stale epochs and a taken-over expired claim reject worker stop, renewal and drop without mutation", () => {
  const f = fixture(); expect(cli(f.root, "agent:s7:w1", "work", "start", f.change).code).toBe(0); redispatch(f);
  const before = claim(f.root, f.change);
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--next", "stale", "--release").code).toBe(5);
  expect(cli(f.root, "agent:s7:w1", "work", "drop", f.change).code).toBe(5); expect(claim(f.root, f.change)).toEqual(before);
  const w = ws(f.root); w.db.db.query("UPDATE claims SET holder='agent:s1',expires_at='2000-01-01' WHERE subject=?").run(f.change); w.db.close();
  const taken = claim(f.root, f.change);
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--next", "old", "--release").code).toBe(5);
  expect(cli(f.root, "agent:s7:w1", "work", "drop", f.change).code).toBe(5);
  expect(claim(f.root, f.change)).toEqual(taken); expect(sh(f.worktree, "rev-parse", "--is-inside-work-tree")).toBe("true");
});

test("BR-2498: two simultaneous sessions with the same worker name cannot both bind the delegation", async () => {
  const f = fixture();
  const run = async (actor: string) => { const p = Bun.spawn(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "start", f.change], { cwd: f.root, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, CANON_ACTOR: actor } }); return p.exited; };
  const results = await Promise.all([run("agent:s7:w1"), run("agent:s8:w1")]); expect(results.sort()).toEqual([0, 1]);
  expect(["agent:s7:w1", "agent:s8:w1"]).toContain(claim(f.root, f.change)!.holder);
});
