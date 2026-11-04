import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, ws } from "../testkit.ts";
import { watchDir } from "./watch.ts";

// reason: these tests start real `canon floor watch` processes, which take seconds under load
setDefaultTimeout(90_000);

const MAIN = join(import.meta.dir, "../../cli/main.ts");

/** A project in after mode whose floor appends the tested commit to `runs` and fails while a file FAIL is in the tree. */
function batched(thresholds: { quiet?: number; untested?: number; age?: number } = {}) {
  const root = project();
  const dir = `${root}-floor`;
  mkdirSync(dir, { recursive: true });
  const runs = join(dir, "runs");
  writeFileSync(join(dir, "floor.sh"), `git rev-parse HEAD >> ${runs}\ntest ! -e FAIL\n`);
  writeFileSync(
    join(root, "canon/config.yaml"),
    `floor: "sh ${join(dir, "floor.sh")}"\ntests: []\nfloor_timing: after\nfloor_skip_paths:\n  - canon/rules\nfloor_quiet_minutes: ${thresholds.quiet ?? 20}\nfloor_max_untested: ${thresholds.untested ?? 10}\nfloor_max_age_minutes: ${thresholds.age ?? 60}\n`,
  );
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "config");
  const tested = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : []);
  const b = { root, tested, dir };
  // the baseline: main's first commit is tested, so what follows is a backlog
  expect(watchNow(b).code).toBe(0);
  expect(tested()).toEqual([sh(root, "rev-parse", "main")]);
  return b;
}

/** Commits a file as a landing: the commit and a land.ok event for it, as `canon work land` leaves them. */
function land(root: string, path: string, text = "x\n", date?: string): string {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  sh(root, "add", path);
  const r = Bun.spawnSync(["git", "commit", "-qm", `${path}`], { cwd: root, env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date } : {}) } });
  expect(r.exitCode).toBe(0);
  const sha = sh(root, "rev-parse", "main");
  ws(root).db.event("agent:a", "land.ok", `C-${sha.slice(0, 4)}`, { sha, base: "x", branch: "b" });
  return sha;
}

/** When main last moved (ms), from its reflog. */
const movedAt = (root: string) => Number(sh(root, "log", "-g", "-1", "--format=%ct", "refs/heads/main")) * 1000;
/** CANON_NOW `minutes` after main last moved. */
const after = (root: string, minutes: number) => new Date(movedAt(root) + minutes * 60_000).toISOString();

const env = (extra: Record<string, string>) => ({ ...process.env, CANON_ACTOR: "agent:a", CANON_WATCH_POLL_MS: "100", ...extra });

/** `canon floor watch --now` to its end. */
const watchNow = (b: { root: string }) => {
  const r = Bun.spawnSync(["bun", MAIN, "floor", "watch", "--now"], { cwd: b.root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env({}) });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

/**
 * `canon floor watch` as the background starts it, with "now" at `now`. A watcher that is due runs and ends; one that is not
 * keeps waiting, so it is stopped once it has said so: `waited` is true then.
 */
async function watchAt(b: { root: string; tested: () => string[] }, now: string): Promise<{ waited: boolean; out: string; code: number | null }> {
  const log = join(b.root, ".git", `watch-out-${Date.now()}-${Math.random()}`);
  const fd = Bun.file(log);
  await Bun.write(fd, "");
  const p = Bun.spawn(["sh", "-c", `exec bun ${MAIN} floor watch > ${log} 2>&1`], { cwd: b.root, stdin: "ignore", env: env({ CANON_NOW: now }) });
  const text = () => readFileSync(log, "utf8");
  const end = Date.now() + 60_000;
  let waited = false;
  while (p.exitCode === null && Date.now() < end) {
    if (text().includes("are not tested yet; waiting until")) {
      waited = true;
      await Bun.sleep(600); // long enough for several polls: a due watcher would have tested by now
      p.kill("SIGTERM");
      break;
    }
    await Bun.sleep(50);
  }
  const code = await p.exited;
  return { waited, out: text(), code };
}

const events = (root: string, kind: string) => ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => JSON.parse(r.detail) as { sha: string; base?: string; paths?: string[]; under?: string[] });

describe("canon floor watch thresholds", () => {
  it("BR-2311: main quiet for 19 minutes is not tested, for 21 minutes it is", async () => {
    const b = batched();
    const first = b.tested().length;
    const a = land(b.root, "a.txt");
    const early = await watchAt(b, after(b.root, 19));
    expect(early.waited).toBe(true);
    expect(b.tested()).toHaveLength(first);
    const late = await watchAt(b, after(b.root, 21));
    expect(late.waited).toBe(false);
    expect(late.code).toBe(0);
    expect(b.tested()).toEqual([...b.tested().slice(0, first), a]);
    expect(late.out).toContain("main has not moved for 21 min");
  });

  it("BR-2311: 9 untested landings are not tested, the 10th makes them due", async () => {
    const b = batched({ quiet: 1000, age: 1000 });
    for (let i = 0; i < 9; i++) land(b.root, `f${i}.txt`);
    const nine = await watchAt(b, after(b.root, 1));
    expect(nine.waited).toBe(true);
    expect(b.tested()).toHaveLength(1);
    const tenth = land(b.root, "f9.txt");
    const ten = await watchAt(b, after(b.root, 1));
    expect(ten.waited).toBe(false);
    expect(b.tested().at(-1)).toBe(tenth);
    expect(ten.out).toContain("10 landings are not tested");
  });

  it("BR-2311: the oldest untested commit 59 minutes old is waited for, 61 minutes old is tested", async () => {
    const b = batched({ quiet: 1000 });
    const old = Math.floor(Date.now() / 1000) - 30 * 60;
    land(b.root, "old.txt", "x\n", `${old} +0000`);
    const newest = land(b.root, "new.txt");
    // the first untested commit moved main 30 minutes before the second: at +29 it is 59 minutes old, at +31 it is 61
    const early = await watchAt(b, after(b.root, 29));
    expect(early.waited).toBe(true);
    const late = await watchAt(b, after(b.root, 31));
    expect(late.waited).toBe(false);
    expect(b.tested().at(-1)).toBe(newest);
    expect(late.out).toContain("the oldest untested commit is 61 min old");
  });

  it("BR-2311: while main is failing the quiet period is ignored", async () => {
    const b = batched();
    land(b.root, "FAIL");
    expect(watchNow(b).code).toBe(1);
    const c = land(b.root, "c.txt");
    const r = await watchAt(b, after(b.root, 1));
    expect(r.waited).toBe(false);
    expect(b.tested().at(-1)).toBe(c);
    expect(r.out).toContain("main is failing, so there is no quiet wait");
  });

  it("BR-2311: canon floor watch --now tests at once, and replaces a watcher that only waits", async () => {
    const b = batched();
    const a = land(b.root, "a.txt");
    const log = join(b.dir, "waiting.log");
    const waiting = Bun.spawn(["sh", "-c", `exec bun ${MAIN} floor watch > ${log} 2>&1`], { cwd: b.root, stdin: "ignore", env: env({ CANON_NOW: after(b.root, 1) }) });
    const end = Date.now() + 30_000;
    while (!existsSync(log) || !readFileSync(log, "utf8").includes("waiting until")) {
      if (Date.now() > end) throw new Error("the watcher never waited");
      await Bun.sleep(50);
    }
    expect(b.tested().at(-1)).not.toBe(a);
    const r = watchNow(b);
    expect(r.code).toBe(0);
    expect(b.tested().at(-1)).toBe(a);
    expect(await waiting.exited).toBe(143);
    expect(ws(b.root).db.db.query("SELECT 1 FROM watcher").all()).toEqual([]);
  });

  it("BR-2311: a watcher killed while waiting is replaced by the next canon brief, which waits for the same thresholds", async () => {
    const b = batched();
    land(b.root, "a.txt");
    const waiting = Bun.spawn(["bun", MAIN, "floor", "watch"], { cwd: b.root, stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true, env: env({ CANON_NOW: after(b.root, 1) }) });
    const end = Date.now() + 30_000;
    while (ws(b.root).db.db.query("SELECT 1 FROM watcher").all().length === 0) {
      if (Date.now() > end) throw new Error("no watcher");
      await Bun.sleep(50);
    }
    process.kill(-waiting.pid, "SIGKILL");
    await waiting.exited;
    const r = Bun.spawnSync(["bun", MAIN, "brief"], { cwd: b.root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env({ CANON_NOW: after(b.root, 1) }) });
    expect(r.stdout.toString()).toContain("floor watch: watching main");
    const current = () => ws(b.root).db.db.query<{ pid: number }, []>("SELECT pid FROM watcher").get()?.pid;
    const until = Date.now() + 30_000;
    while (current() === waiting.pid) {
      if (Date.now() > until) throw new Error("the new watcher never took the place");
      await Bun.sleep(50);
    }
    process.kill(current()!, "SIGTERM");
  });
});

describe("canon floor watch skips what needs no floor", () => {
  it("BR-2312: only canon/rules changed since the last tested commit: main is marked tested without a run or a worktree", async () => {
    const b = batched();
    const before = b.tested().length;
    const a = land(b.root, "canon/rules/x/BR-1.md", "rule\n");
    const r = await watchAt(b, after(b.root, 0));
    expect(r.waited).toBe(false);
    expect(r.code).toBe(0);
    expect(b.tested()).toHaveLength(before);
    expect(existsSync(watchDir(ws(b.root).db))).toBe(false);
    expect(events(b.root, "floor.skip")).toEqual([{ sha: a, base: sh(b.root, "rev-parse", `${a}~1`), paths: ["canon/rules/x/BR-1.md"], under: ["canon/rules"] }]);
    expect(r.out).toContain("marked tested without a run");
  });

  it("BR-2312: a src file changed together with canon/rules: the floor runs when due", async () => {
    const b = batched();
    land(b.root, "canon/rules/x/BR-1.md", "rule\n");
    const s = land(b.root, "src/y.ts", "export {};\n");
    const early = await watchAt(b, after(b.root, 1));
    expect(early.waited).toBe(true);
    expect(events(b.root, "floor.skip")).toEqual([]);
    const late = await watchAt(b, after(b.root, 21));
    expect(late.waited).toBe(false);
    expect(b.tested().at(-1)).toBe(s);
  });
});

describe("canon work status and canon brief show the untested landings", () => {
  it("BR-2313: three untested landings show the count and when the next run is due; none shows nothing", () => {
    const b = batched();
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd: b.root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env({ CANON_NOW: after(b.root, 5) }) });
      return r.stdout.toString();
    };
    expect(run("work", "status")).not.toContain("not yet tested");
    for (const f of ["a", "b", "c"]) land(b.root, `${f}.txt`);
    const status = run("work", "status");
    expect(status).toContain("main: 3 landings not yet tested (next run in ~15 min, or when 7 more landings are in; `canon floor watch --now` runs it at once)");
    const data = JSON.parse(run("work", "status", "--json")) as { untested: string[] };
    expect(data.untested).toHaveLength(1);
    expect(run("brief")).toContain("main: 3 landings not yet tested");
    for (const w of ws(b.root).db.db.query<{ pid: number }, []>("SELECT pid FROM watcher").all()) process.kill(w.pid, "SIGTERM");
  });
});
