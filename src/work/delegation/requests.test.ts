import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
/** C-n delegated by agent:s1 to w1 and claimed by agent:s7:w1 in another session. */
function fixture() {
  const root = project(); roots.push(root); mkdirSync(join(root, "canon"), { recursive: true }); writeFileSync(join(root, "canon/product.md"), "# Product\n\nFirst design.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Worker task", "agent:s1");
  expect(cli(root, "agent:s1", "work", "delegate", s.change, "--to", "w1").code).toBe(0);
  expect(cli(root, "agent:s7:w1", "work", "start", s.change).code).toBe(0);
  return { root, ...s };
}
function request(root: string, id: number) {
  const w = ws(root); try { return w.db.db.query<{ status: string; answer: string | null; main: string | null; asked_by: string }, [number]>("SELECT status, answer, main, asked_by FROM design_requests WHERE id = ?").get(id); } finally { w.db.close(); }
}
function events(root: string, kind: string) {
  const w = ws(root); try { return w.db.db.query<{ actor: string; detail: string }, [string]>("SELECT actor, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e) => ({ ...JSON.parse(e.detail), actor: e.actor })); } finally { w.db.close(); }
}
function claimOf(root: string, change: string) {
  const w = ws(root); try { return w.db.db.query<{ holder: string; delegation_epoch: number | null }, [string]>("SELECT holder, delegation_epoch FROM claims WHERE subject = ?").get(change); } finally { w.db.close(); }
}

test("BR-2499: the worker holding a delegated change records a pending request the design owner's brief and status list", () => {
  const f = fixture();
  const r = cli(f.worktree, "agent:s7:w1", "work", "need-design", f.change, "BR-50 does not say what happens when the target is lost; pathfinding stops");
  expect(r.code).toBe(0); expect(r.text).toContain("#1"); expect(r.text).toContain("agent:s1");
  expect(request(f.root, 1)).toMatchObject({ status: "pending", asked_by: "agent:s7:w1" });
  expect(events(f.root, "design.request")).toEqual([expect.objectContaining({ actor: "agent:s7:w1", request: 1, owner: "agent:s1" })]);
  expect(claimOf(f.root, f.change)).toMatchObject({ holder: "agent:s7:w1", delegation_epoch: 1 });
  const brief = cli(f.root, "agent:s1", "brief"); expect(brief.code).toBe(0); expect(brief.text).toContain("Design request #1"); expect(brief.text).toContain("target is lost");
  const status = cli(f.root, "agent:s1", "work", "status"); expect(status.text).toContain("#1"); expect(status.text).toContain("design owner agent:s1");
  expect(cli(f.root, "agent:s2", "brief").text).not.toContain("Design request #1");
});

test("BR-2499: the design owner answers after landing the design and redelegates; the worker's brief shows the answer and new revision and it must accept", () => {
  const f = fixture();
  expect(cli(f.worktree, "agent:s7:w1", "work", "need-design", f.change, "lost target undecided").code).toBe(0);
  writeFileSync(join(f.root, "canon/product.md"), readFileSync(join(f.root, "canon/product.md"), "utf8") + "\nLost targets are dropped.\n"); sh(f.root, "commit", "-qam", "design");
  const main = sh(f.root, "rev-parse", "main");
  const a = cli(f.root, "agent:s1", "work", "design-answer", "1", "Written into the product"); expect(a.code).toBe(0);
  expect(request(f.root, 1)).toMatchObject({ status: "answered", answer: "Written into the product", main });
  expect(events(f.root, "design.answer")).toEqual([expect.objectContaining({ request: 1, answer: "Written into the product", main })]);
  expect(cli(f.root, "agent:s1", "work", "delegate", f.change, "--to", "w1").code).toBe(0);
  expect(claimOf(f.root, f.change)).toMatchObject({ holder: "agent:s7:w1", delegation_epoch: 1 });
  const brief = cli(f.worktree, "agent:s7:w1", "brief");
  expect(brief.text).toContain("#1 (answered"); expect(brief.text).toContain("Written into the product"); expect(brief.text).toContain(`revision ${main}`); expect(brief.text).toContain("accept-design");
  const accepted = cli(f.worktree, "agent:s7:w1", "work", "accept-design", f.change); expect(accepted.code).toBe(0); expect(accepted.text).toContain("#1");
  expect(claimOf(f.root, f.change)?.delegation_epoch).toBe(2);
});

test("BR-2499: a request follows the change to a new design owner; only the current owner answers, and only once", () => {
  const f = fixture();
  expect(cli(f.worktree, "agent:s7:w1", "work", "need-design", f.change, "pending question").code).toBe(0);
  // agent:s1's session ended; agent:s2 redelegates the change once the worker let it go
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--reason", "partial", "--next", "wait", "--release").code).toBe(0);
  expect(cli(f.root, "agent:s2", "work", "delegate", f.change, "--to", "w1").code).toBe(0);
  expect(cli(f.root, "agent:s2", "brief").text).toContain("Design request #1");
  expect(cli(f.root, "agent:s1", "brief").text).not.toContain("Design request #1");
  expect(cli(f.root, "agent:s1", "work", "design-answer", "1", "x").code).toBe(2);
  expect(request(f.root, 1)?.status).toBe("pending");
  expect(cli(f.root, "agent:s2", "work", "design-answer", "1", "decided").code).toBe(0);
  const again = cli(f.root, "agent:s2", "work", "design-answer", "1", "changed my mind"); expect(again.code).toBe(5);
  expect(request(f.root, 1)?.answer).toBe("decided");
  expect(cli(f.root, "agent:s2", "work", "design-answer", "9", "x").code).toBe(3);
});

test("BR-2499 BR-2022: need-design refuses the main session, an empty request and an undelegated change", () => {
  const f = fixture();
  expect(cli(f.root, "agent:s1", "work", "need-design", f.change, "x").code).toBe(2);
  expect(cli(f.worktree, "agent:s7:w1", "work", "need-design", f.change, "").code).toBe(2);
  expect(cli(f.worktree, "agent:s7:w1", "work", "need-design", f.change, "   ").code).toBe(2);
  expect(cli(f.root, "agent:s8:w1", "work", "need-design", f.change, "x").code).toBe(2);
  const other = startNew(f.root, "Not delegated", "agent:s1");
  expect(cli(f.root, "agent:s7:w1", "work", "need-design", other.change, "x").code).toBe(3);
  expect(events(f.root, "design.request")).toEqual([]);
});
