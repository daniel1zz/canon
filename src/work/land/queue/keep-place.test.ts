import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../../db.ts";
import { readConfig } from "../../../invocation/config.ts";
import { abandonGone, batchCandidates, enqueue, enter, failKeepingPlace, failIfActive, finishEntry, keptPlaces, tryTurn } from "./queue.ts";
import { selfProcess } from "../../claims/liveness.ts";
import { land } from "../land.ts";
import { FAST, boundedLoop, project, quiet, sh, startNew, waitFor, ws } from "../../testkit.ts";

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
    expect(failKeepingPlace(d, r, "conflict: app.txt", KEEP)).not.toBeNull(); // predicted while waiting
    expect(keptPlaces(d).map((e) => [e.id, e.state, e.subject])).toEqual([[r, "resolving", "C-2"]]);
    finishEntry(d, a, "landed", "sa");
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 }); // the resolving entry does not block
    const c = enqueue(d, "/wt/c", "C-4", "x"); // queued after C-2's place
    const back = enter(d, "/wt/r", "C-2", "x");
    expect(back.id).toBe(r);
    expect(back.kept?.resolveMs).toBeGreaterThanOrEqual(0);
    expect(keptPlaces(d)).toEqual([]);
    // a fresh landing at the old place: no batch and no solo mark carried over (D-42)
    expect(d.db.query<{ solo: number | null; batch: number | null }, [number]>("SELECT solo, batch FROM queue WHERE id = ?").get(r)).toEqual({ solo: 0, batch: null });
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
    failKeepingPlace(d, r, "conflict", KEEP);
    d.db.query("UPDATE queue SET keep_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), r); // the time is up
    expect(keptPlaces(d)).toEqual([]);
    const late = enter(d, "/wt/r", "C-2", "x");
    expect(late.id).toBeGreaterThan(r);
    expect(late.kept).toBeUndefined();

    expect(failKeepingPlace(d, late.id, "conflict", 0)).toBeNull(); // land_keep_place_minutes: 0
    expect(enter(d, "/wt/r", "C-2", "x").id).toBeGreaterThan(late.id);

    const f = enqueue(d, "/wt/f", "C-5", "x");
    finishEntry(d, f, "failed", "floor: exited 1");
    expect(enter(d, "/wt/f", "C-5", "x").id).toBeGreaterThan(f);

    const o = enqueue(d, "/wt/o", "C-6", "x");
    failKeepingPlace(d, o, "conflict", KEEP);
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
    await waitFor("the landing to wait in the queue", () => other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(s.worktree) !== null);
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
    await waitFor("the landing to take its place back", () => stateOf(other.db, first) === "waiting");
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
    failKeepingPlace(d, r, "conflict", KEEP);
    const b = enqueue(d, "/wt/b", "C-3", "x", { pid: 2 ** 22 + 12345, start: "never" });
    expect(tryTurn(d, b).mine).toBe(true);
    expect(enter(d, "/wt/r", "C-2", "x").id).toBe(r);
    expect(tryTurn(d, r)).toEqual({ mine: true, ahead: 0 }); // b's lander process is gone, so it is skipped
    expect(stateOf(d, b)).toBe("abandoned");
  });

  test("BR-2177: a verdict about the lander that was refused does not touch the lander that took the place back (issue #45)", () => {
    const d = db();
    const old = { pid: 2 ** 22 + 12345, start: "never" };
    const r = enqueue(d, "/wt/r", "C-2", "x", old);
    failKeepingPlace(d, r, "conflict", KEEP); // the old lander is refused and exits
    const me = selfProcess()!;
    expect(enter(d, "/wt/r", "C-2", "x", me).id).toBe(r);
    expect(abandonGone(d, r, old)).toBe(false); // a waiter probed the old lander before the entry was taken back
    expect(failIfActive(d, r, "killed", old)).toBe(false); // the old lander's signal handler, late
    expect(stateOf(d, r)).toBe("waiting");
    expect(tryTurn(d, r)).toEqual({ mine: true, ahead: 0 });
    expect(failIfActive(d, r, "killed", me)).toBe(true); // its own lander still can
  });

  test("BR-2178: a batch takes it first, in queue order, ahead of the entries queued after its place", () => {
    const d = db();
    const me = selfProcess();
    const r = enqueue(d, "/wt/r", "C-2", "x", me);
    failKeepingPlace(d, r, "conflict", KEEP);
    const lead = enqueue(d, "/wt/a", "C-3", "x", me);
    const c = enqueue(d, "/wt/c", "C-4", "x", me);
    expect(tryTurn(d, lead).mine).toBe(true);
    expect(enter(d, "/wt/r", "C-2", "x", me).id).toBe(r);
    expect(batchCandidates(d, lead, 3).map((x) => x.id)).toEqual([r, c]);
    expect(batchCandidates(d, lead, 1).map((x) => x.id)).toEqual([r]);
  });
});

describe("kept places end to end, through real landings", () => {
  const CLI = join(import.meta.dir, "../../../invocation/main.ts");
  const until = async (what: () => boolean, tries = 400) => {
    for (let i = 0; i < tries && !what(); i++) await Bun.sleep(25);
    expect(what()).toBe(true);
  };
  const commitFile = (wt: string, path: string, text: string) => {
    writeFileSync(join(wt, path), text);
    sh(wt, "add", path);
    sh(wt, "commit", "-qm", path);
  };
  /** C-2's worktree with a place kept for it after a conflict refusal. */
  function kept(root: string) {
    const c2 = startNew(root, "Resolving");
    commitFile(c2.worktree, "c2.txt", "c2\n");
    const d = ws(root, "agent:b").db;
    const r = enqueue(d, c2.worktree, c2.change, "agent:a");
    failKeepingPlace(d, r, "conflict: app.txt", KEEP);
    return { c2, r, d };
  }

  test("BR-2177: canon work status lists the entry as resolving, and landing again records kept_place and resolve_ms", async () => {
    const root = project();
    const s = startNew(root, "Conflicts");
    writeFileSync(join(s.worktree, "app.txt"), "one\n2\nthree\n");
    sh(s.worktree, "commit", "-qam", "mine");
    writeFileSync(join(root, "app.txt"), "one\nTWO\nthree\n");
    sh(root, "commit", "-qam", "theirs");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("refused");
    const status = Bun.spawnSync(["bun", CLI, "work", "status"], { cwd: root, env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(status.stdout.toString()).toContain(`resolving ${s.change}`);
    sh(s.worktree, "rebase", "-q", "-X", "theirs", "main");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const enters = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'queue.enter' ORDER BY id").all().map((e) => JSON.parse(e.detail) as Record<string, unknown>);
    expect(enters.at(-1)!["kept_place"]).toBeNumber();
    expect(enters.at(-1)!["resolve_ms"] as number).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("BR-2178: back at its place while a later entry is landing, it waits for that landing, then goes before the entry queued after its place", async () => {
    const root = project();
    // a stale time of 1.8 s makes a waiting lander look at the queue every 0.6 s (waitPollMs); the fake entries beat below
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nreview: none\nlander_stale_minutes: 0.03\n");
    sh(root, "commit", "-qam", "short stale time");
    const { c2, r, d } = kept(root);
    const c3 = enqueue(d, "/wt/c3", "C-3", "agent:b");
    expect(tryTurn(d, c3).mine).toBe(true);
    const c4 = enqueue(d, "/wt/c4", "C-4", "agent:b");
    const beats = setInterval(() => d.db.query("UPDATE queue SET heartbeat = ? WHERE id IN (?, ?)").run(new Date().toISOString(), c3, c4), 100);
    try {
      const landing = land(ws(c2.worktree), FAST, quiet);
      // every look at the queue is a heartbeat: two changes mean one whole look, begun after the landing queued, is done
      const beat = () => d.db.query<{ heartbeat: string }, [number]>("SELECT heartbeat FROM queue WHERE id = ?").get(r)!.heartbeat;
      for (let n = 0; n < 2; n++) {
        const seen = beat();
        await waitFor("the landing to look at the queue again", () => beat() !== seen);
      }
      expect(stateOf(d, r)).toBe("waiting");
      expect(tryTurn(d, c4)).toEqual({ mine: false, ahead: 2 });
      finishEntry(d, c3, "landed", "x");
      expect((await landing).kind).toBe("landed");
      expect(stateOf(d, r)).toBe("landed");
      expect(tryTurn(d, c4).mine).toBe(true);
    } finally {
      clearInterval(beats);
    }
  }, 30_000);

  test("BR-2178: back at its place while a later entry's lander is gone, it does not wait; that entry is marked abandoned", async () => {
    const root = project();
    const { c2, d } = kept(root);
    const c3 = enqueue(d, "/wt/c3", "C-3", "agent:b", { pid: 2 ** 22 + 12345, start: "never" });
    expect(tryTurn(d, c3).mine).toBe(true);
    expect((await land(ws(c2.worktree), FAST, quiet)).kind).toBe("landed");
    expect(stateOf(d, c3)).toBe("abandoned");
  }, 30_000);

  for (const max of [4, 2]) {
    test(`BR-2178: back at its place while C-3 leads, it is the first member C-3 batches (land_batch_max: ${max})`, async () => {
      const root = project();
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nland_batch_max: ${max}\n`);
      sh(root, "commit", "-qam", "batches");
      const { c2, r, d } = kept(root);
      const c3 = startNew(root, "Leads");
      commitFile(c3.worktree, "c3.txt", "c3\n");
      const c4 = startNew(root, "Behind");
      commitFile(c4.worktree, "c4.txt", "c4\n");
      commitFile(root, "main.txt", "main moved\n"); // so C-3's rebase checks files out
      const blocker = enqueue(d, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(d, blocker).mine).toBe(true);
      // reason: C-3 lands in its own process; its rebase's post-checkout hook holds it after its turn, before it picks members.
      const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
      mkdirSync(hooks, { recursive: true });
      const go = join(root, "..", `${root.split("/").pop()}-go`);
      const hit = join(root, "..", `${root.split("/").pop()}-hit`);
      writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nif [ -f ${go} ]; then rm ${go}; touch ${hit}; ${boundedLoop(`[ ! -e ${go}.release ]`)}; fi\n`, { mode: 0o755 });
      const p3 = Bun.spawn(["bun", CLI, "work", "land"], { cwd: c3.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
      const entry = (wt: string) => d.db.query<{ id: number; state: string }, [string]>("SELECT id, state FROM queue WHERE worktree = ? ORDER BY id DESC LIMIT 1").get(wt);
      await until(() => entry(c3.worktree)?.state === "waiting");
      const l4 = land(ws(c4.worktree), FAST, quiet);
      await until(() => entry(c4.worktree)?.state === "waiting");
      writeFileSync(go, "");
      finishEntry(d, blocker, "landed", "x");
      await until(() => existsSync(hit), 1200);
      const l2 = land(ws(c2.worktree), FAST, quiet); // takes its place back while C-3 holds the turn
      expect(stateOf(d, r)).toBe("waiting");
      writeFileSync(`${go}.release`, ""); // C-3's rebase goes on and picks its members
      const [o2, o4, code3] = await Promise.all([l2, l4, p3.exited]);
      expect([o2.kind, o4.kind, code3]).toEqual(["landed", "landed", 0]);
      const start = d.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'batch.start' ORDER BY id LIMIT 1").get();
      const members = (JSON.parse(start!.detail) as { members: { entry: number }[] }).members.map((m) => m.entry);
      expect(members).toEqual(max === 4 ? [r, entry(c4.worktree)!.id] : [r]);
    }, 60_000);
  }
});
