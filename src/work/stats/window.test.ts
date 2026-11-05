import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { computeStats, searchStats } from "./stats.ts";
import { eventsSince, lastEventId, parseSince, renderEvents, renderWindow, windowSummary } from "./window.ts";

function db(worktree?: string): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-window-")), "state.db"), worktree);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Writes `n` filler events so the next event gets id n + 1. */
function filler(d: CoordDb, n: number) {
  for (let i = 0; i < n; i++) d.event("agent:x", "id.allocate", null, {});
}

describe("canon stats --since", () => {
  test("BR-2154: only events after the id count; the id itself and earlier ones do not", () => {
    const d = db();
    for (let i = 0; i < 3; i++) d.event("agent:a", "land.ok", `C-${i + 1}`, {});
    d.event("agent:a", "land.refuse", "C-4", { reason: "floor" });
    const floor = (since?: number) => computeStats(d, {}, "2026-11-03", since).find((s) => s.check === "floor")!;
    expect([floor(3).runs, floor(3).refused]).toEqual([1, 1]);
    expect([floor().runs, floor().refused]).toEqual([4, 1]);
    expect([floor(0).runs, floor(0).refused]).toEqual([4, 1]);
    expect(computeStats(d, {}, "2026-11-03", 4).every((s) => s.runs === 0 && s.refused === 0)).toBe(true);
  });

  test("BR-2154: search stats are restricted the same way", () => {
    const d = db();
    d.event("agent:a", "search", null, { query: "x", results: 0, full: 0 });
    d.event("agent:a", "search", null, { query: "y", results: 2, full: 1 });
    expect(searchStats(d, 1)).toEqual({ searches: 1, empty: 0, noFull: 0 });
    expect(searchStats(d)).toEqual({ searches: 2, empty: 1, noFull: 1 });
  });

  test("BR-2154 BR-2156: --since takes only a whole event id, 0 or more", () => {
    expect(parseSince("0")).toBe(0);
    expect(parseSince("1300")).toBe(1300);
    for (const bad of ["x", "1.5", "-1", "", " 3", undefined, true]) expect(parseSince(bad)).toBeUndefined();
  });
});

describe("window summary", () => {
  test("BR-2155: landings, refusals by reason, queue waits, conflicts with early ones, for events after the id only", () => {
    const d = db();
    filler(d, 9);
    d.event("agent:a", "land.ok", "C-0", {}); // id 10: before the window
    d.event("agent:a", "land.turn", "C-1", { entry: 1, waited_ms: 8000 });
    d.event("agent:a", "land.ok", "C-1", {});
    d.event("agent:a", "land.turn", "C-2", { entry: 2, waited_ms: 1000 });
    d.event("agent:a", "land.refuse", "C-2", { reason: "conflict", early: true });
    d.event("agent:a", "land.turn", "C-3", { entry: 3, waited_ms: 3000 });
    d.event("agent:a", "land.refuse", "C-3", { reason: "floor" });
    d.event("agent:a", "land.ok", "C-3", {});
    d.event("agent:a", "land.lost", "C-4", { stage: "floor" });
    d.event("agent:a", "land.killed", "C-5", { signal: "SIGTERM" });
    d.event("agent:a", "overlap.notice", "C-1", { with: "C-2" });
    d.event("agent:b", "claim.refuse", "C-1", { reason: "held" });
    const w = windowSummary(d, 10);
    expect(w.landings).toEqual({ ok: 2, refused: { conflict: 1, floor: 1 }, lost: 1, killed: 1 });
    expect(w.waits).toEqual({ count: 3, medianMs: 3000, maxMs: 8000 });
    expect(w.conflicts).toEqual({ total: 1, early: 1, keptPlace: 0, resolveMedianMs: null });
    expect([w.overlapNotices, w.claimRefusals, w.events]).toEqual([1, 1, 11]);
    const text = renderWindow(w);
    expect(text).toContain("landings: 2 ok, 2 refused (conflict 1, floor 1), 1 lost, 1 killed");
    expect(text).toContain("queue waits: 3 turn(s), median 3.0s, max 8.0s");
    expect(text).toContain("conflicts: 1 (1 predicted before the turn); 0 landed again at their kept place, median resolve -");
  });

  test("BR-2155 BR-2177: landings that came back at their kept place are counted, with the median time to resolve", () => {
    const d = db();
    d.event("agent:a", "queue.enter", "C-1", { worktree: "/wt/a" }); // a new entry at the tail: not counted
    d.event("agent:a", "land.refuse", "C-2", { reason: "conflict", early: true, keeps_place_until: "2026-11-03T12:00:00.000Z" });
    d.event("agent:a", "queue.enter", "C-2", { worktree: "/wt/b", kept_place: 2, resolve_ms: 101_000 });
    d.event("agent:a", "land.refuse", "C-3", { reason: "conflict" });
    d.event("agent:a", "queue.enter", "C-3", { worktree: "/wt/c", kept_place: 3, resolve_ms: 245_000 });
    const w = windowSummary(d, 0);
    expect(w.conflicts).toEqual({ total: 2, early: 1, keptPlace: 2, resolveMedianMs: 173_000 });
    expect(renderWindow(w)).toContain("conflicts: 2 (1 predicted before the turn); 2 landed again at their kept place, median resolve 173.0s");
  });

  test("BR-2155: an even number of waits takes the mean of the middle two", () => {
    const d = db();
    for (const ms of [9000, 1000, 4000, 2000]) d.event("agent:a", "land.turn", "C-1", { waited_ms: ms });
    expect(windowSummary(d, 0).waits).toEqual({ count: 4, medianMs: 3000, maxMs: 9000 });
  });

  test("BR-2155: an empty window has no times and no waits; an earlier landing is not counted", () => {
    const d = db();
    filler(d, 9);
    d.event("agent:a", "land.ok", "C-1", {});
    const w = windowSummary(d, 10);
    expect([w.events, w.first, w.last, w.landings.ok]).toEqual([0, null, null, 0]);
    expect(w.waits).toEqual({ count: 0, medianMs: null, maxMs: null });
    expect(renderWindow(w)).toContain("queue waits: 0 turn(s), median -, max -");
  });

  test("BR-2155: distinct actors and worktrees are listed and counted, with first and last event time", () => {
    const path = join(mkdtempSync(join(tmpdir(), "canon-window-")), "state.db");
    const open = (wt: string) => {
      const r = CoordDb.open(path, wt);
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    open("/wt/C-1").event("agent:a", "start.ok", "C-1", {});
    open("/wt/C-2").event("agent:a", "start.ok", "C-2", {});
    open("/repo").event("agent:b", "human.ask", null, {});
    const w = windowSummary(open("/repo"), 0);
    expect(w.actors).toEqual(["agent:a", "agent:b"]);
    expect(w.worktrees).toEqual(["/repo", "/wt/C-1", "/wt/C-2"]);
    expect(w.first! <= w.last!).toBe(true);
    expect(renderWindow(w)).toContain("actors (2): agent:a, agent:b");
  });
});

describe("one upper bound", () => {
  test("BR-2155: with the last id read once, an event written between the reads is in no part; the summary names the bound", () => {
    const d = db();
    d.event("agent:a", "land.ok", "C-1", {});
    d.event("agent:a", "search", null, { query: "x", results: 1, full: 1 });
    const until = lastEventId(d);
    expect(until).toBe(2);
    d.event("agent:b", "land.ok", "C-2", {}); // another session lands meanwhile
    d.event("agent:b", "search", null, { query: "y", results: 0, full: 0 });
    const floor = computeStats(d, {}, "2026-11-03", 0, until).find((s) => s.check === "floor")!;
    const w = windowSummary(d, 0, until);
    expect([floor.runs, w.landings.ok, w.until, searchStats(d, 0, until).searches]).toEqual([1, 1, 2, 1]);
    expect(renderWindow(w)).toContain("window: events after #0 up to #2: 2 event(s)");
    expect(eventsSince(d, { since: 0, until, kinds: [] }).map((e) => e.id)).toEqual([1, 2]);
    expect(windowSummary(d, 0).until).toBe(4);
    expect(lastEventId(db())).toBe(0);
  });

  test("BR-2155: an event with no worktree is not counted as one", () => {
    const d = db();
    d.event("agent:a", "start.ok", "C-1", {});
    expect(windowSummary(d, 0).worktrees).toEqual([]);
  });

  test("BR-2154: --since above the last event id counts nothing", () => {
    const d = db();
    d.event("agent:a", "land.ok", "C-1", {});
    expect(computeStats(d, {}, "2026-11-03", 100).every((s) => s.runs === 0)).toBe(true);
  });
});

describe("canon events", () => {
  test("BR-2156: since, kinds (any of them) and subject all apply, oldest first, detail as an object", () => {
    const d = db("/wt/C-1");
    d.event("agent:a", "land.turn", "C-1", { entry: 7, waited_ms: 1000 });
    d.event("agent:a", "land.ok", "C-2", {});
    d.event("agent:a", "land.ok", "C-1", {});
    expect(eventsSince(d, { since: 1, kinds: ["land.ok"] }).map((e) => e.id)).toEqual([2, 3]);
    expect(eventsSince(d, { since: 0, kinds: ["land.ok", "land.turn"], subject: "C-1" }).map((e) => e.id)).toEqual([1, 3]);
    const all = eventsSince(d, { since: 0, kinds: [] });
    expect(all[0]).toMatchObject({ id: 1, actor: "agent:a", worktree: "/wt/C-1", kind: "land.turn", subject: "C-1", detail: { entry: 7, waited_ms: 1000 } });
    expect(renderEvents(all).split("\n")[0]).toMatch(/^#1 \S+ agent:a \/wt\/C-1 land\.turn C-1 \{"entry":7,"waited_ms":1000\}$/);
    expect(eventsSince(d, { since: 3, kinds: [] })).toEqual([]);
    expect(renderEvents([])).toBe("(no events)");
  });
});

describe("subagent actors and the hook and handover counts", () => {
  test("BR-2155: each subagent with its own name is an actor, the main session another; handovers and hook skips are counted", () => {
    const d = db();
    d.event("agent:s", "start.ok", "C-1", {});
    d.event("agent:s:a", "start.ok", "C-2", {});
    d.event("agent:s:b", "start.ok", "C-3", {});
    d.event("agent:s", "claim.handover", "C-2", { from: "a", by: "main-session" });
    d.event("agent:s:b", "hook.skip", null, { reason: "unparsable" });
    d.event("agent:s", "hook.skip", null, { reason: "bad-input" });
    const w = windowSummary(d, 0);
    expect(w.actors).toEqual(["agent:s", "agent:s:a", "agent:s:b"]);
    expect([w.claimHandovers, w.hookSkips]).toEqual([1, 2]);
    const text = renderWindow(w);
    expect(text).toContain("actors (3): agent:s, agent:s:a, agent:s:b");
    expect(text).toContain("claim handovers: 1; hook skips: 2");
    expect(windowSummary(d, 5).hookSkips).toBe(1);
  });
});
