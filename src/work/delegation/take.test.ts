import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processOf } from "../claims/liveness.ts";
import { project, sh, startNew, ws } from "../testkit.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
/** A process that certainly is not running: this pid with a start time it never had. */
const GONE = { pid: process.pid, start: "Thu Jan  1 00:00:00 1970" };
const ALIVE = () => { const p = processOf(process.pid); if (!p) throw new Error("cannot read this process"); return p; };

/** C-n delegated by agent:s1 to w1 and claimed by `worker` (another session's agent:s7:w1 by default). */
function fixture(worker = "agent:s7:w1") {
  const root = project(); roots.push(root); mkdirSync(join(root, "canon"), { recursive: true }); writeFileSync(join(root, "canon/product.md"), "# Product\n\nFirst design.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Worker task", "agent:s1");
  expect(cli(root, "agent:s1", "work", "delegate", s.change, "--to", "w1").code).toBe(0);
  expect(cli(root, worker, "work", "start", s.change).code).toBe(0);
  return { root, ...s };
}
function setClaim(root: string, change: string, proc: { pid: number; start: string } | null, expires?: string) {
  const w = ws(root);
  try {
    w.db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(proc?.pid ?? null, proc?.start ?? null, change);
    if (expires) w.db.db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run(expires, change);
  } finally { w.db.close(); }
}
function state(root: string, change: string) {
  const w = ws(root);
  try {
    return {
      claim: w.db.db.query<{ holder: string; delegation_epoch: number | null; expires_at: string }, [string]>("SELECT holder, delegation_epoch, expires_at FROM claims WHERE subject = ?").get(change),
      delegation: w.db.db.query<{ epoch: number; ended: string | null }, [string]>("SELECT epoch, ended FROM delegations WHERE subject = ?").get(change),
    };
  } finally { w.db.close(); }
}
function events(root: string, kind: string) {
  const w = ws(root); try { return w.db.db.query<{ actor: string; detail: string }, [string]>("SELECT actor, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e) => ({ ...JSON.parse(e.detail), actor: e.actor })); } finally { w.db.close(); }
}

test("BR-2500 BR-2498 BR-2501: the design owner takes back a worker of another process that has exited; the old epoch can no longer stop, drop or land", () => {
  const f = fixture(); setClaim(f.root, f.change, GONE);
  const r = cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1");
  expect(r.code).toBe(0); expect(r.text).toContain(f.worktree);
  const s = state(f.root, f.change);
  expect(s.claim).toMatchObject({ holder: "agent:s1", delegation_epoch: null }); expect(new Date(s.claim!.expires_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
  expect(s.delegation?.epoch).toBe(2); expect(s.delegation?.ended).not.toBeNull();
  const handover = events(f.root, "claim.handover"); expect(handover).toEqual([expect.objectContaining({ actor: "agent:s1", from: "agent:s7:w1", by: "design-owner", epoch: 2 })]); expect(handover[0].stopped).toBeUndefined();
  const main = sh(f.root, "rev-parse", "main");
  writeFileSync(join(f.worktree, "app.txt"), "late worker edit\n"); sh(f.worktree, "commit", "-qam", "late");
  expect(cli(f.worktree, "agent:s7:w1", "work", "land").code).toBe(5);
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--reason", "partial", "--next", "x", "--release").code).toBe(5);
  expect(cli(f.root, "agent:s7:w1", "work", "drop", f.change).code).toBe(5);
  expect(sh(f.root, "rev-parse", "main")).toBe(main); expect(state(f.root, f.change).claim?.holder).toBe("agent:s1");
});

test("BR-2500: a worker whose process still runs in another session is not taken back, with or without --stopped", () => {
  const f = fixture(); setClaim(f.root, f.change, ALIVE());
  const before = state(f.root, f.change);
  const r = cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1"); expect(r.code).toBe(5); expect(r.text).toContain("--stopped");
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1", "--stopped").code).toBe(5);
  expect(state(f.root, f.change)).toEqual(before); expect(events(f.root, "claim.handover")).toEqual([]);
});

test("BR-2500: a claim with no recorded process needs --stopped, and the handover records it as asserted", () => {
  const f = fixture(); setClaim(f.root, f.change, null);
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1").code).toBe(5);
  expect(state(f.root, f.change).claim?.holder).toBe("agent:s7:w1");
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1", "--stopped").code).toBe(0);
  expect(state(f.root, f.change).claim?.holder).toBe("agent:s1");
  expect(events(f.root, "claim.handover")).toEqual([expect.objectContaining({ from: "agent:s7:w1", by: "design-owner", stopped: "asserted" })]);
});

test("BR-2500 BR-2336: a delegated subagent of the owner's own session sharing its process is taken back only with --stopped", () => {
  const f = fixture("agent:s1:w1"); setClaim(f.root, f.change, ALIVE());
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1").code).toBe(5);
  expect(state(f.root, f.change).claim?.holder).toBe("agent:s1:w1");
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1", "--stopped").code).toBe(0);
  expect(state(f.root, f.change)).toMatchObject({ claim: { holder: "agent:s1" }, delegation: { epoch: 2 } });
  expect(events(f.root, "claim.handover")).toEqual([expect.objectContaining({ from: "agent:s1:w1", by: "design-owner", stopped: "asserted" })]);
});

test("BR-2500: a landing still queued blocks the take until it ends", () => {
  const f = fixture(); setClaim(f.root, f.change, GONE);
  const lander = ALIVE();
  let w = ws(f.root);
  const now = new Date().toISOString();
  const id = Number(w.db.db.query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat, pid, pid_start) VALUES (?, ?, 'waiting', ?, ?, ?, ?)").run(f.worktree, f.change, now, now, lander.pid, lander.start).lastInsertRowid);
  w.db.close();
  const r = cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1"); expect(r.code).toBe(5); expect(r.text).toContain("queued");
  expect(state(f.root, f.change).claim?.holder).toBe("agent:s7:w1");
  w = ws(f.root); w.db.db.query("UPDATE queue SET state = 'failed' WHERE id = ?").run(id); w.db.close();
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1").code).toBe(0);
});

test("BR-2500 BR-2022: anyone but the current design owner is refused with a claim.refuse, and an invalid --from is a usage error", () => {
  const f = fixture(); setClaim(f.root, f.change, GONE);
  const before = state(f.root, f.change);
  expect(cli(f.root, "agent:s2", "work", "take", f.change, "--from", "w1").code).toBe(5);
  expect(state(f.root, f.change)).toEqual(before);
  expect(events(f.root, "claim.refuse")).toEqual([expect.objectContaining({ actor: "agent:s2", reason: "handover" })]);
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w 1").code).toBe(2);
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w2").code).toBe(5);
  expect(state(f.root, f.change)).toEqual(before);
});

test("BR-2500 BR-2100 BR-2104: a lapsed delegated claim passes to no one but its design owner, and to the owner as a take", () => {
  const f = fixture(); setClaim(f.root, f.change, GONE);
  const before = state(f.root, f.change);
  expect(cli(f.root, "agent:s2", "work", "start", f.change).code).toBe(5);
  expect(cli(f.worktree, "agent:s2", "work", "land").code).toBe(5);
  expect(cli(f.worktree, "agent:s2", "work", "stop", "--reason", "partial", "--next", "x", "--release").code).toBe(5);
  expect(state(f.root, f.change)).toEqual(before); expect(events(f.root, "claim.take").filter((e) => e.from)).toEqual([]);
  writeFileSync(join(f.worktree, "app.txt"), "owner finishes\n"); sh(f.worktree, "commit", "-qam", "finish");
  const r = cli(f.worktree, "agent:s1", "work", "land"); expect(r).toMatchObject({ code: 0 });
  expect(events(f.root, "claim.handover")).toEqual([expect.objectContaining({ actor: "agent:s1", from: "agent:s7:w1", by: "design-owner", epoch: 2 })]);
  expect(state(f.root, f.change).delegation).toMatchObject({ epoch: 2 });
  expect(sh(f.root, "show", "main:app.txt")).toBe("owner finishes");
});

test("BR-2500 BR-2100: an expired lease on a delegated change goes to the owner's start as a take", () => {
  const f = fixture(); setClaim(f.root, f.change, null, "2000-01-01T00:00:00.000Z");
  expect(cli(f.root, "agent:s2", "work", "start", f.change).code).toBe(5);
  expect(cli(f.root, "agent:s1", "work", "start", f.change).code).toBe(0);
  expect(state(f.root, f.change)).toMatchObject({ claim: { holder: "agent:s1", delegation_epoch: null }, delegation: { epoch: 2 } });
  expect(events(f.root, "claim.handover")).toEqual([expect.objectContaining({ from: "agent:s7:w1", by: "design-owner" })]);
});

test("BR-2500 BR-2100 BR-2104: a lapsed lease whose worker process still runs in another session is not taken over automatically, and --stopped is refused too", () => {
  const f = fixture(); setClaim(f.root, f.change, ALIVE(), "2000-01-01T00:00:00.000Z");
  const before = state(f.root, f.change);
  for (const [cwd, args] of [[f.root, ["work", "start", f.change]], [f.worktree, ["work", "land"]], [f.worktree, ["work", "stop", "--reason", "partial", "--next", "x", "--release"]]] as const) {
    const r = cli(cwd, "agent:s1", ...args);
    expect(r.code).toBe(5); expect(r.text).toContain("still running"); expect(r.text).toContain(`canon work take ${f.change} --from w1 --stopped`);
  }
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1", "--stopped").code).toBe(5);
  expect(state(f.root, f.change)).toEqual(before); expect(events(f.root, "claim.handover")).toEqual([]);
  expect(events(f.root, "claim.refuse").filter((e) => e.reason === "delegated")).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "agent:s1", process: "alive" })]));
});

test("BR-2500 BR-2100: a lapsed lease of the owner's own subagent whose shared process still runs needs take --stopped, not an automatic takeover", () => {
  const f = fixture("agent:s1:w1"); setClaim(f.root, f.change, ALIVE(), "2000-01-01T00:00:00.000Z");
  const r = cli(f.root, "agent:s1", "work", "start", f.change);
  expect(r.code).toBe(5); expect(r.text).toContain(`canon work take ${f.change} --from w1 --stopped`);
  expect(state(f.root, f.change)).toMatchObject({ claim: { holder: "agent:s1:w1" }, delegation: { epoch: 1, ended: null } });
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1", "--stopped").code).toBe(0);
  expect(state(f.root, f.change)).toMatchObject({ claim: { holder: "agent:s1" }, delegation: { epoch: 2 } });
});

test("BR-2500: a claim whose recorded process is gone is taken over automatically even before its lease ends; with no recorded process only an expired lease counts as stopped", () => {
  const f = fixture(); setClaim(f.root, f.change, null);
  expect(cli(f.root, "agent:s1", "work", "start", f.change).code).toBe(5);
  expect(state(f.root, f.change).claim?.holder).toBe("agent:s7:w1");
  setClaim(f.root, f.change, GONE);
  expect(cli(f.root, "agent:s1", "work", "start", f.change).code).toBe(0);
  expect(state(f.root, f.change)).toMatchObject({ claim: { holder: "agent:s1" }, delegation: { epoch: 2 } });
});

test("BR-2500: a worker that released its claim leaves nothing to hand over; the owner's take still ends the delegation, and keeps a claim the owner holds by then", () => {
  const f = fixture(); setClaim(f.root, f.change, GONE);
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--reason", "design", "--next", "proposals to apply", "--release").code).toBe(0);
  expect(state(f.root, f.change).claim).toBeNull();
  // a take from a name the change is not delegated to changes nothing
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w2").code).toBe(5);
  expect(state(f.root, f.change).delegation?.ended).toBeNull();
  const r = cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1");
  expect(r.code).toBe(0); expect(r.text).toContain(`canon work start ${f.change}`);
  const s = state(f.root, f.change);
  expect(s.claim).toBeNull(); expect(s.delegation?.epoch).toBe(2); expect(s.delegation?.ended).not.toBeNull();
  expect(events(f.root, "claim.handover")).toEqual([expect.objectContaining({ actor: "agent:s1", from: "w1", by: "design-owner", epoch: 2, claim: "none" })]);
  expect(cli(f.root, "agent:s1", "work", "start", f.change).code).toBe(0);
  expect(state(f.root, f.change).claim?.holder).toBe("agent:s1");

  // the owner already holds the claim again while the delegation is still in force
  const g = fixture(); setClaim(g.root, g.change, GONE);
  expect(cli(g.worktree, "agent:s7:w1", "work", "stop", "--reason", "design", "--next", "x", "--release").code).toBe(0);
  expect(cli(g.root, "agent:s1", "work", "start", g.change).code).toBe(0);
  expect(state(g.root, g.change).delegation?.ended).toBeNull();
  expect(cli(g.root, "agent:s1", "work", "take", g.change, "--from", "w1").code).toBe(0);
  const t = state(g.root, g.change);
  expect(t.claim?.holder).toBe("agent:s1"); expect(t.delegation?.ended).not.toBeNull();
  expect(events(g.root, "claim.handover")).toEqual([expect.objectContaining({ claim: "owner", epoch: 2 })]);
});

test("BR-2500: with the worker's claim released, a landing of the change still queued blocks ending the delegation until it ends", () => {
  const f = fixture(); setClaim(f.root, f.change, GONE);
  expect(cli(f.worktree, "agent:s7:w1", "work", "stop", "--reason", "design", "--next", "x", "--release").code).toBe(0);
  const lander = ALIVE();
  let w = ws(f.root);
  const now = new Date().toISOString();
  const id = Number(w.db.db.query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat, pid, pid_start) VALUES (?, ?, 'waiting', ?, ?, ?, ?)").run(f.worktree, f.change, now, now, lander.pid, lander.start).lastInsertRowid);
  w.db.close();
  const r = cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1");
  expect(r.code).toBe(5); expect(r.text).toContain("queued");
  expect(state(f.root, f.change).delegation?.ended).toBeNull();
  w = ws(f.root); w.db.db.query("UPDATE queue SET state = 'failed' WHERE id = ?").run(id); w.db.close();
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1").code).toBe(0);
  expect(state(f.root, f.change).delegation?.ended).not.toBeNull();
});
