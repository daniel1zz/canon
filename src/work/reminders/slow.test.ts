import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { agenda, dueList, type Readings } from "./agenda.ts";
import type { Slots } from "./heavy.ts";
import { testActor } from "../verify/commands.ts";

// reason: each case spawns canon or git several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const CALM: Readings = () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } });
const slots = (): Slots => ({ dir: mkdtempSync(join(tmpdir(), "canon-machine-")), gone: () => false });
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const HOUR = 3_600_000;
function cli(cwd: string, actor: string, args: readonly string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")) } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}

/** A change agent:s1 delegated to w1, which agent:s7:w1 holds; its delegation event dated `delegatedAt`. */
function delegated(delegatedAt: number) {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Slow work", "agent:s1");
  expect(cli(root, "agent:s1", ["work", "delegate", s.change, "--to", "w1"]).code).toBe(0);
  expect(cli(root, "agent:s7:w1", ["work", "start", s.change]).code).toBe(0);
  const w = ws(root);
  w.db.db.query("UPDATE events SET ts = ? WHERE subject = ? AND kind = 'delegation.create'").run(new Date(delegatedAt).toISOString(), s.change);
  w.db.close();
  return { root, ...s };
}
function event(root: string, at: number, kind: string, subject: string, detail: Record<string, unknown>) {
  const w = ws(root);
  w.db.db.query("INSERT INTO events(ts, actor, worktree, kind, subject, detail) VALUES (?, 'agent:s7:w1', ?, ?, ?, ?)").run(new Date(at).toISOString(), root, kind, subject, JSON.stringify(detail));
  w.db.close();
}
const items = (root: string, actor: string, now: number) => dueList(must(agenda(ws(root, actor), { read: CALM, slots: slots(), now })));

test("BR-2612: a delegated change past 6 hours without landing is slow, with the time queued, testing and other; 5h59m is not", () => {
  const t0 = Date.now();
  const f = delegated(t0);
  event(f.root, t0 + HOUR, "test.full.wait", f.change, { pid: 11 });
  event(f.root, t0 + 2 * HOUR, "test.full.start", f.change, { pid: 11 });
  event(f.root, t0 + 2 * HOUR + 40 * 60_000, "work.test", f.change, { failed: 0, typecheck: 0, check: 0, ms: 40 * 60_000 });
  expect(items(f.root, "agent:s1", t0 + 5 * HOUR + 59 * 60_000).some((i) => i.key === `slow:${f.change}`)).toBe(false);
  const slow = items(f.root, "agent:s1", t0 + 6 * HOUR + 10 * 60_000).find((i) => i.key === `slow:${f.change}`)!;
  expect(slow).toMatchObject({ group: "judge", tier: 1, kind: "slow" });
  expect(slow.summary).toBe("delegated to w1: 6h10m since delegated; 1 test run(s), last passed; queued 1h00m, testing 40m, other 4h30m");
  expect(slow.next).toBe(`ask the worker what blocks it, or canon work take ${f.change} and do it yourself (D-156)`);
  // only its design owner hears of it; a worker's agenda never does
  expect(items(f.root, "agent:s2", t0 + 7 * HOUR).some((i) => i.kind === "slow")).toBe(false);
  expect(items(f.root, "agent:s7:w1", t0 + 7 * HOUR).some((i) => i.kind === "slow")).toBe(false);
});

test("BR-2612: four failed test runs in a row are slow within the hour; a pass among the last four is not", () => {
  const t0 = Date.now();
  const f = delegated(t0);
  const run = (min: number, failedFiles: number) => event(f.root, t0 + min * 60_000, "work.test", f.change, { failed: failedFiles, typecheck: 0, check: 0, ms: 60_000 });
  run(5, 1); run(10, 0); run(15, 2); run(20, 1);
  expect(items(f.root, "agent:s1", t0 + HOUR).some((i) => i.key === `slow:${f.change}`)).toBe(false);
  run(25, 1);
  expect(items(f.root, "agent:s1", t0 + HOUR).some((i) => i.key === `slow:${f.change}`)).toBe(false);
  run(30, 1);
  const slow = items(f.root, "agent:s1", t0 + HOUR).find((i) => i.key === `slow:${f.change}`)!;
  expect(slow.summary).toContain("6 test run(s), last 4 failed");
});

test("BR-2612: no test run yet is said; a stalled delegation is stalled, not slow", () => {
  const t0 = Date.now();
  const f = delegated(t0);
  expect(items(f.root, "agent:s1", t0 + 7 * HOUR).find((i) => i.key === `slow:${f.change}`)!.summary).toContain("no test run yet");
  expect(cli(f.worktree, "agent:s7:w1", ["work", "stop", "--reason", "partial", "--next", "x", "--release"]).code).toBe(0);
  const keys = items(f.root, "agent:s1", t0 + 7 * HOUR).map((i) => i.key);
  expect(keys).not.toContain(`slow:${f.change}`);
});

test("BR-2613: a worker's own session running canon work test without --as writes under the worker; anyone else under itself", () => {
  const f = delegated(Date.now());
  expect(testActor(ws(f.worktree, "agent:s7")).actor).toBe("agent:s7:w1");
  expect(testActor(ws(f.worktree, "agent:s8")).actor).toBe("agent:s8");
  const own = startNew(f.root, "Main's own", "agent:s1");
  expect(testActor(ws(own.worktree, "agent:s1")).actor).toBe("agent:s1");
});
