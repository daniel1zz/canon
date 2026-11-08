import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../../db.ts";
import { enqueue, enter, keptPlaces, NO_PRIORITY, tryTurn } from "./queue.ts";

/** An entry another lander marks abandoned keeps its place until its last heartbeat plus the keep time (BR-2380, D-75). */

const MIN = 60_000;
const KEEP = { ms: 15 * MIN, actor: "agent:b" };
const STALE = 10 * MIN;
const GONE = { pid: 2 ** 22 + 12345, start: "never" }; // a process that does not exist
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-keep-abandoned-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const row = (d: CoordDb, id: number) => d.db.query<{ state: string; result: string | null; keep_until: string | null; heartbeat: string }, [number]>("SELECT state, result, keep_until, heartbeat FROM queue WHERE id = ?").get(id)!;
const beat = (d: CoordDb, id: number, ms: number) => d.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(ago(ms), id);
const eventsOf = (d: CoordDb, kind: string) => d.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e) => JSON.parse(e.detail) as Record<string, unknown>);

describe("an entry another lander marks abandoned", () => {
  test("BR-2380: lander process gone, it keeps its place until its last heartbeat plus the keep time, and its own landing takes it back once", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-2", "x", GONE);
    const b = enqueue(d, "/wt/b", "C-3", "x");
    beat(d, a, 2 * MIN); // it last beat two minutes ago
    const last = row(d, a).heartbeat;
    expect(tryTurn(d, b, STALE, NO_PRIORITY, KEEP)).toEqual({ mine: true, ahead: 0 });
    expect(row(d, a)).toMatchObject({ state: "abandoned", result: "lander process gone", keep_until: new Date(Date.parse(last) + KEEP.ms).toISOString() });
    expect(eventsOf(d, "queue.abandon")).toEqual([{ entry: a, worktree: "/wt/a", reason: "lander process gone", keeps_place_until: row(d, a).keep_until }]);
    expect(keptPlaces(d).map((e) => [e.id, e.state])).toEqual([[a, "resolving"]]);
    const later = enqueue(d, "/wt/later", "C-4", "x");
    const back = enter(d, "/wt/a", "C-2", "x");
    expect(back).toMatchObject({ id: a, kept: { after: "abandoned" } });
    expect(back.kept!.resolveMs).toBeGreaterThanOrEqual(2 * MIN);
    expect(eventsOf(d, "queue.enter").at(-1)).toMatchObject({ kept_place: a, kept_after: "abandoned" });
    expect(enter(d, "/wt/a", "C-2", "x").id).toBeGreaterThan(later); // taken back once
    expect(tryTurn(d, a)).toEqual({ mine: false, ahead: 1 }); // b is landing: not interrupted (BR-2178)
  });

  test("BR-2380: no heartbeat, it keeps its place from its last heartbeat, so less than the full time is left", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-2", "x");
    const b = enqueue(d, "/wt/b", "C-3", "x");
    beat(d, a, 4 * MIN);
    const last = row(d, a).heartbeat;
    expect(tryTurn(d, b, 3 * MIN, NO_PRIORITY, KEEP).mine).toBe(true); // stale after 3 minutes
    expect(row(d, a)).toMatchObject({ state: "abandoned", result: "no heartbeat", keep_until: new Date(Date.parse(last) + KEEP.ms).toISOString() });
    expect(Date.parse(row(d, a).keep_until!) - Date.now()).toBeLessThan(11 * MIN + 1000); // 15 minus the 4 it was silent
    expect(eventsOf(d, "queue.abandon")[0]).toMatchObject({ entry: a, reason: "no heartbeat" });
    const later = enqueue(d, "/wt/later", "C-4", "x");
    expect(enter(d, "/wt/a", "C-2", "x")).toMatchObject({ id: a, kept: { after: "abandoned" } });
    expect(enter(d, "/wt/later2", "C-5", "x").id).toBeGreaterThan(later);
  });

  test("BR-2380: when the keep time has passed since its last heartbeat, nothing is kept and the landing goes to the tail", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-2", "x");
    const b = enqueue(d, "/wt/b", "C-3", "x");
    beat(d, a, 16 * MIN);
    tryTurn(d, b, STALE, NO_PRIORITY, KEEP);
    expect(row(d, a)).toMatchObject({ state: "abandoned", keep_until: null });
    expect(eventsOf(d, "queue.abandon")[0]).toMatchObject({ entry: a, keeps_place_until: null });
    expect(keptPlaces(d)).toEqual([]);
    expect(enter(d, "/wt/a", "C-2", "x").id).toBeGreaterThan(b);
  });

  test("BR-2380: after the kept time ran out, from another worktree or for another change, the landing goes to the tail", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-2", "x", GONE);
    const b = enqueue(d, "/wt/b", "C-3", "x");
    tryTurn(d, b, STALE, NO_PRIORITY, KEEP);
    expect(enter(d, "/wt/a", "C-9", "x").id).toBeGreaterThan(b); // another change in the same worktree
    expect(enter(d, "/wt/other", "C-2", "x").id).toBeGreaterThan(b); // the same change in another worktree
    d.db.query("UPDATE queue SET keep_until = ? WHERE id = ?").run(ago(1000), a); // the time is up
    expect(enter(d, "/wt/a", "C-2", "x").id).toBeGreaterThan(b);
  });

  test("BR-2380: with land_keep_place_minutes 0 an abandoned entry keeps nothing, in both ways of being abandoned", () => {
    const d = db();
    const gone = enqueue(d, "/wt/g", "C-2", "x", GONE);
    const silent = enqueue(d, "/wt/s", "C-3", "x");
    const b = enqueue(d, "/wt/b", "C-4", "x");
    beat(d, silent, 5 * MIN);
    tryTurn(d, b, 3 * MIN, NO_PRIORITY, { ms: 0, actor: "agent:b" });
    expect(row(d, gone)).toMatchObject({ state: "abandoned", keep_until: null });
    expect(row(d, silent)).toMatchObject({ state: "abandoned", keep_until: null });
    expect(enter(d, "/wt/g", "C-2", "x").id).toBeGreaterThan(b);
    expect(enter(d, "/wt/s", "C-3", "x").id).toBeGreaterThan(b);
  });

  test("BR-2380 BR-2144: the lander that was marked abandoned reads lost and never lands, though its place is kept for its next landing", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-2", "x");
    const b = enqueue(d, "/wt/b", "C-3", "x");
    beat(d, a, 11 * MIN);
    tryTurn(d, b, STALE, NO_PRIORITY, KEEP);
    expect(tryTurn(d, a).lost).toBe("abandoned: no heartbeat");
  });

  test("BR-2380: a landing that does not pass keep (an older caller) abandons without keeping, as before", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-2", "x", GONE);
    const b = enqueue(d, "/wt/b", "C-3", "x");
    tryTurn(d, b);
    expect(row(d, a)).toMatchObject({ state: "abandoned", keep_until: null });
    expect(eventsOf(d, "queue.abandon")).toEqual([]);
  });
});
