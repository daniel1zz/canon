import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims, takeClaim } from "../claims/claims.ts";
import { enqueue, finishEntry, heartbeat, tryTurn } from "./queue/queue.ts";
import { start } from "../session/session.ts";
import { land } from "./land.ts";
import { predictedConflicts } from "./queue/wait.ts";
import { FAST, boundedLoop, project, quiet, sh, startNew, waitFor, ws } from "../testkit.ts";

// reason: these tests wait out real time on purpose (sleeps, leases, stale times) or drive a spawned `canon work land`;
// under load that alone came within 0.4 s of the 5 s default (C-111), so they get room, not the rest of the file.
const TIMED = 30_000;

describe("boundaries record and clean up", () => {
  const events = (root: string, kind: string) =>
    ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind);

  test("BR-2026: early land refusals and a refused claim are recorded with their reason", async () => {
    const root = project();
    const s = startNew(root, "Dirty");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    await land(ws(s.worktree), FAST, quiet);
    expect(await land(ws(root), FAST, quiet)).toMatchObject({ kind: "refused", reason: "on-main" });
    takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b");
    const reasons = events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason);
    expect(reasons).toEqual(["dirty", "on-main"]);
    expect(events(root, "claim.refuse").map((e) => e.subject)).toEqual([s.change]);
  });

  test("BR-2026: starting a missing or closed change, and --finish without a claim, are recorded with their own reasons", async () => {
    const root = project();
    const s = startNew(root, "Closed");
    expect((await land(ws(s.worktree), { ...FAST, finish: true }, quiet)).kind).toBe("landed");
    expect(start(ws(root), { change: s.change }, quiet).ok).toBe(false);
    expect(start(ws(root), { change: "C-99" }, quiet).ok).toBe(false);
    expect(events(root, "start.refuse").map((e) => [e.subject, JSON.parse(e.detail).reason])).toEqual([
      [s.change, "not-open"],
      ["C-99", "not-found"],
    ]);
    sh(root, "worktree", "add", "-q", "-b", "loose", join(root, "..", `${root.split("/").pop()}-loose`), "main");
    const loose = join(root, "..", `${root.split("/").pop()}-loose`);
    expect(await land(ws(loose), { ...FAST, finish: true }, quiet)).toMatchObject({ kind: "refused", reason: "no-claim" });
  });

  test("BR-2043: a project without a floor cannot land anything", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "tests: []\n");
    sh(root, "commit", "-qam", "no floor");
    const s = startNew(root, "No floor");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("no-floor");
  });

  test("BR-2048: a lander that waits past its timeout gives up and records it", async () => {
    const root = project();
    const s = startNew(root, "Waiting");
    writeFileSync(join(s.worktree, "w.txt"), "w\n");
    sh(s.worktree, "add", "w.txt");
    sh(s.worktree, "commit", "-qm", "w");
    const other = ws(root);
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true); // someone else is landing right now
    const out = await land(ws(s.worktree), { finish: false, timeoutMs: 0 }, quiet);
    expect(out).toMatchObject({ kind: "timeout", ahead: 1 }); // and it keeps its place (BR-2368)
    expect(events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["timeout"]);
  });

  test("BR-2048 BR-2172: time spent in another lander's batch moves the deadline later, so a member that comes back keeps its wait (issue #75)", async () => {
    const root = project();
    // a stale time of 1.8 s makes a waiting lander look at the queue every 0.6 s (waitPollMs); the fake entries beat below
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nreview: none\nlander_stale_minutes: 0.03\n");
    sh(root, "commit", "-qam", "short stale time");
    const s = startNew(root, "Batched");
    writeFileSync(join(s.worktree, "b.txt"), "b\n");
    sh(s.worktree, "add", "b.txt");
    sh(s.worktree, "commit", "-qm", "b");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-98", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true); // someone else is landing the whole time
    const leader = enqueue(other.db, "/leader", "C-99", "agent:b");
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const beats = setInterval(() => [ahead, leader].forEach((id) => heartbeat(other.db, id)), 100);
    try {
      const said: string[] = [];
      const timeoutMs = 1500;
      const t0 = Date.now();
      const landing = land(ws(s.worktree), { finish: false, timeoutMs }, (l) => said.push(l));
      const mineId = () => other.db.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE worktree = ?").get(s.worktree)?.id;
      await waitFor("the landing to queue", () => mineId() !== undefined);
      const mine = mineId()!;
      other.db.db.query("UPDATE queue SET batch = ?, head = ? WHERE id = ?").run(leader, sh(s.worktree, "rev-parse", "HEAD"), mine);
      await waitFor("the landing to see that it is in a batch", () => said.some((l) => l.includes("being tested in the batch")));
      await waitFor("the batch to run past the timeout", () => Date.now() > t0 + timeoutMs + 200);
      finishEntry(other.db, leader, "failed", "floor"); // the batch fell through; the member waits again
      const beat = () => other.db.db.query<{ heartbeat: string }, [number]>("SELECT heartbeat FROM queue WHERE id = ?").get(mine)!.heartbeat;
      const seen = beat();
      await waitFor("the member to look at the queue again", () => beat() !== seen); // every look is its heartbeat; this one is past the old deadline
      expect(other.db.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(mine)?.state).toBe("waiting");
      expect(events(root, "land.refuse")).toEqual([]);
      finishEntry(other.db, ahead, "landed", "x");
      expect((await landing).kind).toBe("landed");
    } finally {
      clearInterval(beats);
    }
  }, TIMED);

  test("BR-2049: the heartbeat runs through the whole landing, so a slow step is not mistaken for a dead lander", async () => {
    const root = project();
    // before_land holds the landing until the test releases it, so the slow step lasts exactly as long as the test needs
    const marker = join(root, "..", `${root.split("/").pop()}-before-land`);
    const release = `${marker}.release`;
    writeFileSync(`${marker}.sh`, `touch ${marker}\n${boundedLoop(`[ ! -e ${release} ]`)}\n`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nlander_stale_minutes: 0.02\nhooks:\n  before_land: sh ${marker}.sh\n`);
    sh(root, "commit", "-qam", "slow before_land, 1.2 s stale time");
    const s = startNew(root, "Slow");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const other = ws(root, "agent:b");
    const landing = land(ws(s.worktree), FAST, quiet);
    await waitFor("before_land to start", () => existsSync(marker));
    const beat = () => Date.parse(other.db.db.query<{ heartbeat: string }, [string]>("SELECT heartbeat FROM queue WHERE worktree = ?").get(s.worktree)!.heartbeat);
    const first = beat();
    await waitFor("a heartbeat more than the 1.2 s stale time after the first, while before_land still holds", () => beat() > first + 1200); // the landing kept beating through the slow step
    const b = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, b, 1200).mine).toBe(false);
    writeFileSync(release, "");
    expect((await landing).kind).toBe("landed");
    expect(tryTurn(other.db, b, 1200).mine).toBe(true);
  }, TIMED);

  test("BR-2144: a lander whose waiting entry was marked abandoned is refused when it wakes, and nothing moves", async () => {
    const root = project();
    const s = startNew(root, "Skipped");
    writeFileSync(join(s.worktree, "s.txt"), "s\n");
    sh(s.worktree, "add", "s.txt");
    sh(s.worktree, "commit", "-qm", "s");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const before = sh(root, "rev-parse", "main");
    const landing = land(ws(s.worktree), FAST, quiet);
    const mineId = () => other.db.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE worktree = ?").get(s.worktree)?.id;
    await waitFor("the landing to queue", () => mineId() !== undefined);
    const mine = mineId();
    // A later lander saw this entry silent past the stale time and skipped it; then the one ahead finishes.
    other.db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE id = ?").run(mine!);
    finishEntry(other.db, ahead, "landed", "x");
    const out = await landing;
    expect(out.kind === "refused" && out.reason).toBe("lost-turn");
    expect(out.kind === "refused" && out.message).toContain("main was not moved");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(other.db.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(mine!)?.state).toBe("abandoned");
    expect(events(root, "land.lost").map((e) => JSON.parse(e.detail).stage)).toEqual(["queue"]);
    expect(events(root, "land.refuse")).toEqual([]);
    expect(events(root, "land.turn")).toEqual([]);
  });

  test("BR-2144: a lander marked abandoned during its turn does not move main", async () => {
    const root = project();
    const marker = join(root, "..", `${root.split("/").pop()}-before-land`);
    const release = `${marker}.release`;
    writeFileSync(`${marker}.sh`, `touch ${marker}\n${boundedLoop(`[ ! -e ${release} ]`)}\n`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nhooks:\n  before_land: sh ${marker}.sh\n`);
    sh(root, "commit", "-qam", "slow before_land");
    const s = startNew(root, "Skipped mid-turn");
    writeFileSync(join(s.worktree, "m.txt"), "m\n");
    sh(s.worktree, "add", "m.txt");
    sh(s.worktree, "commit", "-qm", "m");
    const other = ws(root, "agent:b");
    const before = sh(root, "rev-parse", "main");
    const landing = land(ws(s.worktree), FAST, quiet);
    await waitFor("before_land to start", () => existsSync(marker)); // the landing holds the turn and is inside before_land
    other.db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE worktree = ?").run(s.worktree);
    writeFileSync(release, "");
    const out = await landing;
    expect(out.kind === "refused" && out.reason).toBe("lost-turn");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(events(root, "land.lost").map((e) => JSON.parse(e.detail).stage)).toEqual(["before-main"]);
  });

  test("BR-2153: a conflict with a main that moved while waiting refuses at once, before the turn, leaving the worktree as it was", async () => {
    const root = project();
    const s = startNew(root, "Waits and conflicts");
    writeFileSync(join(s.worktree, "app.txt"), "one\n2\nthree\n");
    sh(s.worktree, "commit", "-qam", "mine");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true); // someone else holds the turn throughout
    const landing = land(ws(s.worktree), FAST, quiet);
    await waitFor("the landing to wait in the queue", () => other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(s.worktree) !== null);
    writeFileSync(join(root, "app.txt"), "one\nTWO\nthree\n"); // another change lands meanwhile
    sh(root, "commit", "-qam", "theirs");
    const started = Date.now();
    const out = await landing;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.kind === "refused" && out.reason).toBe("conflict");
    expect(out.kind === "refused" && out.message).toContain("conflicts in: app.txt");
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(other.db.db.query<{ state: string }, [string]>("SELECT state FROM queue WHERE worktree = ?").get(s.worktree)?.state).toBe("failed");
    expect(other.db.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(ahead)?.state).toBe("landing");
    expect(events(root, "land.turn")).toEqual([]);
    expect(events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["conflict"]);
  });

  test("BR-2153: a main that moved without a conflict keeps the lander waiting, and it lands after the one ahead", async () => {
    const root = project();
    // a stale time of 1.8 s makes a waiting lander look at the queue every 0.6 s (waitPollMs); the entry ahead beats below
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nreview: none\nlander_stale_minutes: 0.03\n");
    sh(root, "commit", "-qam", "short stale time");
    const s = startNew(root, "Waits cleanly");
    writeFileSync(join(s.worktree, "mine.txt"), "m\n");
    sh(s.worktree, "add", "mine.txt");
    sh(s.worktree, "commit", "-qm", "mine");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const beats = setInterval(() => heartbeat(other.db, ahead), 100);
    try {
      const landing = land(ws(s.worktree), FAST, quiet);
      const beat = () => other.db.db.query<{ heartbeat: string }, [string]>("SELECT heartbeat FROM queue WHERE worktree = ?").get(s.worktree)?.heartbeat;
      await waitFor("the landing to wait in the queue", () => beat() !== undefined);
      writeFileSync(join(root, "theirs.txt"), "t\n");
      sh(root, "add", "theirs.txt");
      sh(root, "commit", "-qm", "theirs");
      // every look at the queue is a heartbeat: two changes after the commit mean one whole look at main, begun after it, is done
      for (let n = 0; n < 2; n++) {
        const seen = beat();
        await waitFor("the landing to look at the queue again", () => beat() !== seen);
      }
      expect(other.db.db.query<{ state: string }, [string]>("SELECT state FROM queue WHERE worktree = ?").get(s.worktree)?.state).toBe("waiting"); // the moved main did not send it away or let it jump the queue
      finishEntry(other.db, ahead, "landed", "x");
      expect((await landing).kind).toBe("landed");
    } finally {
      clearInterval(beats);
    }
  });

  test("BR-2153: a prediction that cannot run is reported, not a refusal", () => {
    const root = project();
    const p = predictedConflicts(root, "0000000000000000000000000000000000000000");
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toContain("git merge-tree exited");
    expect(predictedConflicts(root, "main")).toEqual({ ok: true, files: [] });
  });

  test("BR-2031: landing from main is refused", async () => {
    const root = project();
    const out = await land(ws(root), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("on-main");
  });

  test("BR-2029: a failed setup removes the new worktree and releases the change, so a retry starts clean", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nsetup: \"test -e .ok\"\n");
    sh(root, "commit", "-qam", "setup that fails");
    const first = start(ws(root), { title: "Needs setup" }, quiet);
    expect(first.ok).toBe(false);
    expect(claims(ws(root).db)).toEqual([]);
    const wts = sh(root, "worktree", "list");
    expect(wts.split("\n").length).toBe(1);
    expect(sh(root, "branch", "--list", "change/*")).toBe("");
    expect(events(root, "start.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["setup"]);
  });

  test("BR-2030: after_land runs in the background with the landing's commits and never changes the result", async () => {
    const root = project();
    const marker = join(root, "..", `${root.split("/").pop()}-after.txt`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nhooks:\n  after_land: 'echo "$CANON_BASE $CANON_HEAD $CANON_CHANGE" > ${marker}; exit 7'\n`);
    sh(root, "commit", "-qam", "after_land");
    const s = startNew(root, "With hook");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    await waitFor("after_land to write its file", () => existsSync(marker) && readFileSync(marker, "utf8").endsWith("\n"));
    const [base, head, change] = readFileSync(marker, "utf8").trim().split(" ");
    expect(head).toBe(sh(root, "rev-parse", "main"));
    expect(base).toBe(sh(root, "rev-parse", "main~2")); // the open-change commit and x are the landed ones
    expect(change).toBe(s.change);
  });
});
