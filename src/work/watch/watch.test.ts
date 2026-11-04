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
    await watch(ws(root), quiet);
    const primary = realpathSync(root);
    expect(readFileSync(`${primary}.green`, "utf8")).toBe(`${a}\n`);
    // The worktree is gone by now, so its path is compared as written: the git common dir's canon/watch.
    expect(readFileSync(`${primary}.where`, "utf8").trim()).toEndWith(`${primary.split("/").pop()}/.git/canon/watch`);
    const runs = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'hook.run'").all().map((r) => JSON.parse(r.detail) as { event: string; exit: number });
    expect(runs.map((r) => [r.event, r.exit])).toEqual([["after_green", 0]]);
    expect(existsSync(watchDir(ws(root).db))).toBe(false);
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
    await watch(ws(root), quiet);
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
    const { root } = watched();
    const bad = commit(root, "FAIL", "x\n");
    expect((await watch(ws(root), quiet)).ok).toBe(true);
    expect(redMain(ws(root).db)?.sha).toBe(bad);
    const good = commit(root, "FAIL", null);
    const db = ws(root).db.db;
    db.run("CREATE TRIGGER keep_red BEFORE DELETE ON red_main BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    expect((await watch(ws(root), quiet)).ok).toBe(false);
    expect(results(root).map((r) => r.kind)).toEqual(["floor.fail"]);
    expect(redMain(ws(root).db)).toBeDefined();
    db.run("DROP TRIGGER keep_red");
    expect((await watch(ws(root), quiet)).ok).toBe(true);
    expect(results(root).map((r) => [r.kind, r.sha])).toEqual([["floor.fail", bad], ["floor.pass", good]]);
    expect(redMain(ws(root).db)).toBeUndefined();
  });
});
