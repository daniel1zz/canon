import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { readConfig } from "../../config/config.ts";
import { batchCandidates, enqueue, enter, failForConflict, finishEntry, keptPlaces, tryTurn } from "./queue.ts";
import { selfProcess } from "../claims/liveness.ts";
import { land } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-keep-place-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const KEEP = 15 * 60_000;
const stateOf = (d: CoordDb, id: number) => d.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(id)?.state;

describe("a landing refused for a conflict keeps its place", () => {
  test("BR-2177: entries behind pass while it resolves; landing again within the time puts it back ahead of later entries", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const r = enqueue(d, "/wt/r", "C-2", "x");
    const b = enqueue(d, "/wt/b", "C-3", "x");
    expect(tryTurn(d, a).mine).toBe(true);
    expect(failForConflict(d, r, "conflict: app.txt", KEEP)).not.toBeNull(); // predicted while waiting
    expect(keptPlaces(d).map((e) => [e.id, e.state, e.subject])).toEqual([[r, "resolving", "C-2"]]);
    finishEntry(d, a, "landed", "sa");
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 }); // the resolving entry does not block
    const c = enqueue(d, "/wt/c", "C-4", "x"); // queued after C-2's place
    const back = enter(d, "/wt/r", "C-2", "x");
    expect(back.id).toBe(r);
    expect(back.kept?.resolveMs).toBeGreaterThanOrEqual(0);
    expect(keptPlaces(d)).toEqual([]);
    expect(tryTurn(d, r)).toEqual({ mine: false, ahead: 1 }); // B is landing: it is not interrupted (BR-2178)
    finishEntry(d, b, "landed", "sb");
    expect(tryTurn(d, c)).toEqual({ mine: false, ahead: 1 }); // C-2 is ahead of C-4
    expect(tryTurn(d, r)).toEqual({ mine: true, ahead: 0 });
    const ev = d.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'queue.enter' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(ev!.detail)).toMatchObject({ worktree: "/wt/r", kept_place: r });
  });

  test("BR-2177: after the time, with 0 minutes, after another refusal, or from another worktree, the landing goes to the tail", () => {
    const d = db();
    const r = enqueue(d, "/wt/r", "C-2", "x");
    failForConflict(d, r, "conflict", KEEP);
    d.db.query("UPDATE queue SET keep_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), r); // the time is up
    expect(keptPlaces(d)).toEqual([]);
    const late = enter(d, "/wt/r", "C-2", "x");
    expect(late.id).toBeGreaterThan(r);
    expect(late.kept).toBeUndefined();

    expect(failForConflict(d, late.id, "conflict", 0)).toBeNull(); // land_keep_place_minutes: 0
    expect(enter(d, "/wt/r", "C-2", "x").id).toBeGreaterThan(late.id);

    const f = enqueue(d, "/wt/f", "C-5", "x");
    finishEntry(d, f, "failed", "floor: exited 1");
    expect(enter(d, "/wt/f", "C-5", "x").id).toBeGreaterThan(f);

    const o = enqueue(d, "/wt/o", "C-6", "x");
    failForConflict(d, o, "conflict", KEEP);
    expect(enter(d, "/wt/elsewhere", "C-6", "x").id).toBeGreaterThan(o);
    expect(enter(d, "/wt/o", "C-6", "x").id).toBe(o); // still kept for its own worktree
    expect(enter(d, "/wt/o", "C-6", "x").id).not.toBe(o); // taken back once only: o is waiting now
  });

  test("BR-2177: land_keep_place_minutes defaults to 15 and accepts 0; a negative or non-number is a config error", () => {
    const root = project();
    const read = (yaml: string) => {
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n${yaml}`);
      return readConfig(root);
    };
    expect(read("").ok && (read("") as { value: { landKeepPlaceMs: number } }).value.landKeepPlaceMs).toBe(15 * 60_000);
    const zero = read("land_keep_place_minutes: 0\n");
    expect(zero.ok && zero.value.landKeepPlaceMs).toBe(0);
    for (const bad of ["land_keep_place_minutes: -1\n", "land_keep_place_minutes: soon\n"]) {
      const r = read(bad);
      expect(!r.ok && r.error.message).toContain("land_keep_place_minutes");
    }
  });

  test("BR-2177 BR-2153: a predicted conflict says how long the place is kept; landing again after resolving takes it back and lands", async () => {
    const root = project();
    const s = startNew(root, "Conflicts then resolves");
    writeFileSync(join(s.worktree, "app.txt"), "one\n2\nthree\n");
    sh(s.worktree, "commit", "-qam", "mine");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(300);
    writeFileSync(join(root, "app.txt"), "one\nTWO\nthree\n");
    sh(root, "commit", "-qam", "theirs");
    const out = await landing;
    expect(out.kind === "refused" && out.reason).toBe("conflict");
    expect(out.kind === "refused" && out.message).toContain("keeps its place in the queue until");
    const first = other.db.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE worktree = ?").get(s.worktree)!.id;
    const refusal = other.db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse'").get();
    expect(JSON.parse(refusal!.detail).keeps_place_until).toBeString();
    const later = enqueue(other.db, "/later", "C-98", "agent:b"); // queued while C-n resolves

    // Resolve by keeping this change's line, then land again; the one ahead still holds the turn.
    sh(s.worktree, "rebase", "-q", "-X", "theirs", "main");
    const said: string[] = [];
    const again = land(ws(s.worktree), FAST, (m: string) => said.push(m));
    await Bun.sleep(300);
    expect(other.db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM queue WHERE worktree = ?").get(s.worktree)?.n).toBe(1);
    expect(stateOf(other.db, first)).toBe("waiting");
    expect(tryTurn(other.db, later)).toEqual({ mine: false, ahead: 2 }); // behind the one landing and behind C-n
    finishEntry(other.db, ahead, "landed", "x");
    expect((await again).kind).toBe("landed");
    expect(said.some((m) => m.includes(`back in the landing queue at the place it kept after its conflict (queue entry ${first}`))).toBe(true);
  }, 30_000); // reason: two landings through 2 s queue polls on purpose
});

describe("a conflict at the turn", () => {
  test("BR-2177 BR-2015: a rebase conflict at the turn keeps the place too, and says until when", async () => {
    const root = project();
    const s = startNew(root, "Conflicts at the turn");
    writeFileSync(join(s.worktree, "app.txt"), "one\n2\nthree\n");
    sh(s.worktree, "commit", "-qam", "mine");
    writeFileSync(join(root, "app.txt"), "one\nTWO\nthree\n");
    sh(root, "commit", "-qam", "theirs"); // nobody is ahead, so the turn comes at once and the rebase finds it
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.message).toContain("rebase onto main conflicts in: app.txt");
    expect(out.kind === "refused" && out.message).toContain("keeps its place in the queue until");
    expect(keptPlaces(ws(root).db).map((e) => e.worktree)).toEqual([s.worktree]);
  });
});

describe("a landing back at its kept place", () => {
  test("BR-2178: it waits for a landing under way, but not for one whose lander is gone", () => {
    const d = db();
    const r = enqueue(d, "/wt/r", "C-2", "x");
    failForConflict(d, r, "conflict", KEEP);
    const b = enqueue(d, "/wt/b", "C-3", "x", { pid: 2 ** 22 + 12345, start: "never" });
    expect(tryTurn(d, b).mine).toBe(true);
    expect(enter(d, "/wt/r", "C-2", "x").id).toBe(r);
    expect(tryTurn(d, r)).toEqual({ mine: true, ahead: 0 }); // b's lander process is gone, so it is skipped
    expect(stateOf(d, b)).toBe("abandoned");
  });

  test("BR-2178: a batch takes it first, in queue order, ahead of the entries queued after its place", () => {
    const d = db();
    const me = selfProcess();
    const r = enqueue(d, "/wt/r", "C-2", "x", me);
    failForConflict(d, r, "conflict", KEEP);
    const lead = enqueue(d, "/wt/a", "C-3", "x", me);
    const c = enqueue(d, "/wt/c", "C-4", "x", me);
    expect(tryTurn(d, lead).mine).toBe(true);
    expect(enter(d, "/wt/r", "C-2", "x", me).id).toBe(r);
    expect(batchCandidates(d, lead, 3).map((x) => x.id)).toEqual([r, c]);
    expect(batchCandidates(d, lead, 1).map((x) => x.id)).toEqual([r]);
  });
});
