import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKFLOW_GUIDE } from "../../cli/guide.ts";
import { project, quiet, sh, startNew, ws } from "../testkit.ts";
import { redMain } from "./redmain.ts";
import { GREEN_REF, watch, watchDir } from "./watch.ts";

// reason: these tests run real floors in temporary worktrees and spawn `canon floor watch`, which take seconds under load
setDefaultTimeout(90_000);

const MAIN = join(import.meta.dir, "../../cli/main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/**
 * A project in after mode whose floor appends the tested commit to `runs`, waits while `hold` exists, and fails
 * when the tree has a file FAIL. `extra` is more config.
 */
function watched(extra = "") {
  const root = project();
  const dir = `${root}-floor`;
  mkdirSync(dir, { recursive: true });
  const runs = join(dir, "runs");
  const hold = join(dir, "hold");
  writeFileSync(join(dir, "floor.sh"), `git rev-parse HEAD >> ${runs}\nwhile [ -e ${hold} ]; do sleep 0.1; done\ntest ! -e FAIL\n`);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "sh ${join(dir, "floor.sh")}"\ntests: []\nfloor_timing: after\n${extra}`);
  sh(root, "commit", "-qam", "config");
  const tested = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : []);
  return { root, hold, tested };
}

const commit = (root: string, path: string, text: string | null) => {
  if (text === null) sh(root, "rm", "-q", path);
  else {
    writeFileSync(join(root, path), text);
    sh(root, "add", path);
  }
  sh(root, "commit", "-qm", `${path} ${text === null ? "removed" : "written"}`);
  return sh(root, "rev-parse", "HEAD");
};

const results = (root: string) =>
  ws(root).db.db.query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM events WHERE kind IN ('floor.pass', 'floor.fail') ORDER BY id").all().map((r) => ({ kind: r.kind, ...(JSON.parse(r.detail) as { sha: string; log: string; exit: number }) }));

const watcherRows = (root: string) => ws(root).db.db.query<{ pid: number; sha: string | null }, []>("SELECT pid, sha FROM watcher").all();

async function until(what: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

/** What canon brief prints after the guide. */
const briefAfterGuide = (cwd: string) => {
  const r = canon(cwd, "brief");
  expect(r.code).toBe(0);
  expect(r.out.startsWith(WORKFLOW_GUIDE)).toBe(true);
  return r.out.slice(WORKFLOW_GUIDE.length).replace(/^\n/, "");
};

/** Runs `run` with `bin` first on PATH (or PATH as given when `path` is passed) and CANON_WATCH_HANDOFF as given. */
async function withPath<T>(bin: string, handoff: string | undefined, run: () => Promise<T>, path?: string): Promise<T> {
  const old = process.env["PATH"];
  process.env["PATH"] = path ?? `${bin}:${old}`;
  if (handoff) process.env["CANON_WATCH_HANDOFF"] = handoff;
  try {
    return await run();
  } finally {
    process.env["PATH"] = old;
    delete process.env["CANON_WATCH_HANDOFF"];
  }
}

/**
 * A directory with a `canon` that exits `reads` for `config --schema` and, for `floor watch`, writes its directory
 * and CANON_WATCH_HANDOFF (`none` when unset) to `started`. With `real`, `floor watch` runs this source's canon too.
 */
function fakeCanon(root: string, reads = 0, real = false) {
  const bin = `${root}-bin`;
  mkdirSync(bin, { recursive: true });
  const started = join(bin, "started");
  writeFileSync(
    join(bin, "canon"),
    `#!/bin/sh\nif [ "$1" = config ]; then exit ${reads}; fi\nif [ "$1 $2" = "floor watch" ]; then printf '%s %s\\n' "$(pwd -P)" "\${CANON_WATCH_HANDOFF-none}" >> ${started}; fi\n${real ? `exec bun ${MAIN} "$@"\n` : ""}`,
    { mode: 0o755 },
  );
  return { bin, started };
}

/** PATH without any directory that has a `canon` in it. */
const pathWithoutCanon = () => (process.env["PATH"] ?? "").split(":").filter((d) => d !== "" && !existsSync(join(d, "canon"))).join(":");

const eventsOf = (root: string, kind: string) =>
  ws(root).db.db.query<{ id: number; detail: string }, [string]>("SELECT id, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => ({ id: r.id, ...(JSON.parse(r.detail) as { sha: string; to?: string }) }));

/**
 * Starts `canon floor watch` as its own group leader, as canon starts it, on a project whose config is `config(ready,
 * late)`; once `ready` exists sends `signal` (SIGTERM unless given) to the watcher alone, waits for it to exit 143 (130
 * for SIGINT) and then 1.5 s more, which is longer than a `sleep 1; touch late` the command left behind needs to write
 * `late`. `floor` replaces the floor ($READY and $LATE in it are the paths).
 */
async function termedWhile(config: (ready: string, late: string) => string, opts: { floor?: string; signal?: "SIGTERM" | "SIGINT" } = {}) {
  const signal = opts.signal ?? "SIGTERM";
  const dir = join(process.env["TMPDIR"] ?? "/tmp", `canon-term-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const ready = join(dir, "ready");
  const late = join(dir, "late");
  const w = watched(config(ready, late));
  if (opts.floor !== undefined) {
    writeFileSync(join(w.root, "canon/config.yaml"), `floor: '${opts.floor.replaceAll("$READY", ready).replaceAll("$LATE", late)}'\ntests: []\nfloor_timing: after\n`);
    sh(w.root, "commit", "-qam", "floor");
  }
  const fake = fakeCanon(w.root);
  const p = Bun.spawn(["bun", MAIN, "floor", "watch"], { cwd: w.root, stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true, env: { ...process.env, PATH: `${fake.bin}:${process.env["PATH"]}`, CANON_ACTOR: "agent:a" } });
  await until(() => existsSync(ready));
  p.kill(signal); // the watcher only, not its group
  expect(await p.exited).toBe(signal === "SIGINT" ? 130 : 143);
  await Bun.sleep(1500);
  return { ...w, dir, late };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const hookExits = (root: string) => ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'hook.run' ORDER BY id").all().map((r) => (JSON.parse(r.detail) as { exit: number }).exit);

describe("canon floor watch", () => {
  test("BR-2219: tests main's latest commit in a temporary worktree, logs to watch-<sha>.log, records the result and removes the worktree", async () => {
    const { root, tested } = watched();
    const a = sh(root, "rev-parse", "main");
    const r = await watch(ws(root), quiet);
    expect(r.ok && r.value.tested.map((t) => [t.sha, t.passed])).toEqual([[a, true]]);
    expect(tested()).toEqual([a]);
    const log = join(dirname(ws(root).db.db.filename), "logs", `watch-${a.slice(0, 12)}.log`);
    expect(results(root)).toEqual([{ kind: "floor.pass", sha: a, log, exit: 0 }]);
    expect(existsSync(log)).toBe(true);
    expect(existsSync(watchDir(ws(root).db))).toBe(false);
    expect(sh(root, "worktree", "list").split("\n")).toHaveLength(1);
    expect(watcherRows(root)).toEqual([]);
  });

  test("BR-2219: while A is tested main moves to B and C; C is tested next and B never", async () => {
    const { root, hold, tested } = watched();
    const a = sh(root, "rev-parse", "main");
    writeFileSync(hold, "");
    const running = watch(ws(root), quiet);
    await until(() => tested().length === 1);
    const b = commit(root, "b.txt", "b\n");
    const c = commit(root, "c.txt", "c\n");
    rmSync(hold);
    const r = await running;
    expect(r.ok && r.value.tested.map((t) => t.sha)).toEqual([a, c]);
    expect(tested()).toEqual([a, c]);
    expect(results(root).map((x) => x.sha)).toEqual([a, c]);
    expect(results(root).some((x) => x.sha === b)).toBe(false);
  });

  test("BR-2219: a watcher started while one runs ends at once with 0, and only one runs", async () => {
    const { root, hold, tested } = watched();
    writeFileSync(hold, "");
    const running = watch(ws(root), quiet);
    await until(() => tested().length === 1);
    const second = canon(root, "floor", "watch");
    expect(second.code).toBe(0);
    expect(second.out).toContain("another canon floor watch is running");
    expect(watcherRows(root).map((w) => w.pid)).toEqual([process.pid]);
    expect(tested()).toHaveLength(1);
    rmSync(hold);
    await running;
    expect(tested()).toHaveLength(1);
  });

  test("BR-2219: a watcher killed with SIGKILL is taken over: the next canon brief starts a new one on main's latest commit", async () => {
    const { root, hold, tested } = watched();
    const a = sh(root, "rev-parse", "main");
    writeFileSync(hold, "");
    const killed = Bun.spawn(["bun", MAIN, "floor", "watch"], { cwd: root, stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true, env: { ...process.env, CANON_ACTOR: "agent:a" } });
    await until(() => tested().length === 1);
    expect(watcherRows(root).map((w) => [w.pid, w.sha])).toEqual([[killed.pid, a]]);
    // reason: the whole group, so the floor it started dies with it as on a reboot; the row stays behind
    process.kill(-killed.pid, "SIGKILL");
    await killed.exited;
    rmSync(hold);
    expect(watcherRows(root).map((w) => w.pid)).toEqual([killed.pid]);
    expect(results(root)).toEqual([]);
    expect(briefAfterGuide(root)).toContain(`floor watch: testing main ${a.slice(0, 9)} in the background`);
    await until(() => results(root).length === 1);
    expect(results(root).map((x) => [x.kind, x.sha])).toEqual([["floor.pass", a]]);
    await until(() => watcherRows(root).length === 0);
  });

  test("BR-2285 BR-2219: a watcher stopped by SIGTERM while the floor runs stops the floor's processes too, those whose parent exited included, and records no result", async () => {
    const { root, late } = await termedWhile(() => "", { floor: "( (sleep 1; touch $LATE) & ); touch $READY; sleep 30" });
    expect(existsSync(late)).toBe(false);
    expect(results(root)).toEqual([]);
    expect(existsSync(watchDir(ws(root).db))).toBe(false);
  });

  test("BR-2219: when main's latest commit already has floor.pass, watch does nothing", async () => {
    const { root, tested } = watched();
    await watch(ws(root), quiet);
    const said: string[] = [];
    const r = await watch(ws(root), (m) => said.push(m));
    expect(r.ok && r.value).toEqual({ ran: false, tested: [] });
    expect(tested()).toHaveLength(1);
    expect(results(root)).toHaveLength(1);
    expect(said).toEqual(["main's latest commit is already tested"]);
    // canon brief starts nothing either.
    expect(briefAfterGuide(root)).not.toContain("floor watch:");
  });

  test("BR-2219: uncommitted changes in the primary checkout stay as they were while main is tested", async () => {
    const { root } = watched();
    writeFileSync(join(root, "app.txt"), "local edit\n");
    writeFileSync(join(root, "untracked.txt"), "mine\n");
    const status = sh(root, "status", "--porcelain");
    await watch(ws(root), quiet);
    expect(sh(root, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("local edit\n");
    expect(results(root).map((x) => x.kind)).toEqual(["floor.pass"]);
  });

  test("BR-2219: with floor_timing before, watch tests nothing", async () => {
    const root = project();
    const said: string[] = [];
    const r = await watch(ws(root), (m) => said.push(m));
    expect(r.ok && r.value.ran).toBe(false);
    expect(results(root)).toEqual([]);
    expect(said[0]).toContain("not `after`");
  });

  test("BR-2219: a setup that exits 1 runs no floor and records floor.fail with why `setup exited 1`; main is failing", async () => {
    const { root, tested } = watched(`setup: "exit 1"\n`);
    const a = sh(root, "rev-parse", "main");
    const r = await watch(ws(root), quiet);
    expect(r.ok && r.value.tested.map((t) => [t.sha, t.passed])).toEqual([[a, false]]);
    expect(tested()).toEqual([]);
    const fail = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'floor.fail'").all().map((x) => JSON.parse(x.detail) as { sha: string; exit: number; why: string });
    expect(fail.map((f) => [f.sha, f.exit, f.why])).toEqual([[a, 1, "setup exited 1"]]);
    expect(redMain(ws(root).db)?.sha).toBe(a);
  });
});

describe("a watcher hands off after every rebuild", () => {
  test("BR-2251: a pass whose after_green exits 0 records floor.handoff and starts PATH's canon in the primary checkout without CANON_WATCH_HANDOFF, then ends", async () => {
    const { root } = watched(`hooks:\n  after_green: "true"\n`);
    const a = sh(root, "rev-parse", "main");
    const { bin, started } = fakeCanon(root);
    // reason: a value inherited from an earlier BR-2250 handoff must not reach the new watcher.
    const r = await withPath(bin, "0".repeat(40), () => watch(ws(root), quiet));
    expect(r.ok && r.value.tested.map((t) => [t.sha, t.passed])).toEqual([[a, true]]);
    const pass = eventsOf(root, "floor.pass");
    const handoff = eventsOf(root, "floor.handoff");
    expect(handoff.map((h) => [h.sha, h.to])).toEqual([[a, join(bin, "canon")]]);
    expect(handoff[0]!.id).toBeGreaterThan(pass[0]!.id);
    await until(() => existsSync(started));
    expect(readFileSync(started, "utf8").trim()).toBe(`${realpathSync(root)} none`);
    expect(watcherRows(root)).toEqual([]);
  });

  test("BR-2251: when main moved to B while A was tested, the watcher that rebuilt does not test B; the started canon tests B and hands off again only after B passes", async () => {
    const { root, hold, tested } = watched(`hooks:\n  after_green: "true"\n`);
    const a = sh(root, "rev-parse", "main");
    const { bin, started } = fakeCanon(root, 0, true);
    writeFileSync(hold, "");
    let b = "";
    const r = await withPath(bin, undefined, async () => {
      const running = watch(ws(root), quiet);
      await until(() => tested().length === 1);
      b = commit(root, "b.txt", "b\n");
      rmSync(hold);
      const done = await running;
      // The real canon started from PATH tests B, hands off once more, and the one it starts finds B tested.
      await until(() => eventsOf(root, "floor.handoff").length === 2 && existsSync(started) && readFileSync(started, "utf8").trim().split("\n").length === 2);
      await until(() => watcherRows(root).length === 0);
      return done;
    });
    expect(r.ok && r.value.tested.map((t) => t.sha)).toEqual([a]);
    expect(tested()).toEqual([a, b]);
    expect(results(root).map((x) => [x.kind, x.sha])).toEqual([["floor.pass", a], ["floor.pass", b]]);
    const kinds = ws(root).db.db.query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM events WHERE kind IN ('floor.pass', 'floor.handoff') ORDER BY id").all().map((x) => [x.kind, (JSON.parse(x.detail) as { sha: string }).sha]);
    expect(kinds).toEqual([["floor.pass", a], ["floor.handoff", a], ["floor.pass", b], ["floor.handoff", b]]);
    // The last one started found main's latest commit tested: no third handoff.
    await Bun.sleep(500);
    expect(eventsOf(root, "floor.handoff")).toHaveLength(2);
  });

  test("BR-2251: a watcher started on an already tested main does nothing and hands off nothing", async () => {
    const { root } = watched(`hooks:\n  after_green: "true"\n`);
    const { bin, started } = fakeCanon(root);
    await withPath(bin, undefined, () => watch(ws(root), quiet));
    await until(() => existsSync(started));
    const again = await withPath(bin, undefined, () => watch(ws(root), quiet));
    expect(again.ok && again.value).toEqual({ ran: false, tested: [] });
    expect(eventsOf(root, "floor.handoff")).toHaveLength(1);
    expect(readFileSync(started, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("BR-2251: without after_green there is no handoff: the same watcher goes on to main's latest commit", async () => {
    const { root, hold, tested } = watched();
    const a = sh(root, "rev-parse", "main");
    const { bin, started } = fakeCanon(root);
    writeFileSync(hold, "");
    const r = await withPath(bin, undefined, async () => {
      const running = watch(ws(root), quiet);
      await until(() => tested().length === 1);
      const c = commit(root, "c.txt", "c\n");
      rmSync(hold);
      return { c, done: await running };
    });
    expect(r.done.ok && r.done.value.tested.map((t) => t.sha)).toEqual([a, r.c]);
    expect(eventsOf(root, "floor.handoff")).toEqual([]);
    expect(existsSync(started)).toBe(false);
  });

  test("BR-2251: an after_green that exits 1 is no rebuild: no handoff, and the same watcher tests main's latest commit", async () => {
    const { root, hold, tested } = watched(`hooks:\n  after_green: exit 1\n`);
    const a = sh(root, "rev-parse", "main");
    const { bin, started } = fakeCanon(root);
    writeFileSync(hold, "");
    const r = await withPath(bin, undefined, async () => {
      const running = watch(ws(root), quiet);
      await until(() => tested().length === 1);
      const c = commit(root, "c.txt", "c\n");
      rmSync(hold);
      return { c, done: await running };
    });
    expect(r.done.ok && r.done.value.tested.map((t) => t.sha)).toEqual([a, r.c]);
    expect(hookExits(root)).toEqual([1, 1]);
    expect(eventsOf(root, "floor.handoff")).toEqual([]);
    expect(existsSync(started)).toBe(false);
  });

  test("BR-2251: an after_green that exits 0 with no canon on PATH: no handoff, and the same watcher tests main's latest commit", async () => {
    const { root, hold, tested } = watched(`hooks:\n  after_green: "true"\n`);
    const a = sh(root, "rev-parse", "main");
    writeFileSync(hold, "");
    const r = await withPath("", undefined, async () => {
      const running = watch(ws(root), quiet);
      await until(() => tested().length === 1);
      const c = commit(root, "c.txt", "c\n");
      rmSync(hold);
      return { c, done: await running };
    }, pathWithoutCanon());
    expect(r.done.ok && r.done.value.tested.map((t) => t.sha)).toEqual([a, r.c]);
    expect(hookExits(root)).toEqual([0, 0]);
    expect(eventsOf(root, "floor.handoff")).toEqual([]);
  });
});

describe("a failing main", () => {
  test("BR-2220: a failure on A is recorded and canon brief starts with it: since A, the log and --fix-main", async () => {
    const { root } = watched();
    const a = commit(root, "FAIL", "x\n");
    await watch(ws(root), quiet);
    const r = redMain(ws(root).db)!;
    expect([r.sha, r.first_sha, r.green, r.change]).toEqual([a, a, null, null]);
    expect(r.log).toBe(join(dirname(ws(root).db.db.filename), "logs", `watch-${a.slice(0, 12)}.log`));
    const text = briefAfterGuide(root);
    expect(text.split("\n")[0]).toStartWith(`main is failing floor since ${a.slice(0, 9)}`);
    expect(text).toContain(`  log: ${r.log}`);
    expect(text).toContain("`canon work start --fix-main`");
    // The last 10 lines of the recorded tail, no more.
    const shown = text.slice(text.indexOf("  last lines of its output:\n") + "  last lines of its output:\n".length, text.indexOf("  last passing commit:")).trimEnd().split("\n");
    expect(shown).toEqual(r.tail.trimEnd().split("\n").slice(-10).map((l) => `    ${l}`));
  });

  test("BR-2220: a later failure on C updates the same record: its commit and log change, when it began does not", async () => {
    const { root } = watched();
    const a = commit(root, "FAIL", "x\n");
    await watch(ws(root), quiet);
    const first = redMain(ws(root).db)!;
    const c = commit(root, "c.txt", "c\n");
    await watch(ws(root), quiet);
    const now = redMain(ws(root).db)!;
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM red_main").get()!.n).toBe(1);
    expect([now.sha, now.first_sha, now.since]).toEqual([c, a, first.since]);
    expect(now.log).toEndWith(`watch-${c.slice(0, 12)}.log`);
    expect(briefAfterGuide(root).split("\n")[0]).toStartWith(`main is failing floor since ${a.slice(0, 9)} (latest failing commit ${c.slice(0, 9)})`);
  });

  test("BR-2220: in a change's worktree brief says the failures are not that change's, and there is no block without a record", async () => {
    const { root } = watched();
    const s = startNew(root, "Other work");
    expect(briefAfterGuide(s.worktree)).not.toContain("main is failing");
    expect(briefAfterGuide(root)).not.toContain("main is failing");
    commit(root, "FAIL", "x\n");
    await watch(ws(root), quiet);
    const text = briefAfterGuide(s.worktree);
    expect(text.split("\n")[0]).toStartWith("main is failing floor since");
    expect(text).toContain(`These failures are not caused by ${s.change}: do not fix them in ${s.change}`);
    expect(text.indexOf("main is failing")).toBeLessThan(text.indexOf(`You are in ${s.change}`));
  });
});

describe("a passing main", () => {
  test("BR-2222: a pass on A after a failure moves refs/canon/green to A, removes the record, and brief no longer shows it", async () => {
    const { root } = watched();
    commit(root, "FAIL", "x\n");
    await watch(ws(root), quiet);
    expect(redMain(ws(root).db)).toBeDefined();
    const a = commit(root, "FAIL", null);
    await watch(ws(root), quiet);
    expect(sh(root, "rev-parse", GREEN_REF)).toBe(a);
    expect(redMain(ws(root).db)).toBeUndefined();
    expect(briefAfterGuide(root)).not.toContain("main is failing");
  });

  test("BR-2222: after_green runs in the temporary worktree at the passed commit with CANON_GREEN and CANON_PRIMARY, and its exit code is recorded", async () => {
    const { root } = watched(`hooks:\n  after_green: 'echo "$CANON_GREEN" > green.txt && pwd > "$CANON_PRIMARY.where" && cp green.txt "$CANON_PRIMARY.green"'\n`);
    const a = sh(root, "rev-parse", "main");
    // reason: a passing after_green hands off to PATH's canon (BR-2251); a fake one keeps a real canon from starting here.
    await withPath(fakeCanon(root).bin, undefined, () => watch(ws(root), quiet));
    const primary = realpathSync(root);
    expect(readFileSync(`${primary}.green`, "utf8")).toBe(`${a}\n`);
    // The worktree is gone by now, so its path is compared as written: the git common dir's canon/watch.
    expect(readFileSync(`${primary}.where`, "utf8").trim()).toEndWith(`${primary.split("/").pop()}/.git/canon/watch`);
    const runs = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'hook.run'").all().map((r) => JSON.parse(r.detail) as { event: string; exit: number });
    expect(runs.map((r) => [r.event, r.exit])).toEqual([["after_green", 0]]);
    expect(existsSync(watchDir(ws(root).db))).toBe(false);
  });

  const orphaning = (ready: string, late: string) => `hooks:\n  after_green: '( (sleep 1; touch ${late}) & ); echo $$ > ${ready}.pid; touch ${ready}; while true; do sleep 0.1; done'\n`;

  test("BR-2285 BR-2222: a watcher stopped by SIGTERM while after_green runs sends its group SIGTERM: after_green and what it left after its parent exited end, the place is free, the watcher exits 143, and after_green is not run again", async () => {
    const { root, late, dir } = await termedWhile(orphaning);
    expect(alive(Number(readFileSync(join(dir, "ready.pid"), "utf8").trim()))).toBe(false);
    expect(existsSync(late)).toBe(false);
    expect(watcherRows(root)).toEqual([]);
    expect(existsSync(watchDir(ws(root).db))).toBe(false);
    expect(briefAfterGuide(root)).not.toContain("floor watch:");
  });

  test("BR-2222: a floor.pass an older canon marked `after_green: true` with no floor.after_green is not run again", async () => {
    const { root } = watched(`hooks:\n  after_green: 'touch ran'\n`);
    const a = sh(root, "rev-parse", "main");
    sh(root, "update-ref", GREEN_REF, a);
    ws(root).db.event("agent:a", "floor.pass", null, { sha: a, log: "x", exit: 0, after_green: true });
    expect(briefAfterGuide(root)).not.toContain("floor watch:");
    expect(watcherRows(root)).toEqual([]);
  });

  test("BR-2285: a process that left the group with setsid is not followed: the watcher exits 143 and it goes on and writes its file", async () => {
    const { late } = await termedWhile((ready, late) => {
      writeFileSync(`${ready}.pl`, `use POSIX; if (fork() == 0) { POSIX::setsid(); sleep 1; open(my $f, ">", "${late}"); exit 0 }\n`);
      return `hooks:\n  after_green: 'perl ${ready}.pl; touch ${ready}; while true; do sleep 0.1; done'\n`;
    });
    expect(existsSync(late)).toBe(true);
  });

  test("BR-2285: a watcher stopped by SIGINT exits 130 and stops what after_green left running too", async () => {
    const { late } = await termedWhile(orphaning, { signal: "SIGINT" });
    expect(existsSync(late)).toBe(false);
  });

  test("BR-2285: a watcher that does not lead its process group sends SIGTERM to its own child only: after_green ends, what it left after its parent exited and the rest of the group run on", async () => {
    const dir = join(process.env["TMPDIR"] ?? "/tmp", `canon-ag-group-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const ready = join(dir, "ready");
    const late = join(dir, "late");
    const { root } = watched(orphaning(ready, late));
    const fake = fakeCanon(root);
    const neighbour = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    // reason: not detached, so it shares this test's process group, as when run by hand from a shell without job control
    const w = Bun.spawn(["bun", MAIN, "floor", "watch"], { cwd: root, stdout: "ignore", stderr: "ignore", stdin: "ignore", env: { ...process.env, PATH: `${fake.bin}:${process.env["PATH"]}`, CANON_ACTOR: "agent:a" } });
    await until(() => existsSync(ready));
    const hook = Number(readFileSync(`${ready}.pid`, "utf8").trim());
    w.kill("SIGTERM");
    expect(await w.exited).toBe(143);
    await until(() => !alive(hook), 5_000).catch(() => {});
    const still = alive(hook);
    if (still) process.kill(hook, "SIGKILL");
    expect(still).toBe(false);
    await until(() => existsSync(late), 5_000).catch(() => {});
    expect(existsSync(late)).toBe(true);
    expect(neighbour.exitCode).toBeNull();
    neighbour.kill("SIGKILL");
  });

  test("BR-2222: an after_green that exits 1 leaves the pass and refs/canon/green as they are", async () => {
    const { root } = watched(`hooks:\n  after_green: exit 1\n`);
    const a = sh(root, "rev-parse", "main");
    await watch(ws(root), quiet);
    expect(results(root).map((x) => [x.kind, x.sha])).toEqual([["floor.pass", a]]);
    expect(sh(root, "rev-parse", GREEN_REF)).toBe(a);
    const runs = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'hook.run'").all().map((r) => JSON.parse(r.detail) as { exit: number });
    expect(runs.map((r) => r.exit)).toEqual([1]);
  });

  test("BR-2222: a failure on C leaves refs/canon/green where it was and does not run after_green", async () => {
    const { root } = watched(`hooks:\n  after_green: "true"\n`);
    const a = sh(root, "rev-parse", "main");
    await withPath(fakeCanon(root).bin, undefined, () => watch(ws(root), quiet));
    const c = commit(root, "FAIL", "x\n");
    await watch(ws(root), quiet);
    expect(results(root).map((x) => [x.kind, x.sha])).toEqual([["floor.pass", a], ["floor.fail", c]]);
    expect(sh(root, "rev-parse", GREEN_REF)).toBe(a);
    expect(redMain(ws(root).db)!.green).toBe(a);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'hook.run'").get()!.n).toBe(1);
  });

  test("BR-2222: with floor_timing before, after_green never runs", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nhooks:\n  after_green: "touch \\"$CANON_PRIMARY.ran\\""\n`);
    sh(root, "commit", "-qam", "config");
    await watch(ws(root), quiet);
    expect(existsSync(`${realpathSync(root)}.ran`)).toBe(false);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'hook.run'").get()!.n).toBe(0);
  });
});

describe("a background result is recorded whole", () => {
  test("BR-2220: when the failing-main record cannot be written, no floor.fail is left either, so the commit is tested again and recorded", async () => {
    const { root } = watched();
    const x = commit(root, "FAIL", "x\n");
    const db = ws(root).db.db;
    db.run("CREATE TRIGGER block_red BEFORE INSERT ON red_main BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    const first = await watch(ws(root), quiet);
    expect(first.ok).toBe(false);
    expect(results(root)).toEqual([]);
    expect(redMain(ws(root).db)).toBeUndefined();
    db.run("DROP TRIGGER block_red");
    const again = await watch(ws(root), quiet);
    expect(again.ok).toBe(true);
    expect(results(root).map((r) => [r.kind, r.sha])).toEqual([["floor.fail", x]]);
    expect(redMain(ws(root).db)?.sha).toBe(x);
  });

  test("BR-2222: when the failing-main record cannot be cleared after a pass, no floor.pass is left either, and the next run clears it", async () => {
    const { root } = watched(`hooks:\n  after_green: 'echo "$CANON_GREEN" >> "$CANON_PRIMARY.ran"'\n`);
    const ran = () => (existsSync(`${root}.ran`) ? readFileSync(`${root}.ran`, "utf8").trim().split("\n") : []);
    const bad = commit(root, "FAIL", "x\n");
    expect((await watch(ws(root), quiet)).ok).toBe(true);
    expect(redMain(ws(root).db)?.sha).toBe(bad);
    const good = commit(root, "FAIL", null);
    const db = ws(root).db.db;
    db.run("CREATE TRIGGER keep_red BEFORE DELETE ON red_main BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    expect((await watch(ws(root), quiet)).ok).toBe(false);
    expect(results(root).map((r) => r.kind)).toEqual(["floor.fail"]);
    expect(redMain(ws(root).db)).toBeDefined();
    expect(sh(root, "rev-parse", GREEN_REF)).toBe(good); // the ref moved before the record failed
    expect(ran()).toEqual([]); // after_green did not run
    db.run("DROP TRIGGER keep_red");
    // reason: after_green exits 0, which hands off to PATH's canon (BR-2251); a fake one keeps a real canon from starting here.
    expect((await withPath(fakeCanon(root).bin, undefined, () => watch(ws(root), quiet))).ok).toBe(true);
    expect(results(root).map((r) => [r.kind, r.sha])).toEqual([["floor.fail", bad], ["floor.pass", good]]);
    expect(redMain(ws(root).db)).toBeUndefined();
    expect(ran()).toEqual([good]);
  });
});

describe("a watcher older than main's config", () => {
  /**
   * main's latest commit uses `future_key`, which this canon does not know, while the primary checkout keeps the
   * config it can read. `canon` on PATH is a script that exits `reads` for `config --schema` and, for `floor watch`,
   * writes its directory and CANON_WATCH_HANDOFF to `started`.
   */
  function stale(reads: number) {
    const { root } = watched();
    const config = readFileSync(join(root, "canon/config.yaml"), "utf8");
    writeFileSync(join(root, "canon/config.yaml"), `${config}future_key: 1\n`);
    sh(root, "commit", "-qam", "config with a key from newer canon");
    writeFileSync(join(root, "canon/config.yaml"), config);
    const { bin, started } = fakeCanon(root, reads);
    return { root, sha: sh(root, "rev-parse", "main"), bin, started };
  }

  const staleEvents = (root: string) =>
    ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'floor.stale'").all().map((r) => JSON.parse(r.detail) as { sha: string });

  test("BR-2250: when PATH's canon reads the config this watcher cannot, it records floor.stale, not floor.fail, and hands the commit to PATH's canon", async () => {
    const { root, sha, bin, started } = stale(0);
    const r = await withPath(bin, undefined, () => watch(ws(root), quiet));
    expect(r.ok && r.value.tested).toEqual([]);
    expect(results(root)).toEqual([]);
    expect(redMain(ws(root).db)).toBeUndefined();
    expect(staleEvents(root).map((e) => e.sha)).toEqual([sha]);
    await until(() => existsSync(started));
    expect(readFileSync(started, "utf8").trim()).toBe(`${realpathSync(root)} ${sha}`);
    expect(watcherRows(root)).toEqual([]);
  });

  test("BR-2250: when PATH's canon cannot read the config either, it is main's failure: floor.fail with exit 2 and no handoff", async () => {
    const { root, sha, bin, started } = stale(2);
    const r = await withPath(bin, undefined, () => watch(ws(root), quiet));
    expect(r.ok && r.value.tested.map((t) => [t.sha, t.passed])).toEqual([[sha, false]]);
    expect(results(root).map((x) => [x.kind, x.sha, x.exit])).toEqual([["floor.fail", sha, 2]]);
    expect(redMain(ws(root).db)?.sha).toBe(sha);
    expect(staleEvents(root)).toEqual([]);
    expect(existsSync(started)).toBe(false);
  });

  test("BR-2250: when PATH has no canon, it is main's failure: floor.fail and no floor.stale", async () => {
    const { root, sha } = stale(0);
    const r = await withPath("", undefined, () => watch(ws(root), quiet), pathWithoutCanon());
    expect(r.ok && r.value.tested.map((t) => [t.sha, t.passed])).toEqual([[sha, false]]);
    const fail = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'floor.fail'").all().map((x) => JSON.parse(x.detail) as { sha: string; why: string });
    expect(fail.map((f) => [f.sha, f.why])).toEqual([[sha, "its canon/config.yaml cannot be read"]]);
    expect(redMain(ws(root).db)?.sha).toBe(sha);
    expect(staleEvents(root)).toEqual([]);
  });

  test("BR-2250: a watcher handed this commit already does not hand it off again: floor.fail", async () => {
    const { root, sha, bin, started } = stale(0);
    const r = await withPath(bin, sha, () => watch(ws(root), quiet));
    expect(r.ok && r.value.tested.map((t) => [t.sha, t.passed])).toEqual([[sha, false]]);
    expect(results(root).map((x) => [x.kind, x.sha])).toEqual([["floor.fail", sha]]);
    expect(staleEvents(root)).toEqual([]);
    expect(existsSync(started)).toBe(false);
  });
});
