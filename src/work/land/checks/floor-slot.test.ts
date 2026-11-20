import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, ws } from "../../testkit.ts";
import { acquireSlot, machineSlots, type SlotDeps } from "../../verify/slot.ts";
import { floorWithReport } from "./floor.ts";

const slots = (): SlotDeps => ({ ...machineSlots, dir: mkdtempSync(join(tmpdir(), "canon-floor-slots-")), pollMs: 20, gone: () => false });

const events = (root: string) =>
  ws(root).db.db.query<{ kind: string; subject: string | null; detail: string }, []>("SELECT kind, subject, detail FROM events WHERE kind LIKE 'test.full.%' ORDER BY id").all();

describe("the whole floor takes a full run slot", () => {
  test("BR-2576 BR-2578: the floor waits behind a full run, says so, then runs; its events have no subject", async () => {
    const root = project();
    const w = ws(root);
    const d = slots();
    const holder = await acquireSlot({ ...d, self: () => ({ pid: 4243, start: "other" }) }, { subject: "C-5", worktree: "/other/wt", kind: "work-test", max: 1, say: () => {}, aborted: () => false, record: () => {} });
    if (!holder.ok || holder.value === "aborted") throw new Error("no slot");
    const said: string[] = [];
    let ran = false;
    const run = floorWithReport(w.db, w.config, root, "true", async () => ((ran = true), 0), () => {}, undefined, { actor: w.actor, worktree: root, say: (l) => said.push(l), slots: d });
    await Bun.sleep(200);
    expect(ran).toBe(false);
    expect(said).toEqual([expect.stringContaining("1 full run(s) ahead on this machine: C-5 (/other/wt, running 0 min)")]);
    holder.value.release("passed");
    expect(await run).toBe(0);
    expect(ran).toBe(true);
    const got = events(root);
    expect(got.map((e) => e.kind)).toEqual(["test.full.wait", "test.full.start", "test.full.end"]);
    expect(got.map((e) => e.subject)).toEqual([null, null, null]);
    expect(JSON.parse(got[2]!.detail)).toMatchObject({ subject: null, outcome: "passed" });
  });

  test("BR-2576 BR-2578: a failing floor ends with outcome failed and gives the slot back", async () => {
    const root = project();
    const w = ws(root);
    const d = slots();
    const full = { actor: w.actor, worktree: root, say: () => {}, slots: d };
    expect(await floorWithReport(w.db, w.config, root, "false", async () => 3, () => {}, undefined, full)).toBe(3);
    expect(JSON.parse(events(root).at(-1)!.detail)).toMatchObject({ outcome: "failed" });
    // the slot is free again: a second floor starts at once
    expect(await floorWithReport(w.db, w.config, root, "true", async () => 0, () => {}, undefined, full)).toBe(0);
  });

  test("BR-2576: a floor without a full run (a scoped floor) takes no slot and records no event", async () => {
    const root = project();
    const w = ws(root);
    expect(await floorWithReport(w.db, w.config, root, "true", async () => 0, () => {})).toBe(0);
    expect(events(root)).toEqual([]);
  });

  test("BR-2577: a queue that cannot be used fails the floor with exit 4 and says why", async () => {
    const root = project();
    const w = ws(root);
    const notes: string[] = [];
    const d = { ...slots(), self: () => undefined };
    expect(await floorWithReport(w.db, w.config, root, "true", async () => 0, (l) => notes.push(l), undefined, { actor: w.actor, worktree: root, say: () => {}, slots: d })).toBe(4);
    expect(notes[0]).toContain("full-run queue");
  });
});
