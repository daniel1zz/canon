import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { project, startNew, ws } from "../testkit.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:s2" } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}

/** A repository whose coordination database still names where it was before: `/old/<name>` and its worktrees. */
function moved() {
  const root = realpathSync(project()); roots.push(root);
  const s = startNew(root, "Moved work", "agent:s1");
  const OLD = `/old/place/${basename(root)}`;
  const w = ws(root);
  try {
    const logs = join(dirname(w.db.db.filename), "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "after-land-7.log"), "ok\n");
    w.db.db.query("UPDATE claims SET worktree = ?, pid = 4242, pid_start = 'Mon Jan  1 00:00:00 2024' WHERE subject = ?").run(`${OLD}.worktrees/${basename(s.worktree)}`, s.change);
    w.db.db.query("INSERT INTO events(ts, actor, kind, subject, detail, worktree) VALUES (?, 'agent:s1', 'hook.run', ?, ?, ?)").run(new Date().toISOString(), s.change, JSON.stringify({ event: "after_land", command: "x", exit: 0, log: `${OLD}/.git/canon/logs/after-land-7.log` }), OLD);
  } finally { w.db.close(); }
  return { root, OLD, ...s };
}

test("BR-2649: the brief finds the old location from a recorded worktree that is gone, rewrites every path, forgets the recorded process and says so once", () => {
  const { root, OLD, change, worktree } = moved();
  const first = cli(root, "brief");
  expect(first.code).toBe(0);
  expect(first.text).toContain(`canon: this repository moved from ${OLD} to ${root}`);
  const w = ws(root);
  try {
    expect(w.db.db.query<{ worktree: string; pid: number | null }, [string]>("SELECT worktree, pid FROM claims WHERE subject = ?").get(change)).toEqual({ worktree, pid: null });
    const ev = w.db.db.query<{ worktree: string; detail: string }, []>("SELECT worktree, detail FROM events WHERE kind = 'hook.run' ORDER BY id DESC LIMIT 1").get()!;
    expect(ev.worktree).toBe(root);
    expect((JSON.parse(ev.detail) as { log: string }).log).toBe(join(root, ".git/canon/logs/after-land-7.log"));
    expect(w.db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind != 'state.relocate' AND (worktree LIKE '/old/%' OR detail LIKE '%/old/place/%')").get()!.n).toBe(0);
    expect(w.db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'state.relocate'").get()!.n).toBe(1);
  } finally { w.db.close(); }
  expect(cli(root, "brief").text).not.toContain("this repository moved");
});

test("BR-2649: a log path alone finds the old primary checkout; nothing moved, nothing is said or written", () => {
  const root = realpathSync(project()); roots.push(root);
  startNew(root, "Unmoved", "agent:s1");
  expect(cli(root, "brief").text).not.toContain("this repository moved");
  const OLD = `/old/place/${basename(root)}`;
  const w = ws(root);
  try {
    expect(w.db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'state.relocate'").get()!.n).toBe(0);
    const logs = join(dirname(w.db.db.filename), "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "landed-review-1.log"), "ok\n");
    w.db.db.query("INSERT INTO landed_reviews(entry, change, base, head, landed, state, log, queued_at) VALUES (1, 'C-1', 'abc', 'def', 1, 'done', ?, ?)").run(`${OLD}/.git/canon/logs/landed-review-1.log`, new Date().toISOString());
  } finally { w.db.close(); }
  expect(cli(root, "brief").text).toContain(`canon: this repository moved from ${OLD} to ${root}`);
  const after = ws(root);
  try {
    expect(after.db.db.query<{ log: string }, []>("SELECT log FROM landed_reviews").get()!.log).toBe(join(root, ".git/canon/logs/landed-review-1.log"));
  } finally { after.db.close(); }
});
