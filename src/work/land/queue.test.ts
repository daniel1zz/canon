import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { batchCandidates, enqueue, finishEntry, joinBatch, leaveBatch, QUEUE_STALE_MS, tryTurn } from "./queue.ts";
import { selfProcess } from "../claims/liveness.ts";

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
    leaveBatch(d, c, true); // c lands on its own from now on (BR-2173)
    expect(batchCandidates(d, lead, 3).map((x) => x.id)).toEqual([b]); // stops at c, never takes e ahead of it
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
});
