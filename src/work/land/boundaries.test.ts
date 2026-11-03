import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims, takeClaim } from "../claims/claims.ts";
import { enqueue, finishEntry, tryTurn } from "./queue.ts";
import { start } from "../session/session.ts";
import { land, predictedConflicts } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

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
    expect(out).toEqual({ kind: "timeout", ahead: 1 });
    expect(events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["timeout"]);
  });

  test("BR-2048 BR-2172: time spent in another lander's batch moves the deadline later, so a member that comes back keeps its wait (issue #75)", async () => {
    const root = project();
    const s = startNew(root, "Batched");
    writeFileSync(join(s.worktree, "b.txt"), "b\n");
    sh(s.worktree, "add", "b.txt");
    sh(s.worktree, "commit", "-qm", "b");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-98", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true); // someone else is landing the whole time
    const leader = enqueue(other.db, "/leader", "C-99", "agent:b");
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const landing = land(ws(s.worktree), { finish: false, timeoutMs: 3000 }, quiet);
    let mine: number | undefined;
    for (let i = 0; i < 50 && mine === undefined; i++) {
      mine = other.db.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE worktree = ?").get(s.worktree)?.id;
      if (mine === undefined) await Bun.sleep(20);
    }
    other.db.db.query("UPDATE queue SET batch = ?, head = ? WHERE id = ?").run(leader, sh(s.worktree, "rev-parse", "HEAD"), mine!);
    await Bun.sleep(4500); // in the batch past the 3 s timeout
    finishEntry(other.db, leader, "failed", "floor"); // the batch fell through; the member waits again
    await Bun.sleep(2500); // past the old deadline, within the moved one
    expect(other.db.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(mine!)?.state).toBe("waiting");
    expect(events(root, "land.refuse")).toEqual([]);
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
  }, TIMED);

  test("BR-2049: the heartbeat runs through the whole landing, so a slow step is not mistaken for a dead lander", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nlander_stale_minutes: 0.02\nhooks:\n  before_land: sleep 3\n");
    sh(root, "commit", "-qam", "slow before_land, 1.2 s stale time");
    const s = startNew(root, "Slow");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const other = ws(root, "agent:b");
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(2200); // well past the 1.2 s stale time, while before_land still sleeps
    const b = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, b, 1200).mine).toBe(false);
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
    let mine: number | undefined;
    for (let i = 0; i < 50 && mine === undefined; i++) {
      await Bun.sleep(100);
      mine = other.db.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE worktree = ?").get(s.worktree)?.id;
    }
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
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nhooks:\n  before_land: sleep 1.5\n");
    sh(root, "commit", "-qam", "slow before_land");
    const s = startNew(root, "Skipped mid-turn");
    writeFileSync(join(s.worktree, "m.txt"), "m\n");
    sh(s.worktree, "add", "m.txt");
    sh(s.worktree, "commit", "-qm", "m");
    const other = ws(root, "agent:b");
    const before = sh(root, "rev-parse", "main");
    const landing = land(ws(s.worktree), FAST, quiet);
    const landingNow = () => other.db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM queue WHERE worktree = ? AND state = 'landing'").get(s.worktree)?.n === 1;
    for (let i = 0; i < 100 && !landingNow(); i++) await Bun.sleep(50);
    await Bun.sleep(300); // inside before_land
    other.db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE worktree = ?").run(s.worktree);
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
    await Bun.sleep(300);
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
    const s = startNew(root, "Waits cleanly");
    writeFileSync(join(s.worktree, "mine.txt"), "m\n");
    sh(s.worktree, "add", "mine.txt");
    sh(s.worktree, "commit", "-qm", "mine");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(300);
    writeFileSync(join(root, "theirs.txt"), "t\n");
    sh(root, "add", "theirs.txt");
    sh(root, "commit", "-qm", "theirs");
    await Bun.sleep(2500); // at least one more look at main while waiting
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
  }, 20_000); // reason: waits through more than one 2 s queue poll on purpose

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
    for (let i = 0; i < 50 && !existsSync(marker); i++) await Bun.sleep(100);
    const [base, head, change] = readFileSync(marker, "utf8").trim().split(" ");
    expect(head).toBe(sh(root, "rev-parse", "main"));
    expect(base).toBe(sh(root, "rev-parse", "main~2")); // the open-change commit and x are the landed ones
    expect(change).toBe(s.change);
  });
});
