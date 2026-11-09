import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedLoop, project, sh, startNew, waitFor, ws } from "../testkit.ts";
import { isGone, processOf } from "../claims/liveness.ts";
import { backgroundRun } from "./detach.ts";

// reason: these tests start the real CLI, whose landing runs in a background process they wait for and signal (D-80).
const TIMED = 60_000;
const CLI = join(import.meta.dir, "../../invocation/main.ts");

/**
 * A project whose floor writes CANON_LAND_RUN as it sees it into `envfile`; while CANON_TEST_SLOW is set it also writes
 * its pid, waits until `release` exists and fails when `failfile` exists.
 */
function heldProject() {
  const root = project();
  const base = `${root}.held`;
  const f = { envfile: `${base}.env`, pidfile: `${base}.pid`, release: `${base}.release`, failfile: `${base}.fail` };
  const held = `{ echo $$ > ${f.pidfile}; ${boundedLoop(`[ ! -e ${f.release} ]`)}; test ! -e ${f.failfile}; }`;
  writeFileSync(join(root, "canon/config.yaml"), `floor: 'printf %s "$CANON_LAND_RUN" > ${f.envfile}; test -z "$CANON_TEST_SLOW" || ${held}'\ntests: []\nreview: none\n`);
  sh(root, "commit", "-qam", "held floor");
  const s = startNew(root, "Background landing");
  return { root, s, ...f };
}

function follower(cwd: string, args: string[] = [], slow = true) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a", ...(slow ? { CANON_TEST_SLOW: "1" } : {}) };
  delete env["CLAUDECODE"]; // the --as hook reminder is the follower's own line (BR-2342), not the landing's
  return Bun.spawn(["bun", CLI, "work", "land", ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
}

async function result(p: ReturnType<typeof follower>) {
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const starts = (root: string) =>
  ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.start' ORDER BY id").all().map((r) => JSON.parse(r.detail) as { pid: number; pid_start: string; run?: string });
const kinds = (root: string) => ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind LIKE 'land.%' ORDER BY id").all().map((r) => r.kind);

describe("the landing runs in a background process (D-80)", () => {
  test("BR-2390 BR-2307: canon work land prints the background landing's output and exits with its code; the landing is another process with its run directory", async () => {
    const h = heldProject();
    const p = follower(h.s.worktree, [], false);
    const r = await result(p);
    expect(r.code).toBe(0);
    expect(r.out).toContain("landed");
    const [start] = starts(h.root);
    expect(start!.pid).not.toBe(p.pid);
    expect(readFileSync(join(start!.run!, "out"), "utf8")).toBe(r.out);
    expect(readFileSync(join(start!.run!, "exit"), "utf8")).toBe("0");
    expect(existsSync(join(start!.run!, "seen"))).toBe(true);
    expect(readFileSync(h.envfile, "utf8")).toStartWith(`${p.pid}:`);
  }, TIMED);

  test("BR-2390: only the process whose parent is the follower named in CANON_LAND_RUN is the background landing", () => {
    expect(backgroundRun({ CANON_LAND_RUN: "41:/x/run" }, 41)).toBe("/x/run");
    expect(backgroundRun({ CANON_LAND_RUN: "41:/x/run" }, 42)).toBeUndefined();
    expect(backgroundRun({ CANON_LAND_RUN: "/x/run" }, 41)).toBeUndefined();
    expect(backgroundRun({}, 41)).toBeUndefined();
  });

  test("BR-2390: a refusal in the background landing is printed on standard error with its exit code", async () => {
    const h = heldProject();
    writeFileSync(join(h.s.worktree, "loose.txt"), "x");
    const r = await result(follower(h.s.worktree, [], false));
    expect(r.code).toBe(2);
    expect(r.err).toContain("uncommitted");
  }, TIMED);

  test("BR-2390 BR-2022 BR-2309: a background landing killed by SIGKILL makes the follower say it ended without a result and exit 75; landing again cleans it up", async () => {
    const h = heldProject();
    const p = follower(h.s.worktree);
    await waitFor("the floor to start", () => existsSync(h.pidfile));
    const lander = starts(h.root)[0]!;
    process.kill(lander.pid, "SIGKILL");
    process.kill(Number(readFileSync(h.pidfile, "utf8").trim()), "SIGKILL"); // the orphaned floor
    const r = await result(p);
    expect(r.code).toBe(75);
    expect(r.err).toContain("ended without recording a result");
    const again = await result(follower(h.s.worktree, [], false));
    expect(again.code).toBe(0);
    expect(kinds(h.root)).toContain("land.interrupt");
    expect(starts(h.root).length).toBe(2);
  }, TIMED);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`BR-2391 BR-2022: ${signal} to the follower only detaches it: exit 75, and the background landing still lands`, async () => {
      const h = heldProject();
      const p = follower(h.s.worktree);
      await waitFor("the floor to start", () => existsSync(h.pidfile));
      p.kill(signal);
      const r = await result(p);
      expect(r.code).toBe(75);
      expect(r.err).toContain("detached");
      expect(r.err).toContain("canon work land --stop");
      writeFileSync(h.release, "");
      await waitFor("the landing to land", () => kinds(h.root).includes("land.ok"));
      expect(kinds(h.root)).not.toContain("land.killed");
    }, TIMED);
  }

  test("BR-2391: a follower that gets no signal says nothing about detaching", async () => {
    const h = heldProject();
    const r = await result(follower(h.s.worktree, [], false));
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("detached");
  }, TIMED);
});

describe("following a landing again (D-80)", () => {
  test("BR-2392: landing again while the background landing runs follows it instead of starting another", async () => {
    const h = heldProject();
    const first = follower(h.s.worktree);
    await waitFor("the floor to start", () => existsSync(h.pidfile));
    first.kill("SIGTERM");
    expect((await result(first)).code).toBe(75);
    const again = follower(h.s.worktree);
    await Bun.sleep(300);
    writeFileSync(h.release, "");
    const r = await result(again);
    expect(r.code).toBe(0);
    expect(r.err).toContain("still running");
    expect(r.out).toContain("landed");
    expect(starts(h.root).length).toBe(1);
  }, TIMED);

  test("BR-2392: a landing that ended while nothing followed it is reported once with its code; the next run lands anew", async () => {
    const h = heldProject();
    const first = follower(h.s.worktree);
    await waitFor("the floor to start", () => existsSync(h.pidfile));
    first.kill("SIGTERM");
    expect((await result(first)).code).toBe(75);
    writeFileSync(h.failfile, "");
    writeFileSync(h.release, "");
    await waitFor("the landing to be refused", () => kinds(h.root).includes("land.refuse"));
    const run = starts(h.root)[0]!.run!;
    await waitFor("its exit code", () => existsSync(join(run, "exit")));
    const report = await result(follower(h.s.worktree, [], false));
    expect(report.code).toBe(1);
    expect(report.err).toContain("ended while nothing followed it");
    expect(report.err).toContain("land refused (floor)");
    expect(starts(h.root).length).toBe(1);
    const anew = await result(follower(h.s.worktree, [], false));
    expect(anew.code).toBe(0);
    expect(starts(h.root).length).toBe(2);
  }, TIMED);

  test("BR-2392: after a follower printed the end, landing again starts a new landing", async () => {
    const h = heldProject();
    writeFileSync(join(h.s.worktree, "loose.txt"), "x");
    expect((await result(follower(h.s.worktree, [], false))).code).toBe(2);
    sh(h.s.worktree, "add", "loose.txt");
    sh(h.s.worktree, "commit", "-qm", "loose");
    const again = await result(follower(h.s.worktree, [], false));
    expect(again.code).toBe(0);
    expect(starts(h.root).length).toBe(2);
  }, TIMED);
});

describe("two canon work land at once (#172)", () => {
  test("BR-2390 BR-2392: two canon work land started together from one worktree start one landing; both follow it and exit with its code; land.spawn names its run and the run directory its process", async () => {
    const h = heldProject();
    const a = follower(h.s.worktree);
    const b = follower(h.s.worktree);
    await waitFor("the floor to start", () => existsSync(h.pidfile));
    writeFileSync(h.release, "");
    const [ra, rb] = await Promise.all([result(a), result(b)]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    expect(starts(h.root).length).toBe(1);
    const spawns = ws(h.root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.spawn'").all().map((r) => JSON.parse(r.detail) as { run: string; pid: number; pid_start: string });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.run).toBe(starts(h.root)[0]!.run!);
    expect([a.pid, b.pid]).toContain(spawns[0]!.pid);
    expect(readFileSync(join(spawns[0]!.run, "pid"), "utf8").split("\n")[0]).toBe(String(starts(h.root)[0]!.pid));
    expect(`${ra.err}${rb.err}`).toContain("following it instead of starting another");
  }, TIMED);

  test("BR-2392: landing again right after detaching, before the first landing recorded land.start, follows it", async () => {
    const h = heldProject();
    const first = follower(h.s.worktree);
    const spawned = () => ws(h.root).db.db.query<{ run: string }, []>("SELECT json_extract(detail, '$.run') AS run FROM events WHERE kind = 'land.spawn'").get()?.run;
    // the landing process is up (its pid file is written) and has not recorded land.start yet
    await waitFor("the landing process to start", () => spawned() !== undefined && existsSync(join(spawned()!, "pid")));
    first.kill("SIGTERM");
    expect((await result(first)).code).toBe(75);
    const again = follower(h.s.worktree);
    await waitFor("the floor to start", () => existsSync(h.pidfile));
    writeFileSync(h.release, "");
    const r = await result(again);
    expect(r.code).toBe(0);
    expect(starts(h.root).length).toBe(1);
  }, TIMED);
  test("BR-2392: a landing whose starting canon work land died before it started the landing is not waited for; a new landing starts", async () => {
    const h = heldProject();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const dir = `${h.root}.dead-run`;
    mkdirSync(dir);
    ws(h.s.worktree).db.event("agent:a", "land.spawn", null, { run: dir, pid: gone.pid, pid_start: "Mon Jan  1 00:00:00 2024" });
    const r = await result(follower(h.s.worktree, [], false));
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("still starting");
    expect(starts(h.root).length).toBe(1);
  }, TIMED);

  test("BR-2392: a landing that ended before land.start while nothing followed it is reported, not started again", async () => {
    const h = heldProject();
    const dir = `${h.root}.ended-run`;
    mkdirSync(dir);
    writeFileSync(join(dir, "out"), "");
    writeFileSync(join(dir, "err"), "canon: refused before it started\n");
    writeFileSync(join(dir, "exit"), "5\n");
    ws(h.s.worktree).db.event("agent:a", "land.spawn", null, { run: dir, pid: null, pid_start: null });
    const r = await result(follower(h.s.worktree, [], false));
    expect(r.code).toBe(5);
    expect(r.err).toContain("refused before it started");
    expect(starts(h.root).length).toBe(0);
    const again = await result(follower(h.s.worktree, [], false));
    expect(again.code).toBe(0);
    expect(starts(h.root).length).toBe(1);
  }, TIMED);
});

describe("canon work land --stop (D-80)", () => {
  test("BR-2393: --stop ends the running landing, which gives its turn up as killed; exit 0", async () => {
    const h = heldProject();
    const first = follower(h.s.worktree);
    await waitFor("the floor to start", () => existsSync(h.pidfile));
    const lander = starts(h.root)[0]!;
    const stop = await result(follower(h.s.worktree, ["--stop"], false));
    expect(stop.code).toBe(0);
    expect(stop.out).toContain("stopped the landing");
    expect(kinds(h.root)).toContain("land.killed");
    expect(isGone({ pid: lander.pid, start: lander.pid_start })).toBe(true);
    const q = ws(h.root).db.db.query<{ state: string; result: string }, []>("SELECT state, result FROM queue ORDER BY id DESC LIMIT 1").get()!;
    expect(q).toEqual({ state: "failed", result: "killed" });
    expect((await result(first)).code).toBe(143);
  }, TIMED);

  test("BR-2393: --stop with no landing running exits 3; with --finish it exits 2 and signals nothing", async () => {
    const h = heldProject();
    expect((await result(follower(h.s.worktree, ["--stop"], false))).code).toBe(3);
    const p = follower(h.s.worktree);
    await waitFor("the floor to start", () => existsSync(h.pidfile));
    expect((await result(follower(h.s.worktree, ["--stop", "--finish"], false))).code).toBe(2);
    const lander = starts(h.root)[0]!;
    expect(processOf(lander.pid)?.start).toBe(lander.pid_start);
    writeFileSync(h.release, "");
    expect((await result(p)).code).toBe(0);
  }, TIMED);

  test("BR-2393 BR-2022: --stop exits 4 when the running landing's process cannot be signalled", async () => {
    const h = heldProject();
    const init = processOf(1)!; // another user's process: signalling it is refused
    ws(h.s.worktree).db.event("agent:a", "land.start", h.s.change, { pid: init.pid, pid_start: init.start });
    const r = await result(follower(h.s.worktree, ["--stop"], false));
    expect(r.code).toBe(4);
    expect(r.err).toContain("cannot signal the landing process 1");
  }, TIMED);
});
