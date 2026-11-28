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
const GONE = { pid: process.pid, start: "Thu Jan  1 00:00:00 1970" };
const ALIVE = () => { const p = processOf(process.pid); if (!p) throw new Error("cannot read this process"); return p; };

/** C-n delegated by agent:s1 to w1 and claimed by another session's worker agent:s7:w1. */
function fixture() {
  const root = project(); roots.push(root); mkdirSync(join(root, "canon"), { recursive: true }); writeFileSync(join(root, "canon/product.md"), "# Product\n\nFirst design.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Worker task", "agent:s1");
  expect(cli(root, "agent:s1", "work", "delegate", s.change, "--to", "w1").code).toBe(0);
  expect(cli(root, "agent:s7:w1", "work", "start", s.change).code).toBe(0);
  return { root, ...s };
}
function setProc(root: string, change: string, proc: { pid: number; start: string } | null) {
  const w = ws(root);
  try { w.db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(proc?.pid ?? null, proc?.start ?? null, change); } finally { w.db.close(); }
}
function owner(root: string, change: string) {
  const w = ws(root);
  try {
    return {
      owner: w.db.db.query<{ owner: string; epoch: number }, [string]>("SELECT owner, epoch FROM delegations WHERE subject = ?").get(change),
      holder: w.db.db.query<{ holder: string }, [string]>("SELECT holder FROM claims WHERE subject = ?").get(change)?.holder,
      adopts: w.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'delegation.adopt' AND subject = ?").all(change).map((r) => JSON.parse(r.detail) as { from: string; to: string; gone: string }),
    };
  } finally { w.db.close(); }
}

test("BR-2646: with no recorded process of the old owner, adopt needs --gone; it moves the design owner only, and the new owner can then take back", () => {
  const { root, change } = fixture();
  const before = owner(root, change);
  const refused = cli(root, "agent:s2", "work", "adopt", "--from", "agent:s1");
  expect(refused.code).toBe(5);
  expect(refused.text).toContain("--gone");
  expect(owner(root, change).owner?.owner).toBe("agent:s1");

  const r = cli(root, "agent:s2", "work", "adopt", "--from", "agent:s1", "--gone");
  expect(r.code).toBe(0);
  expect(r.text).toContain(change);
  const after = owner(root, change);
  expect(after.owner).toEqual({ owner: "agent:s2", epoch: before.owner!.epoch });
  expect(after.holder).toBe("agent:s7:w1");
  expect(after.adopts).toEqual([{ from: "agent:s1", to: "agent:s2", gone: "asserted" }]);

  setProc(root, change, GONE);
  expect(cli(root, "agent:s1", "work", "take", change, "--from", "w1").code).toBe(5);
  expect(cli(root, "agent:s2", "work", "take", change, "--from", "w1").code).toBe(0);
});

test("BR-2646: a recorded process of the old owner that is gone proves it ended; one still running refuses even with --gone", () => {
  const { root, change } = fixture();
  const other = startNew(root, "Owner's own work", "agent:s1");
  setProc(root, other.change, ALIVE());
  const alive = cli(root, "agent:s2", "work", "adopt", change, "--from", "agent:s1", "--gone");
  expect(alive.code).toBe(5);
  expect(alive.text).toContain("still running");
  expect(owner(root, change).owner?.owner).toBe("agent:s1");

  setProc(root, other.change, GONE);
  expect(cli(root, "agent:s2", "work", "adopt", change, "--from", "agent:s1").code).toBe(0);
  expect(owner(root, change).adopts).toEqual([{ from: "agent:s1", to: "agent:s2", gone: "proven" }]);
});

test("BR-2646: a change that is not the old owner's delegation in force, a worker as runner, or a malformed --from changes nothing", () => {
  const { root, change } = fixture();
  expect(cli(root, "agent:s2", "work", "adopt", "C-999", "--from", "agent:s1", "--gone").code).toBe(5);
  expect(cli(root, "agent:s2", "work", "adopt", "--from", "agent:s2", "--gone").code).toBe(5);
  expect(cli(root, "agent:s7:w1", "work", "adopt", "--from", "agent:s1", "--gone").code).toBe(2);
  expect(cli(root, "agent:s2", "work", "adopt", "--from", "s1", "--gone").code).toBe(2);
  expect(owner(root, change).owner?.owner).toBe("agent:s1");
});

test("BR-2500: take by a session that is not the design owner names canon work adopt", () => {
  const { root, change } = fixture();
  setProc(root, change, GONE);
  const r = cli(root, "agent:s2", "work", "take", change, "--from", "w1");
  expect(r.code).toBe(5);
  expect(r.text).toContain(`canon work adopt ${change} --from agent:s1`);
});

function due(root: string, actor: string): { key: string; next: string }[] {
  const r = cli(root, actor, "work", "due", "--json");
  const d = JSON.parse(r.text.slice(r.text.indexOf("{"))) as { judge?: { key: string; next: string }[] };
  return (d.judge ?? []).filter((it) => it.key.startsWith("adopt:"));
}
function quiet(root: string, actor: string, hours: number) {
  const w = ws(root);
  try { w.db.db.query("UPDATE events SET ts = ? WHERE actor = ?").run(new Date(Date.now() - hours * 3600_000).toISOString(), actor); } finally { w.db.close(); }
}

test("BR-2647: the agenda offers adoption of an owner canon cannot see only after it has been quiet 6 hours; not to a worker; gone once adopted", () => {
  const { root } = fixture();
  expect(due(root, "agent:s2")).toEqual([]);
  quiet(root, "agent:s1", 8);
  const items = due(root, "agent:s2");
  expect(items.map((i) => i.key)).toEqual(["adopt:agent:s1"]);
  expect(items[0]!.next).toContain("canon work adopt --from agent:s1 --gone");
  expect(due(root, "agent:s7:w1")).toEqual([]);
  expect(cli(root, "agent:s2", "work", "adopt", "--from", "agent:s1", "--gone").code).toBe(0);
  expect(due(root, "agent:s2")).toEqual([]);
});

test("BR-2647: an owner whose recorded process is gone is offered at once without --gone; one whose process runs is not", () => {
  const { root } = fixture();
  const other = startNew(root, "Owner's own work", "agent:s1");
  setProc(root, other.change, ALIVE());
  quiet(root, "agent:s1", 8);
  expect(due(root, "agent:s2")).toEqual([]);
  setProc(root, other.change, GONE);
  const items = due(root, "agent:s2");
  expect(items.map((i) => i.key)).toEqual(["adopt:agent:s1"]);
  expect(items[0]!.next).not.toContain("--gone");
});
