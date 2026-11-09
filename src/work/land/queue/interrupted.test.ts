import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FAST, HANG_SECONDS, boundedLoop, project, quiet, sh, startNew, ws, landingProcess } from "../../testkit.ts";
import { land } from "../land.ts";

// reason: these tests start the real CLI and kill it with SIGKILL, so they wait out real processes (C-111 gave TIMED to such tests).
const TIMED = 60_000;
const CLI = join(import.meta.dir, "../../../invocation/main.ts");

type Proc = ReturnType<typeof Bun.spawn>;
const spawnCanon = (cwd: string, args: string[], env: Record<string, string> = {}): Proc =>
  Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...(args.includes("land") ? landingProcess() : {}), ...env } });

async function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const p = spawnCanon(cwd, args, env);
  const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
  return { code: await p.exited, out, err };
}

async function waitFor(what: string, cond: () => boolean, ms = 30_000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const kinds = (root: string, subject: string) => ws(root).db.db.query<{ kind: string }, [string]>("SELECT kind FROM events WHERE subject = ? AND kind LIKE 'land.%' ORDER BY id").all(subject).map((r) => r.kind);
const detail = (root: string, kind: string) => JSON.parse(ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind)!.detail) as Record<string, unknown>;
const queueRows = (root: string) => ws(root).db.db.query<{ id: number; state: string; result: string | null }, []>("SELECT id, state, result FROM queue ORDER BY id").all();

/**
 * A pre-commit hook that touches `marker` when git starts it and holds the commit until `release` exists, as a slow
 * hook would; the test releases it after it has killed the lander, so git (which outlives its parent) finishes the
 * close commit when the test says, not after a guessed number of seconds. It gives up after LOOP_SECONDS.
 */
const holdingCommit = (marker: string, release: string) => `#!/bin/sh\ntouch ${marker}\n${boundedLoop(`[ ! -e ${release} ]`)}\n`;

/** Waits until the branch's top commit is the close commit of `change`. */
const closeCommitMade = (wt: string, change: string) => waitFor("the close commit", () => sh(wt, "log", "-1", "--format=%s").includes(change));

/** A project whose floor sleeps (as `exec sleep`, so its pid is the one in the pid file) only while CANON_TEST_SLOW is set. */
function slowProject() {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: 'test -z "$CANON_TEST_SLOW" || { echo $$ > "$CANON_TEST_PIDFILE"; exec sleep ${HANG_SECONDS}; }'\ntests: []\nreview: none\n`);
  sh(root, "commit", "-qam", "slow floor");
  const s = startNew(root, "Killed landing");
  const pidfile = `${root}.floor.pid`;
  return { root, s, pidfile, slow: { CANON_TEST_SLOW: "1", CANON_TEST_PIDFILE: pidfile } };
}

/** Starts `canon work land --finish` and returns once its floor is running, i.e. it holds the turn. */
async function landingInFloor(p: ReturnType<typeof slowProject>, extra: string[] = []) {
  const lander = spawnCanon(p.s.worktree, ["work", "land", "--finish", ...extra], p.slow);
  await waitFor("the floor to start", () => existsSync(p.pidfile));
  return lander;
}

async function kill9(p: ReturnType<typeof slowProject>, lander: Proc) {
  lander.kill("SIGKILL");
  await lander.exited;
  try {
    process.kill(Number(readFileSync(p.pidfile, "utf8").trim()), "SIGKILL"); // the orphaned floor
  } catch {}
}


/** A project whose update of main pauses once it is committed, so a landing can be killed right after main moved and before `land.ok`. */
async function killedAfterMainMoved(finish = true) {
  const root = project();
  const s = startNew(root, "Killed after main moved");
  const marker = `${root}.main.marker`;
  mkdirSync(join(root, ".git/hooks"), { recursive: true });
  const release = `${root}.main.release`;
  const done = `${root}.main.done`;
  writeFileSync(join(root, ".git/hooks/reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] && grep -q ' refs/heads/main$' && { touch ${marker}; ${boundedLoop(`[ ! -e ${release} ]`)}; touch ${done}; }\nexit 0\n`, { mode: 0o755 });
  const lander = spawnCanon(s.worktree, ["work", "land", ...(finish ? ["--finish"] : [])]);
  await waitFor("main to move", () => existsSync(marker));
  lander.kill("SIGKILL");
  await lander.exited;
  rmSync(join(root, ".git/hooks/reference-transaction"));
  writeFileSync(release, ""); // the git process that moved main outlives its parent: let it finish
  await waitFor("the git process that moved main to finish", () => existsSync(done));
  return { root, s, pid: lander.pid };
}

describe("land.start", () => {
  test("BR-2307: a landing records land.start with its own process before anything slow, and ends with a result event", async () => {
    const root = project();
    const s = startNew(root, "Lands");
    const p = spawnCanon(s.worktree, ["work", "land", "--finish"]);
    const [, code] = [await new Response(p.stderr as ReadableStream).text(), await p.exited];
    expect(code).toBe(0);
    expect(kinds(root, s.change)).toEqual(["land.start", "land.turn", "land.ok"]);
    const d = detail(root, "land.start");
    expect(d["pid"]).toBe(p.pid);
    expect(typeof d["pid_start"]).toBe("string");
    const order = ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind IN ('land.start','queue.enter') ORDER BY id").all().map((r) => r.kind);
    expect(order).toEqual(["land.start", "queue.enter"]);
  }, TIMED);

  test("BR-2307: a landing refused for uncommitted changes records land.start then land.refuse", async () => {
    const root = project();
    const s = startNew(root, "Dirty");
    writeFileSync(join(s.worktree, "scratch.txt"), "x\n");
    const r = await run(s.worktree, ["work", "land"]);
    expect(r.code).not.toBe(0);
    expect(kinds(root, s.change)).toEqual(["land.start", "land.refuse"]);
  }, TIMED);

  test("BR-2307: a landing refused because another executor holds the claim records no land.start", async () => {
    const root = project();
    const s = startNew(root, "Held");
    const r = await run(s.worktree, ["work", "land"], { CANON_ACTOR: "agent:b" });
    expect(r.code).toBe(5);
    expect(kinds(root, s.change)).toEqual([]);
  }, TIMED);

  test("BR-2307: SIGTERM while the close commit is made ends with land.killed, so it is not taken for a killed landing (BR-2099)", async () => {
    const root = project();
    const s = startNew(root, "Term early");
    const marker = `${root}.hook.marker`;
    // the close commit is the slow step before queueing; the signal is handled once it is done
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    const release = `${root}.hook.release`;
    writeFileSync(join(root, ".git/hooks/pre-commit"), holdingCommit(marker, release), { mode: 0o755 });
    const lander = spawnCanon(s.worktree, ["work", "land", "--finish"]);
    await waitFor("the close commit's hook", () => existsSync(marker));
    lander.kill("SIGTERM");
    writeFileSync(release, ""); // canon handles the signal once the commit is done
    expect(await lander.exited).toBe(143);
    rmSync(join(root, ".git/hooks/pre-commit"));
    expect(kinds(root, s.change).at(-1)).toBe("land.killed");
    expect(kinds(root, s.change)[0]).toBe("land.start");
    expect(detail(root, "land.killed")["signal"]).toBe("SIGTERM");
    const status = await run(root, ["work", "status"]);
    expect(status.out).not.toContain("INTERRUPTED");
  }, TIMED);
});

describe("canon work status lists landings without a result", () => {
  test("BR-2308: a landing killed with SIGKILL in its floor shows as interrupted, with its queue entry and the close commit; status changes nothing", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    const pid = lander.pid;
    const running = await run(p.root, ["work", "status"]);
    expect(running.out).toContain("landing running");
    expect(running.out).toContain(`process ${pid}`);
    expect(running.out).not.toContain("INTERRUPTED");
    await kill9(p, lander);
    const before = queueRows(p.root);
    expect(before.map((q) => q.state)).toEqual(["landing"]);
    const r = await run(p.root, ["work", "status"]);
    expect(r.out).toContain("INTERRUPTED");
    expect(r.out).toContain(`process ${pid}`);
    expect(r.out).toContain("no landing result was recorded");
    expect(r.out).toContain("(lander process gone)"); // the queue line
    expect(r.out).toContain("left behind: queue entry #1");
    expect(r.out).toContain("the close commit is the branch's top commit");
    expect(r.out).toContain(`canon work land\` again in ${p.s.worktree}`);
    expect(queueRows(p.root)).toEqual(before); // status is read-only
    expect(kinds(p.root, p.s.change)).not.toContain("claim.holder-gone"); // the one event status may write is a claim lapse, and this claim names the lander (BR-2360)
    expect(kinds(p.root, p.s.change)).toEqual(["land.start", "land.turn"]);
    const json = JSON.parse((await run(p.root, ["work", "status", "--json"])).out) as { landings: { state: string; pid: number }[] };
    expect(json.landings.map((a) => [a.state, a.pid])).toEqual([["interrupted", pid]]);
  }, TIMED);

  test("BR-2308: a landing killed while it made the close commit, before any queue entry, shows as interrupted", async () => {
    const root = project();
    const s = startNew(root, "Killed early");
    const marker = `${root}.hook.marker`;
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    const release = `${root}.hook.release`;
    writeFileSync(join(root, ".git/hooks/pre-commit"), holdingCommit(marker, release), { mode: 0o755 });
    const lander = spawnCanon(s.worktree, ["work", "land", "--finish"]);
    await waitFor("the close commit's hook", () => existsSync(marker));
    lander.kill("SIGKILL");
    await lander.exited;
    rmSync(join(root, ".git/hooks/pre-commit"));
    writeFileSync(release, ""); // git commit outlives its parent and finishes the close commit
    await closeCommitMade(s.worktree, s.change);
    const r = await run(root, ["work", "status"]);
    expect(r.out).toContain("INTERRUPTED");
    expect(queueRows(root)).toEqual([]);
    expect(r.out).not.toContain("left behind: queue entry");
    expect(r.out).toContain("the close commit is the branch's top commit");
  }, TIMED);

  test("BR-2308: a landing whose process is still alive shows as running, and status says nothing about a kill", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    const r = await run(p.root, ["work", "status"]);
    expect(r.out).toContain(`landing running, process ${lander.pid}`);
    expect(r.out).not.toContain("INTERRUPTED");
    expect(r.out).not.toContain("no landing result was recorded");
    await kill9(p, lander);
  }, TIMED);

  test("BR-2308: a landing killed after main moved and before land.ok shows as landed, with nothing left to take back", async () => {
    const { root, pid } = await killedAfterMainMoved();
    const r = await run(root, ["work", "status"]);
    expect(r.out).toContain("the landing reached main");
    expect(r.out).toContain(`process ${pid}`);
    expect(r.out).not.toContain("INTERRUPTED");
    expect(r.out).not.toContain("left behind");
    const json = JSON.parse((await run(root, ["work", "status", "--json"])).out) as { landings: { state: string }[] };
    expect(json.landings.map((a) => a.state)).toEqual(["landed"]);
  }, TIMED);

  test("BR-2308: landings that ended with any result event, or whose worktree is gone, are not listed", async () => {
    const root = project();
    const done = startNew(root, "Lands");
    expect((await run(done.worktree, ["work", "land", "--finish"])).code).toBe(0);
    const dirty = startNew(root, "Refused");
    writeFileSync(join(dirty.worktree, "scratch.txt"), "x\n");
    expect((await run(dirty.worktree, ["work", "land"])).code).not.toBe(0);
    const list = (await run(root, ["work", "status"])).out;
    expect(list).toContain("Landings with no result yet:");
    expect(list).not.toContain("INTERRUPTED");
    expect(list).not.toContain("landing running");
    // a killed one whose worktree is then removed
    const p = slowProject();
    const lander = await landingInFloor(p);
    await kill9(p, lander);
    expect((await run(p.root, ["work", "status"])).out).toContain("INTERRUPTED");
    sh(p.root, "worktree", "remove", "--force", p.s.worktree);
    expect((await run(p.root, ["work", "status"])).out).not.toContain("INTERRUPTED");
  }, TIMED);

  test("BR-2308: a landing killed and then landed again by the same worktree is not listed", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    await kill9(p, lander);
    expect((await run(p.s.worktree, ["work", "land", "--finish"])).code).toBe(0);
    expect((await run(p.root, ["work", "status"])).out).not.toContain("INTERRUPTED");
  }, TIMED);

  test("BR-2308: no recorded process, or a landing whose process table cannot say, is unknown and is not called killed", async () => {
    const root = project();
    const s = startNew(root, "Unknown");
    ws(s.worktree).db.event("agent:a", "land.start", s.change, { pid: null, pid_start: null });
    const r = await run(root, ["work", "status"]);
    expect(r.out).toContain("could not be read");
    expect(r.out).not.toContain("INTERRUPTED");
  }, TIMED);
});

describe("the next landing and the other commands report a killed landing", () => {
  test("BR-2309: the next landing from the worktree says the previous one was killed, takes back its close commit, and records land.interrupt", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    const killedPid = lander.pid;
    await kill9(p, lander);
    const r = await run(p.s.worktree, ["work", "land", "--finish"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("landing INTERRUPTED");
    expect(r.out).toContain(`process ${killedPid}`);
    expect(r.out).toContain("reopened"); // the close commit
    expect(kinds(p.root, p.s.change)).toEqual(["land.start", "land.turn", "land.interrupt", "land.start", "land.turn", "land.ok"]);
    const d = detail(p.root, "land.interrupt");
    expect(d["pid"]).toBe(killedPid);
    expect(d["close_commit_reopened"]).toBe(true);
    expect(d["queue"]).toEqual([1]);
  }, TIMED);

  test("BR-2309: a landing killed after the close commit and before it queued is reported by the next landing, which takes the close commit back", async () => {
    const root = project();
    const s = startNew(root, "Killed before queueing");
    const marker = `${root}.hook.marker`;
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    const release = `${root}.hook.release`;
    writeFileSync(join(root, ".git/hooks/pre-commit"), holdingCommit(marker, release), { mode: 0o755 });
    const lander = spawnCanon(s.worktree, ["work", "land", "--finish"]);
    await waitFor("the close commit's hook", () => existsSync(marker));
    lander.kill("SIGKILL");
    await lander.exited;
    rmSync(join(root, ".git/hooks/pre-commit"));
    writeFileSync(release, ""); // git commit outlives its parent and finishes the close commit
    await closeCommitMade(s.worktree, s.change);
    expect(sh(s.worktree, "log", "-1", "--format=%s")).toContain(s.change);
    const r = await run(s.worktree, ["work", "land", "--finish"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("landing INTERRUPTED");
    expect(r.out).toContain(`process ${lander.pid}`);
    expect(r.out).toContain("reopened");
    expect(kinds(root, s.change)).toEqual(["land.start", "land.interrupt", "land.start", "land.turn", "land.ok"]);
    expect(detail(root, "land.interrupt")["close_commit_reopened"]).toBe(true);
    expect(detail(root, "land.interrupt")["queue"]).toEqual([]);
  }, TIMED);

  test("BR-2309: a landing killed after main moved and before land.ok is recorded as landed: no close commit taken back, no entry abandoned", async () => {
    const { root, s, pid } = await killedAfterMainMoved();
    const mainBefore = sh(root, "rev-parse", "main");
    expect(sh(root, "log", "-1", "--format=%s", "main")).toContain(s.change); // main holds the close commit
    expect(kinds(root, s.change)).toEqual(["land.start", "land.turn"]);
    const r = await run(s.worktree, ["work", "land", "--finish"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("the landing reached main");
    expect(r.out).toContain(`process ${pid}`);
    expect(r.out).not.toContain("INTERRUPTED");
    expect(r.out).not.toContain("reopened");
    expect(sh(root, "rev-parse", "main")).toBe(mainBefore); // nothing landed a second time
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(mainBefore); // the branch still has the close commit
    expect(queueRows(root).map((q) => q.state)).toEqual(["landed"]);
    expect(kinds(root, s.change)).toEqual(["land.start", "land.turn", "land.ok"]);
    const ok = detail(root, "land.ok");
    expect(ok["recovered"]).toBe(true);
    expect(ok["sha"]).toBe(mainBefore);
    expect(await run(root, ["work", "status"])).toMatchObject({ out: expect.not.stringContaining("reached main") });
    expect(ws(root).db.db.query("SELECT 1 FROM claims WHERE subject = ?").all(s.change)).toEqual([]); // --finish released the claim
  }, TIMED);

  test("BR-2309: a refusal right after the report still gave up the dead queue entry and reported once", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    await kill9(p, lander);
    writeFileSync(join(p.s.worktree, "scratch.txt"), "x\n"); // uncommitted: the next landing is refused for it
    const first = await run(p.s.worktree, ["work", "land"]);
    expect(first.out).toContain("landing INTERRUPTED");
    expect(first.err).toContain("land refused (dirty)");
    expect(queueRows(p.root)).toEqual([{ id: 1, state: "abandoned", result: "lander process gone" }]);
    const again = await run(p.s.worktree, ["work", "land"]);
    expect(again.out).not.toContain("INTERRUPTED");
    expect(kinds(p.root, p.s.change).filter((k) => k === "land.interrupt")).toHaveLength(1);
  }, TIMED);

  test("BR-2380: a landing killed with SIGKILL and run again from the same worktree takes its old queue entry back, whichever lander finds it gone", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    await kill9(p, lander);
    const r = await run(p.s.worktree, ["work", "land"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("landing INTERRUPTED");
    expect(queueRows(p.root)).toEqual([{ id: 1, state: "landed", result: expect.any(String) }]); // entry 1 again, not a new entry at the tail
    expect(detail(p.root, "queue.enter")).toMatchObject({ kept_place: 1, kept_after: "abandoned" });
    expect(detail(p.root, "queue.abandon")).toMatchObject({ entry: 1, reason: "lander process gone" });
  }, TIMED);

  test("BR-2309: a rebase stopped midway is named with git rebase --abort and left as it is", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    await kill9(p, lander);
    // main moves and conflicts with the change's file; the person starts a rebase that stops
    writeFileSync(join(p.root, "x.txt"), "main\n");
    sh(p.root, "add", "-A");
    sh(p.root, "commit", "-qm", "main moves");
    writeFileSync(join(p.s.worktree, "x.txt"), "branch\n");
    sh(p.s.worktree, "add", "-A");
    sh(p.s.worktree, "commit", "-qm", "branch x");
    const gitDir = sh(p.s.worktree, "rev-parse", "--path-format=absolute", "--git-dir");
    Bun.spawnSync(["git", "rebase", "main"], { cwd: p.s.worktree, stdout: "pipe", stderr: "pipe" });
    expect(existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))).toBe(true);
    const status = await run(p.root, ["work", "status"]);
    expect(status.out).toContain("a rebase stopped midway");
    const r = await run(p.s.worktree, ["work", "land"]);
    expect(r.out).toContain("landing INTERRUPTED");
    expect(r.out).toContain("git rebase --abort");
    expect(existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))).toBe(true);
    expect(detail(p.root, "land.interrupt")["rebase_in_progress"]).toBe(true);
    expect(detail(p.root, "land.interrupt")["close_commit_reopened"]).toBe(false);
  }, TIMED);

  test("BR-2309: a previous landing that ended with a result event is not reported", async () => {
    const root = project();
    const s = startNew(root, "Refused first");
    writeFileSync(join(s.worktree, "scratch.txt"), "x\n");
    expect((await run(s.worktree, ["work", "land"])).code).not.toBe(0);
    rmSync(join(s.worktree, "scratch.txt"));
    const r = await run(s.worktree, ["work", "land"]);
    expect(r.out).not.toContain("INTERRUPTED");
    expect(r.out).not.toContain("still running");
    expect(kinds(root, s.change)).not.toContain("land.interrupt");
  }, TIMED);

  test("BR-2309: a landing process that finds the previous landing still running only says so", async () => {
    const p = slowProject();
    const lander = await landingInFloor(p);
    const r = await run(p.s.worktree, ["work", "land", "--timeout", "0.02"]);
    expect(r.out).toContain(`still running (process ${lander.pid}`);
    expect(kinds(p.root, p.s.change)).not.toContain("land.interrupt");
    await kill9(p, lander);
  }, TIMED);

  test("BR-2310: after-land for a change whose landing was killed names it; a running one is named too; a never-landed one is unchanged", async () => {
    const p = slowProject();
    const never = startNew(p.root, "Never landed");
    const plain = await run(p.root, ["work", "after-land", never.change]);
    expect(plain.code).toBe(3);
    expect(plain.err.trim()).toBe(`canon: no landing of ${never.change} ran background after_land commands`);
    const lander = await landingInFloor(p);
    const running = await run(p.root, ["work", "after-land", p.s.change]);
    expect(running.code).toBe(3);
    expect(running.err).toContain("landing running");
    await kill9(p, lander);
    const killed = await run(p.root, ["work", "after-land", p.s.change]);
    expect(killed.code).toBe(3);
    expect(killed.err).toContain("landing INTERRUPTED");
    expect(killed.err).toContain(`process ${lander.pid}`);
  }, TIMED);

  test("BR-2310: after-land for a change whose landing reached main before it was killed says so, and that after_land did not run", async () => {
    const { root, s, pid } = await killedAfterMainMoved();
    const r = await run(root, ["work", "after-land", s.change]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("the landing reached main");
    expect(r.err).toContain(`process ${pid}`);
    expect(r.err).toContain("after_land commands did not run");
  }, TIMED);

  test("BR-2310: brief in the worktree of a killed landing says so; otherwise its output has no such line", async () => {
    const p = slowProject();
    const before = await run(p.s.worktree, ["brief"]);
    expect(before.out).not.toContain("INTERRUPTED");
    const lander = await landingInFloor(p);
    await kill9(p, lander);
    const after = await run(p.s.worktree, ["brief"]);
    expect(after.out).toContain("landing INTERRUPTED");
    expect(after.out).toContain(`process ${lander.pid}`);
  }, TIMED);
});

// reason: the in-process land() entry point records the same start, so tests that call it directly see it (BR-2307).
test("BR-2307: land() called in process records the test process as the lander", async () => {
  const root = project();
  const s = startNew(root, "In process");
  const out = await land(ws(s.worktree), FAST, quiet);
  expect(out.kind).toBe("landed");
  expect(detail(root, "land.start")["pid"]).toBe(process.pid);
});
