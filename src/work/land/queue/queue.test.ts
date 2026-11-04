import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../../db.ts";
import { batchCandidates, enqueue, failIfActive, finishEntry, joinBatch, landBatched, leaveBatch, lockBatch, QUEUE_STALE_MS, settleLocked, tryTurn, unlockBatch, type Priority } from "./queue.ts";
import { selfProcess } from "../../claims/liveness.ts";

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-next-state-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("landing queue", () => {
  test("BR-2020: landings take turns in arrival order", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, b)).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, a)).toEqual({ mine: true, ahead: 0 });
    expect(tryTurn(d, b).mine).toBe(false); // a is landing
    finishEntry(d, a, "landed", "sha");
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2044: a lander that stopped heart-beating is skipped", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    const old = new Date(Date.now() - QUEUE_STALE_MS - 1000).toISOString();
    d.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(old, a);
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2044: the stale time comes from lander_stale_minutes: 11 minutes of silence is not stale at 30", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, a, 30 * 60_000).mine).toBe(true);
    d.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), a);
    expect(tryTurn(d, b, 30 * 60_000)).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, b, 10 * 60_000)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2144: an entry a later lander marked abandoned never takes a turn again, even once the queue is empty", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    d.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(new Date(Date.now() - QUEUE_STALE_MS - 1000).toISOString(), a);
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 });
    const woke = tryTurn(d, a);
    expect(woke.mine).toBe(false);
    expect(woke.lost).toBe("abandoned: no heartbeat");
    finishEntry(d, b, "landed", "sha");
    expect(tryTurn(d, a).mine).toBe(false);
    expect(d.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(a)?.state).toBe("abandoned");
  });
});

describe("batches", () => {
  test("BR-2172: candidates are the live waiting entries right behind the leader, in order, stopping at the first that may not join", () => {
    const d = db();
    const me = selfProcess();
    const lead = enqueue(d, "/wt/a", "C-1", "x", me);
    const b = enqueue(d, "/wt/b", "C-2", "x", me);
    const c = enqueue(d, "/wt/c", "C-3", "x", me);
    const e = enqueue(d, "/wt/e", "C-4", "x", me);
    expect(tryTurn(d, lead).mine).toBe(true);
    expect(batchCandidates(d, lead, 2).map((x) => x.id)).toEqual([b, c]);
    expect(batchCandidates(d, lead, 1).map((x) => x.id)).toEqual([b]); // land_batch_max 2: the leader and one more
    expect(joinBatch(d, lead, c, "h")).toBe(true);
    expect(leaveBatch(d, c)).toBe(true); // back in the queue, and it may join a batch again (BR-2173)
    expect(batchCandidates(d, lead, 3).map((x) => x.id)).toEqual([b, c, e]);
    expect(e).toBeGreaterThan(c);
    const silent = enqueue(d, "/wt/s", "C-5", "x"); // no lander process recorded
    expect(batchCandidates(d, e, 3)).toEqual([]); // a lander with no process recorded never joins
    expect(silent).toBeGreaterThan(e);
    const old = enqueue(d, "/wt/o", "C-6", "x", me);
    d.db.query("UPDATE queue SET solo = NULL WHERE id = ?").run(old); // queued by a canon that predates batches
    expect(batchCandidates(d, silent, 3)).toEqual([]);
  });

  test("BR-2173: a member waits while its leader lands, and waits for its own turn again once the leader stops", () => {
    const d = db();
    const me = selfProcess();
    const lead = enqueue(d, "/wt/a", "C-1", "x", me);
    const m = enqueue(d, "/wt/b", "C-2", "x", me);
    expect(tryTurn(d, lead).mine).toBe(true);
    expect(joinBatch(d, lead, m, "h1")).toBe(true);
    expect(tryTurn(d, m)).toEqual({ mine: false, ahead: 0, batched: { leader: lead, head: "h1" } });
    finishEntry(d, lead, "failed", "killed");
    expect(tryTurn(d, m)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2018 BR-2173: a locked member is unlocked once its leader is gone, so a later signal gives its entry up; while the leader lives it is kept", () => {
    const d = db();
    const me = selfProcess();
    const lead = enqueue(d, "/wt/a", "C-1", "x", me);
    const m = enqueue(d, "/wt/b", "C-2", "x", me);
    expect(tryTurn(d, lead).mine).toBe(true);
    expect(joinBatch(d, lead, m, "h1")).toBe(true);
    expect(lockBatch(d, lead, [m])).toBe(true);
    // the leader lives: the locked member's signal handler does not give its entry up, so it keeps its close commit
    expect(failIfActive(d, m, "killed", me)).toBe(false);
    // the leader is killed with SIGKILL: its process is gone
    d.db.query("UPDATE queue SET pid = ?, pid_start = ? WHERE id = ?").run(2 ** 22 + 12345, "never", lead);
    expect(tryTurn(d, m).batched).toBeUndefined();
    expect(d.db.query<{ batch: number | null }, [number]>("SELECT batch FROM queue WHERE id = ?").get(m)?.batch).toBeNull();
    // now unlocked, a signal ends it like any lander: the entry is given up and its own handler takes the close commit back
    expect(failIfActive(d, m, "killed", me)).toBe(true);
  });

  test("BR-2099 BR-2018: a signalled locked member stays locked while its leader lands, and is freed to give its entry up once the leader dies or main is settled", () => {
    const d = db();
    const me = selfProcess();
    const lead = enqueue(d, "/wt/a", "C-1", "x", me);
    const m = enqueue(d, "/wt/b", "C-2", "x", me);
    expect(tryTurn(d, lead).mine).toBe(true);
    expect(joinBatch(d, lead, m, "h1")).toBe(true);
    expect(lockBatch(d, lead, [m])).toBe(true);
    expect(settleLocked(d, m)).toBe("locked"); // main may still move with it
    d.db.query("UPDATE queue SET pid = ?, pid_start = ? WHERE id = ?").run(2 ** 22 + 12345, "never", lead); // the leader is SIGKILLed
    expect(settleLocked(d, m)).toBe("settled");
    expect(failIfActive(d, m, "killed", me)).toBe(true); // so its own handler gives it up and takes its close commit back
    const n = enqueue(d, "/wt/c", "C-3", "x", me);
    expect(settleLocked(d, n)).toBe("settled"); // not in a batch: nothing to wait for
  });

  test("BR-2173: a member does not wait behind a leader whose process is gone or that stopped beating (issue #41)", () => {
    const d = db();
    const me = selfProcess();
    const gone = enqueue(d, "/wt/a", "C-1", "x", { pid: 2 ** 22 + 12345, start: "never" });
    const m = enqueue(d, "/wt/b", "C-2", "x", me);
    d.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(gone); // killed with SIGKILL mid-batch
    expect(joinBatch(d, gone, m, "h1")).toBe(true);
    expect(tryTurn(d, m)).toEqual({ mine: true, ahead: 0 });

    const silent = enqueue(d, "/wt/c", "C-3", "x", me);
    const n = enqueue(d, "/wt/d", "C-4", "x", me);
    finishEntry(d, m, "landed", "sha");
    expect(tryTurn(d, silent).mine).toBe(true);
    expect(joinBatch(d, silent, n, "h2")).toBe(true);
    expect(tryTurn(d, n).batched).toEqual({ leader: silent, head: "h2" });
    d.db.query("UPDATE queue SET heartbeat = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(silent);
    expect(tryTurn(d, n).batched).toBeUndefined();

    const locked = enqueue(d, "/wt/l", "C-6", "x", me);
    const dying = enqueue(d, "/wt/k", "C-7", "x", me);
    finishEntry(d, silent, "failed", "x");
    finishEntry(d, n, "landed", "x");
    expect(tryTurn(d, locked).mine).toBe(true);
    expect(joinBatch(d, locked, dying, "h3") && lockBatch(d, locked, [dying])).toBe(true);
    d.db.query("UPDATE queue SET pid = ?, pid_start = 'never' WHERE id = ?").run(2 ** 22 + 12345, locked); // leader SIGKILLed after the lock
    expect(tryTurn(d, dying)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2172 BR-2099: members are locked in all or none before main moves; a locked member's signal no longer gives it up (issue #42)", () => {
    const d = db();
    const me = selfProcess();
    const lead = enqueue(d, "/wt/a", "C-1", "x", me);
    const b = enqueue(d, "/wt/b", "C-2", "x", me);
    const c = enqueue(d, "/wt/c", "C-3", "x", me);
    expect(tryTurn(d, lead).mine).toBe(true);
    expect(joinBatch(d, lead, b, "hb") && joinBatch(d, lead, c, "hc")).toBe(true);
    expect(failIfActive(d, c, "killed")).toBe(true); // c stopped before the lock
    expect(lockBatch(d, lead, [b, c])).toBe(false);
    expect(tryTurn(d, b).batched).toEqual({ leader: lead, head: "hb" }); // nothing was locked
    expect(lockBatch(d, lead, [b])).toBe(true);
    expect(tryTurn(d, b).batched).toEqual({ leader: lead, head: "hb" });
    expect(failIfActive(d, b, "killed")).toBe(false);
    expect(landBatched(d, b, "sb")).toBe(true);
    expect(tryTurn(d, b).landedBy).toEqual({ leader: lead, sha: "sb", head: "hb" });

    const e = enqueue(d, "/wt/e", "C-5", "x", me);
    expect(joinBatch(d, lead, e, "he") && lockBatch(d, lead, [e])).toBe(true);
    unlockBatch(d, lead, [e]); // main did not move after all
    expect(failIfActive(d, e, "killed")).toBe(true);
  });
});

describe("jumping the landing queue", () => {
  const urgent = (...ids: string[]): Priority => ({ urgent: new Set(ids) });

  test("BR-2232: a change listed under 优先合入 takes the turn before one that queued earlier", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, a, QUEUE_STALE_MS, urgent("C-2"))).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, b, QUEUE_STALE_MS, urgent("C-2"))).toEqual({ mine: true, ahead: 0 });
    finishEntry(d, b, "landed", "sha");
    expect(tryTurn(d, a, QUEUE_STALE_MS, urgent("C-2"))).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2232: without a priority the queue keeps arrival order", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, b, QUEUE_STALE_MS, urgent())).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, a, QUEUE_STALE_MS, urgent()).mine).toBe(true);
  });

  test("BR-2232: the fix change of a failing main goes before an urgent one, and both before the rest", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const c = enqueue(d, "/wt/c", "C-3", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    const p: Priority = { fix: "C-2", urgent: new Set(["C-3"]) };
    expect(tryTurn(d, a, QUEUE_STALE_MS, p)).toEqual({ mine: false, ahead: 2 });
    expect(tryTurn(d, c, QUEUE_STALE_MS, p)).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, b, QUEUE_STALE_MS, p)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2232: a landing under way is not interrupted by a fix change that queues after it", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    expect(tryTurn(d, a).mine).toBe(true);
    const b = enqueue(d, "/wt/b", "C-2", "x");
    const p: Priority = { fix: "C-2", urgent: new Set() };
    expect(tryTurn(d, b, QUEUE_STALE_MS, p)).toEqual({ mine: false, ahead: 1 });
    finishEntry(d, a, "landed", "sha");
    expect(tryTurn(d, b, QUEUE_STALE_MS, p).mine).toBe(true);
  });

  test("BR-2232: batch members are taken in the same order, an urgent one first", () => {
    const d = db();
    const lead = enqueue(d, "/wt/l", "C-1", "x", selfProcess());
    expect(tryTurn(d, lead).mine).toBe(true);
    const m1 = enqueue(d, "/wt/m1", "C-2", "x", selfProcess());
    const m2 = enqueue(d, "/wt/m2", "C-3", "x", selfProcess());
    expect(batchCandidates(d, lead, 1, QUEUE_STALE_MS, urgent("C-3")).map((c) => c.id)).toEqual([m2]);
    expect(batchCandidates(d, lead, 2, QUEUE_STALE_MS, urgent()).map((c) => c.id)).toEqual([m1, m2]);
  });
});
