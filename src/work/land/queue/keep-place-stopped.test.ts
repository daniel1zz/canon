import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../../db.ts";
import { enqueue, enter, failIfActive, failKeepingPlace, finishEntry, keptPlaces, tryTurn } from "./queue.ts";
import { land } from "../land.ts";
import { FAST, HANG_SECONDS, project, quiet, sh, startNew, waitFor, ws, landingProcess } from "../../testkit.ts";

/** A landing that gave up waiting (timeout) or was stopped by a signal keeps its place like a conflict does (BR-2368, D-75). */

const KEEP = 15 * 60_000;
const CLI = join(import.meta.dir, "../../../invocation/main.ts");
const TIMED = 30_000;

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-keep-stopped-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const stateOf = (d: CoordDb, id: number) => d.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(id)?.state;
const entryIds = (d: CoordDb, wt: string) => d.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE worktree = ? ORDER BY id").all(wt).map((e) => e.id);
const eventsOf = (d: CoordDb, kind: string) => d.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e) => JSON.parse(e.detail) as Record<string, unknown>);

describe("the queue entry of a landing that timed out or was killed", () => {
  test("BR-2368: its own worktree and change take it back once, ahead of entries queued after it, and the event says why", () => {
    const d = db();
    const t = enqueue(d, "/wt/t", "C-2", "x");
    const k = enqueue(d, "/wt/k", "C-3", "x");
    const later = enqueue(d, "/wt/later", "C-4", "x");
    expect(failKeepingPlace(d, t, "timeout", KEEP)).not.toBeNull();
    expect(failIfActive(d, k, "killed", undefined, KEEP)).toBe(true);
    expect(keptPlaces(d).map((e) => [e.id, e.state, e.subject])).toEqual([[t, "resolving", "C-2"], [k, "resolving", "C-3"]]);
    expect(tryTurn(d, later)).toEqual({ mine: true, ahead: 0 }); // the kept places block nobody
    const back = enter(d, "/wt/t", "C-2", "x");
    expect(back).toMatchObject({ id: t, kept: { after: "timeout" } });
    expect(enter(d, "/wt/k", "C-3", "x")).toMatchObject({ id: k, kept: { after: "killed" } });
    const tail = enter(d, "/wt/t", "C-2", "x").id;
    expect(tail).toBeGreaterThan(later); // taken back once: the second time is a new entry at the tail
    expect(eventsOf(d, "queue.enter").filter((e) => e["kept_place"] !== undefined).map((e) => [e["kept_place"], e["kept_after"]])).toEqual([[t, "timeout"], [k, "killed"]]);
    expect(tryTurn(d, t)).toEqual({ mine: false, ahead: 1 }); // C-4 is landing: it is not interrupted (BR-2178)
    finishEntry(d, later, "landed", "x");
    expect(tryTurn(d, t).mine).toBe(true);
    finishEntry(d, t, "landed", "x");
    expect(tryTurn(d, tail)).toEqual({ mine: false, ahead: 1 }); // C-3 kept its place ahead of the entry that went to the tail
    expect(tryTurn(d, k).mine).toBe(true);
  });

  test("BR-2368: after the time, with 0 minutes, from another worktree or for another change, or after another refusal, the landing goes to the tail", () => {
    const d = db();
    const t = enqueue(d, "/wt/t", "C-2", "x");
    failKeepingPlace(d, t, "timeout", KEEP);
    d.db.query("UPDATE queue SET keep_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), t); // the time is up
    expect(enter(d, "/wt/t", "C-2", "x").id).toBeGreaterThan(t);

    const z = enqueue(d, "/wt/z", "C-3", "x");
    expect(failKeepingPlace(d, z, "timeout", 0)).toBeNull(); // land_keep_place_minutes: 0
    const k0 = enqueue(d, "/wt/k0", "C-4", "x");
    expect(failIfActive(d, k0, "killed", undefined, 0)).toBe(true);
    expect(enter(d, "/wt/z", "C-3", "x").id).toBeGreaterThan(z);
    expect(enter(d, "/wt/k0", "C-4", "x").id).toBeGreaterThan(k0);

    const k = enqueue(d, "/wt/k", "C-5", "x");
    failIfActive(d, k, "killed", undefined, KEEP);
    expect(enter(d, "/wt/k", "C-6", "x").id).toBeGreaterThan(k); // another change in the same worktree
    expect(enter(d, "/wt/other", "C-5", "x").id).toBeGreaterThan(k); // the same change in another worktree
    expect(enter(d, "/wt/k", "C-5", "x").id).toBe(k); // still kept for its own

    const f = enqueue(d, "/wt/f", "C-7", "x");
    finishEntry(d, f, "failed", "floor: exited 1");
    expect(enter(d, "/wt/f", "C-7", "x").id).toBeGreaterThan(f);
  });
});

describe("a landing that gave up waiting, through real landings", () => {
  /** A change with a commit, and another lander holding the turn so the change has to wait. */
  function waiting(keepYaml = "") {
    const root = project();
    if (keepYaml) {
      writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\nreview: none\n${keepYaml}`);
      sh(root, "commit", "-qam", "keep time");
    }
    const s = startNew(root, "Waits behind someone");
    writeFileSync(join(s.worktree, "waits.txt"), "one\n");
    sh(s.worktree, "add", "waits.txt");
    sh(s.worktree, "commit", "-qm", "waits");
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, blocker).mine).toBe(true);
    return { root, s, d: other.db, blocker };
  }

  test("BR-2368 BR-2048: a timeout says until when the place is kept, and landing again, even with other changes, takes it back and lands", async () => {
    const { s, d, blocker } = waiting();
    const out = await land(ws(s.worktree), { finish: false, timeoutMs: 300 }, quiet);
    expect(out.kind).toBe("timeout");
    expect(out.kind === "timeout" && out.keepsPlaceUntil).toBeString();
    const first = entryIds(d, s.worktree)[0]!;
    expect(eventsOf(d, "land.refuse").at(-1)).toMatchObject({ reason: "timeout", keeps_place_until: (out as { keepsPlaceUntil: string }).keepsPlaceUntil });
    const later = enqueue(d, "/later", "C-98", "agent:b"); // queued after the timeout
    writeFileSync(join(s.worktree, "more.txt"), "more\n"); // the diff is not the same as at the timeout
    sh(s.worktree, "add", "more.txt");
    sh(s.worktree, "commit", "-qm", "more");
    const said: string[] = [];
    const again = land(ws(s.worktree), FAST, (m: string) => said.push(m));
    await waitFor("the landing to take its place back", () => stateOf(d, first) === "waiting");
    expect(entryIds(d, s.worktree)).toEqual([first]);
    expect(tryTurn(d, later)).toEqual({ mine: false, ahead: 2 }); // behind the lander that holds the turn and behind C-n
    finishEntry(d, blocker, "landed", "x");
    expect((await again).kind).toBe("landed");
    expect(said.some((m) => m.includes(`back in the landing queue at the place it kept after its timeout (queue entry ${first}`))).toBe(true);
    expect(eventsOf(d, "queue.enter").at(-1)).toMatchObject({ kept_place: first, kept_after: "timeout" });
  }, TIMED);

  test("BR-2368 BR-2048: canon work land --timeout exits 75 and says until when the place is kept", async () => {
    const { s } = waiting();
    const p = Bun.spawn(["bun", CLI, "work", "land", "--timeout", "0.005"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...landingProcess() } });
    expect(await p.exited).toBe(75);
    expect(await new Response(p.stderr).text()).toContain("this landing keeps its place in the queue until");
  }, TIMED);

  test("BR-2368: a landing killed by SIGTERM while waiting keeps its place; landing again takes it back, and the event says so", async () => {
    const { s, d, blocker } = waiting();
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...landingProcess() } });
    await waitFor("the landing to wait in the queue", () => entryIds(d, s.worktree).length === 1 && stateOf(d, entryIds(d, s.worktree)[0]!) === "waiting");
    const first = entryIds(d, s.worktree)[0]!;
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(await new Response(p.stdout).text() + (await new Response(p.stderr).text())).toContain("keeps its place in the queue until");
    expect(eventsOf(d, "land.killed").at(-1)!["keeps_place_until"]).toBeString();
    expect(stateOf(d, first)).toBe("failed");
    const later = enqueue(d, "/later", "C-98", "agent:b");
    const again = land(ws(s.worktree), FAST, quiet);
    await waitFor("the landing to take its place back", () => stateOf(d, first) === "waiting");
    expect(entryIds(d, s.worktree)).toEqual([first]);
    expect(tryTurn(d, later)).toEqual({ mine: false, ahead: 2 });
    finishEntry(d, blocker, "landed", "x");
    expect((await again).kind).toBe("landed");
    expect(eventsOf(d, "queue.enter").at(-1)).toMatchObject({ kept_place: first, kept_after: "killed" });
  }, TIMED);

  test("BR-2368 BR-2099: a landing killed while its floor runs keeps its place too", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "exec sleep ${HANG_SECONDS}"\ntests: []\nreview: none\n`);
    sh(root, "commit", "-qam", "slow floor");
    const s = startNew(root, "Killed at its turn");
    const d = ws(root).db;
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...landingProcess() } });
    await waitFor("the floor to run", () => entryIds(d, s.worktree).length === 1 && stateOf(d, entryIds(d, s.worktree)[0]!) === "landing");
    const first = entryIds(d, s.worktree)[0]!;
    await waitFor("the floor to start", () => existsSync(join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "canon/logs", `land-${first}.log`)));
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(stateOf(d, first)).toBe("failed");
    const back = enter(d, s.worktree, s.change, "agent:a");
    expect(back).toMatchObject({ id: first, kept: { after: "killed" } });
  }, TIMED);

  test("BR-2368: with land_keep_place_minutes 0, a timeout and a kill keep nothing and say nothing", async () => {
    const { s, d } = waiting("land_keep_place_minutes: 0\n");
    const out = await land(ws(s.worktree), { finish: false, timeoutMs: 300 }, quiet);
    expect(out.kind === "timeout" && out.keepsPlaceUntil).toBeUndefined();
    expect(eventsOf(d, "land.refuse").at(-1)).not.toHaveProperty("keeps_place_until");
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...landingProcess() } });
    await waitFor("the landing to wait", () => entryIds(d, s.worktree).length === 2 && stateOf(d, entryIds(d, s.worktree)[1]!) === "waiting");
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(eventsOf(d, "land.killed").at(-1)).not.toHaveProperty("keeps_place_until");
    expect(keptPlaces(d)).toEqual([]);
    expect(enter(d, s.worktree, s.change, "agent:a").id).toBeGreaterThan(entryIds(d, s.worktree)[1]!);
  }, TIMED);
});
