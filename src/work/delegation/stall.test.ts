import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processOf } from "../claims/liveness.ts";
import { project, sh, startNew, ws } from "../testkit.ts";
import { stalledDelegations } from "../../knowledge/changes/state.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")) } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
/** A process that certainly is not running: this pid with a start time it never had. */
const GONE = { pid: process.pid, start: "Thu Jan  1 00:00:00 1970" };
const HOUR = 3_600_000;

/** A plan C-1 with step A on main, and a change doing step A, delegated by agent:s1 to w1 and claimed by agent:s7:w1. */
function fixture() {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nFirst design.\n");
  writeFileSync(join(root, "canon/changes.keep"), "");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const plan = startNew(root, "Plan", "agent:s1");
  const dir = join(plan.worktree, "canon/changes");
  const file = join(dir, readdirSync(dir).find((n) => n.startsWith(`${plan.change}`) && n.endsWith(".md"))!);
  writeFileSync(file, readFileSync(file, "utf8").replace("## 为什么", "## 计划\n\n| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| A | do a | - |\n\n## 为什么"));
  sh(plan.worktree, "commit", "-qam", "plan");
  expect(cli(plan.worktree, "agent:s1", "work", "land", "--finish").code).toBe(0);
  expect(cli(root, "agent:s1", "work", "start", "--title", "Step A", "--plan", plan.change, "--step", "A").code).toBe(0);
  const step = ws(root).db.db.query<{ subject: string }, []>("SELECT subject FROM claims WHERE holder = 'agent:s1' ORDER BY subject DESC LIMIT 1").get()!.subject;
  expect(cli(root, "agent:s1", "work", "delegate", step, "--to", "w1").code).toBe(0);
  expect(cli(root, "agent:s7:w1", "work", "start", step).code).toBe(0);
  return { root, plan: plan.change, step };
}
function setClaimProcess(root: string, change: string, proc: { pid: number; start: string }) {
  const w = ws(root);
  try { w.db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(proc.pid, proc.start, change); } finally { w.db.close(); }
}

test("BR-2522: a delegated change whose worker process is gone and whose branch has had no commit for delegation_stall_minutes is stalled; a live worker or a recent commit is not", () => {
  const f = fixture();
  // a live worker: not stalled however old the branch is
  const live = processOf(process.pid)!;
  setClaimProcess(f.root, f.step, live);
  expect(stalledDelegations(ws(f.root), Date.now() + 2 * HOUR)).toEqual({ ok: true, value: [] });
  // the worker's process is gone: stalled once the default 60 minutes have passed, not before
  setClaimProcess(f.root, f.step, GONE);
  expect(stalledDelegations(ws(f.root), Date.now())).toEqual({ ok: true, value: [] });
  const later = stalledDelegations(ws(f.root), Date.now() + 2 * HOUR);
  expect(later.ok && later.value.map((s) => [s.subject, s.worker, s.owner])).toEqual([[f.step, "w1", "agent:s1"]]);
  expect(later.ok && later.value[0]!.lastCommit).toBeDefined();
});

test("BR-2522 BR-2505 BR-2529 BR-2372 BR-2373 BR-2374: canon work status, canon overview and canon plan status show the stalled delegation and its plan step as stalled", () => {
  const f = fixture();
  setClaimProcess(f.root, f.step, GONE);
  // a stall threshold far below the time the fixture took, so the CLI sees it stalled now
  appendFileSync(join(f.root, "canon/config.yaml"), "delegation_stall_minutes: 0.0001\n");
  sh(f.root, "commit", "-qam", "stall threshold");
  const status = cli(f.root, "agent:s1", "work", "status");
  expect(status.code).toBe(0);
  expect(status.text).toContain(`${f.step}: stalled: delegated to w1, no live worker and no commit since`);
  expect(status.text).toContain(`design owner agent:s1: delegate it again (canon work delegate ${f.step} --to <name>) or take it over (canon work take ${f.step})`);
  const overview = cli(f.root, "agent:s1", "overview");
  expect(overview.text).toMatch(new RegExp(`## 议程\\n[\\s\\S]*judge: 1: stalled:${f.step}`));
  // the brief of a session with no claimed change carries it in the agenda summary (BR-2529)
  const brief = cli(f.root, "agent:s9", "brief");
  expect(brief.text).toContain(`  judge: 1: stalled:${f.step}`);
  const plan = cli(f.root, "agent:s1", "plan", "status", f.plan);
  expect(plan.text).toContain("停滞 1");
  expect(plan.text).toContain(`停滞: A (${f.step})`);
  const json = JSON.parse(cli(f.root, "agent:s1", "plan", "status", f.plan, "--json").text) as { stalled: number; working: number };
  expect([json.stalled, json.working]).toEqual([1, 0]);
  const detail = JSON.parse(cli(f.root, "agent:s1", "plan", "status", f.plan, "--json").text) as { steps: { step: string; state: string }[] };
  expect(detail.steps.map((x) => [x.step, x.state])).toEqual([["A", "stalled"]]);
});

test("BR-2522: a delegated change already closed on main is not stalled, whatever its delegation record says (#264)", () => {
  const f = fixture();
  setClaimProcess(f.root, f.step, GONE);
  expect(stalledDelegations(ws(f.root), Date.now() + 2 * HOUR).ok ? (stalledDelegations(ws(f.root), Date.now() + 2 * HOUR) as { value: { subject: string }[] }).value.map((s) => s.subject) : []).toEqual([f.step]);
  // close it on main by hand, leaving the delegation in force, as a landing that did not end it does
  const file = join(f.root, "canon/changes", readdirSync(join(f.root, "canon/changes")).find((n) => n.startsWith(`${f.step}`) && n.endsWith(".md")) ?? `${f.step}.md`);
  writeFileSync(file, `---\nid: ${f.step}\ntitle: Step A\nstatus: done\n---\n\n## 为什么\n\nA.\n\n## 要改什么\n\nA.\n`);
  sh(f.root, "add", "-A"); sh(f.root, "commit", "-qm", `close ${f.step}`);
  expect(stalledDelegations(ws(f.root), Date.now() + 2 * HOUR)).toEqual({ ok: true, value: [] });
  expect(cli(f.root, "agent:s1", "work", "status").text).not.toContain(`${f.step}: stalled`);
});

test("BR-2497: canon work status lists a delegation record until its change is closed on main, then no longer", () => {
  const f = fixture();
  expect(cli(f.root, "agent:s1", "work", "status").text).toContain(`${f.step}: delegated to w1; design owner agent:s1`);
  // close it on main by hand, leaving the delegation in force, as a landing does (#264)
  const file = join(f.root, "canon/changes", readdirSync(join(f.root, "canon/changes")).find((n) => n.startsWith(`${f.step}`) && n.endsWith(".md")) ?? `${f.step}.md`);
  writeFileSync(file, `---\nid: ${f.step}\ntitle: Step A\nstatus: done\n---\n\n## 为什么\n\nA.\n\n## 要改什么\n\nA.\n`);
  sh(f.root, "add", "-A"); sh(f.root, "commit", "-qm", `close ${f.step}`);
  const status = cli(f.root, "agent:s1", "work", "status");
  expect(status.code).toBe(0);
  expect(status.text).not.toContain(`${f.step}: delegated to`);
});
