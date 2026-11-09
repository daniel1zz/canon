import { describe, expect, test } from "bun:test";
import { project, startNew, ws } from "../testkit.ts";
import { loadDetail, machineNow, overloadLines, startHint } from "./load.ts";

/** A landing turn at `load` on 8 CPUs that ended in land.ok `minutes` later. */
function turn(db: ReturnType<typeof ws>["db"], subject: string, load: number, minutes: number) {
  db.event("agent:a", "land.turn", subject, { entry: 1, waited_ms: 0, load, cpus: 8 });
  const id = db.db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM events").get()!.id;
  db.event("agent:a", "land.ok", subject, { sha: "x" });
  db.db.query("UPDATE events SET ts = strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT ts FROM events WHERE id = ?), ?) WHERE id = ?").run(id, `+${minutes * 60} seconds`, id + 1);
}

describe("canon work start on an overloaded machine (BR-2400)", () => {
  test("BR-2400: at twice the CPU count the hint names the load, the CPUs and the claims; just below it says nothing", () => {
    const root = project();
    startNew(root, "Busy");
    const db = ws(root).db;
    const lines = overloadLines(db, { load5: 16, cpus: 8 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("machine busy: 5-minute load 16.0 on 8 CPUs (at or over 16); 1 change(s) claimed.");
    expect(overloadLines(db, { load5: 15.9, cpus: 8 })).toEqual([]);
    expect(overloadLines(db, { load5: 15.96, cpus: 8 })).toEqual([]); // shown as 16.0, but under twice the CPUs
  });

  test("BR-2400 BR-2122: --fix-main, a worktree taken back, or no load average from the platform give no hint; a turn records the load it ran at", () => {
    const db = ws(project()).db;
    const busy = { load5: 40, cpus: 8 };
    expect(startHint(db, busy, { fixMain: true, created: true })).toEqual([]);
    expect(startHint(db, busy, { fixMain: false, created: false })).toEqual([]);
    expect(startHint(db, undefined, { fixMain: false, created: true })).toEqual([]);
    expect(startHint(db, busy, { fixMain: false, created: true })).toHaveLength(1);
    const now = machineNow();
    expect(now === undefined || (now.cpus > 0 && now.load5 > 0)).toBe(true);
    const detail = loadDetail();
    expect(now === undefined ? detail : { cpus: detail.cpus, rounded: detail.load === Math.round(detail.load! * 10) / 10 }).toEqual(now === undefined ? {} : { cpus: now.cpus, rounded: true });
  });

  test("BR-2400: with at least 3 landed turns at that load and 3 below it, the hint adds both median turn times; with fewer it does not", () => {
    const db = ws(project()).db;
    for (const [i, load] of [20, 20, 20, 2, 2].entries()) turn(db, `C-${i + 1}`, load, load === 20 ? 10 : 4);
    expect(overloadLines(db, { load5: 16, cpus: 8 })).toHaveLength(1);
    db.event("agent:a", "land.turn", "C-8", { entry: 1, waited_ms: 0, load: 2, cpus: 8 });
    db.event("agent:a", "land.refuse", "C-8", { reason: "floor" }); // a refused turn is not counted
    expect(overloadLines(db, { load5: 16, cpus: 8 })).toHaveLength(1);
    turn(db, "C-9", 2, 4);
    const lines = overloadLines(db, { load5: 16, cpus: 8 });
    expect(lines[1]).toBe("landing turns (land.turn to land.ok) recently: median 10.0 min at a load this high (3), 4.0 min below it (3)");
  });
});
