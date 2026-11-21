import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";
import { executionStats, renderExecutionStats } from "./execution.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const MAIN = join(import.meta.dir, "../../invocation/main.ts");

/** A commit on main changing `code` lines of src/x.ts and one canon/ file; returns [base, sha]. */
function landing(root: string, code: number): [string, string] {
  const base = sh(root, "rev-parse", "HEAD");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, `src/x${Math.random().toString(36).slice(2)}.ts`), Array.from({ length: code }, (_, i) => `const a${i} = ${Math.random()};`).join("\n") + "\n");
  writeFileSync(join(root, "canon/note.md"), `${Math.random()}\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "landing");
  return [base, sh(root, "rev-parse", "HEAD")];
}
function event(root: string, ts: string, actor: string, kind: string, subject: string, detail: Record<string, unknown> = {}) {
  const w = ws(root);
  try { w.db.db.query("INSERT INTO events(ts, actor, worktree, kind, subject, detail) VALUES (?, ?, ?, ?, ?, ?)").run(ts, actor, root, kind, subject, JSON.stringify(detail)); } finally { w.db.close(); }
}
const lastId = (root: string) => { const w = ws(root); try { return w.db.db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM events").get()!.id ?? 0; } finally { w.db.close(); } };

test("BR-2611: changes first landed in the window are grouped by who did them, with time to land, refusals, test runs and code lines", () => {
  const root = project(); roots.push(root);
  // landed before the window: not counted
  event(root, "2026-11-20T08:00:00.000Z", "agent:s1", "start.ok", "C-1");
  const [b1, s1] = landing(root, 5);
  event(root, "2026-11-20T08:30:00.000Z", "agent:s1", "land.ok", "C-1", { base: b1, sha: s1 });
  const since = lastId(root);
  event(root, "2026-11-20T09:00:00.000Z", "agent:s1", "land.ok", "C-1", { base: b1, sha: s1 });
  // the main session itself: 42 minutes, one refusal, two test runs, 120 code lines
  event(root, "2026-11-20T10:00:00.000Z", "agent:s1", "start.ok", "C-2");
  event(root, "2026-11-20T10:10:00.000Z", "agent:s1", "work.test", "C-2");
  event(root, "2026-11-20T10:20:00.000Z", "agent:s1", "land.refuse", "C-2");
  event(root, "2026-11-20T10:30:00.000Z", "agent:s1", "work.test", "C-2");
  const [b2, s2] = landing(root, 120);
  event(root, "2026-11-20T10:42:30.000Z", "agent:s1", "land.ok", "C-2", { base: b2, sha: s2 });
  // delegated and landed by the worker: 90 minutes from the delegation
  event(root, "2026-11-20T11:00:00.000Z", "agent:s1", "start.ok", "C-3");
  event(root, "2026-11-20T11:10:00.000Z", "agent:s1", "delegation.create", "C-3");
  event(root, "2026-11-20T11:15:00.000Z", "agent:s1:w1", "start.ok", "C-3");
  const [b3, s3] = landing(root, 10);
  event(root, "2026-11-20T12:40:00.000Z", "agent:s1:w1", "land.ok", "C-3", { base: b3, sha: s3 });
  // delegated, then landed by the main session
  event(root, "2026-11-20T13:00:00.000Z", "agent:s1", "delegation.create", "C-4");
  event(root, "2026-11-20T13:30:00.000Z", "agent:s1:w2", "land.refuse", "C-4");
  event(root, "2026-11-20T13:40:00.000Z", "agent:s1:w2", "land.refuse", "C-4");
  const [b4, s4] = landing(root, 4);
  event(root, "2026-11-20T14:00:00.000Z", "agent:s1", "land.ok", "C-4", { base: b4, sha: s4 });
  // no start and no delegation recorded: not counted
  event(root, "2026-11-20T15:00:00.000Z", "agent:s1", "land.ok", "C-5", { base: b4, sha: s4 });
  const w = ws(root);
  const g = executionStats(w.db, root, since, lastId(root));
  w.db.close();
  expect(g).toEqual([
    { way: "self", changes: 1, medianMinutes: 42, averageRefusals: 1, medianTests: 2, medianLines: 120 },
    { way: "worker", changes: 1, medianMinutes: 90, averageRefusals: 0, medianTests: 0, medianLines: 10 },
    { way: "taken-back", changes: 1, medianMinutes: 60, averageRefusals: 2, medianTests: 0, medianLines: 4 },
  ]);
  const text = renderExecutionStats(g);
  expect(text.split("\n")[0]).toStartWith("Execution");
  expect(text).toContain("main session itself");
  expect(text).toMatch(/main session itself +1 change\(s\) {2}median 42m to land {2}1 refusal\(s\) avg {2}median 2 test run\(s\) {2}median 120 code line\(s\)/);
  const out = Bun.spawnSync(["bun", MAIN, "stats", "--since", String(since)], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:s1" } });
  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString()).toContain("Execution (changes whose first landing is in the window, by who did them)");
  expect(out.stdout.toString()).toMatch(/delegated, worker landed +1 change\(s\)/);
});

test("BR-2611: a group with no change says 0 and -, and with no landing in the window there is no section", () => {
  const root = project(); roots.push(root);
  event(root, "2026-11-20T10:00:00.000Z", "agent:s1", "start.ok", "C-2");
  const [b, s] = landing(root, 3);
  event(root, "2026-11-20T10:05:00.000Z", "agent:s1", "land.ok", "C-2", { base: b, sha: s });
  const w = ws(root);
  const g = executionStats(w.db, root, 0, lastId(root));
  expect(g[1]).toEqual({ way: "worker", changes: 0, medianMinutes: null, averageRefusals: null, medianTests: null, medianLines: null });
  expect(renderExecutionStats(g)).toMatch(/delegated, worker landed +0 change\(s\) {2}median - to land {2}- refusal\(s\) avg/);
  expect(renderExecutionStats(executionStats(w.db, root, lastId(root), lastId(root)))).toBe("");
  w.db.close();
});
