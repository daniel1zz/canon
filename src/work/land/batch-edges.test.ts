import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { enqueue, finishEntry } from "./queue.ts";
import { land } from "./land.ts";
import { FAST, project, sh, startNew, ws } from "../testkit.ts";

// reason: end-to-end batches run real landings through 2 s queue polls and spawned landers on purpose (C-111).
const TIMED = 60_000;
const CLI = join(import.meta.dir, "../../cli/main.ts");

/** A project whose floor counts its runs in a file, fails on a FAIL file, and sleeps `batchSleep` s in a batch worktree. */
function batchProject(extra: string, batchSleep = 0) {
  const root = project();
  const dir = join(root, "..", `${root.split("/").pop()}-floor`);
  mkdirSync(dir, { recursive: true });
  const runs = join(dir, "runs");
  writeFileSync(join(dir, "floor.sh"), `echo "$PWD" >> ${runs}\ncase $PWD in */batch/*) sleep ${batchSleep};; esac\ntest ! -e FAIL\n`);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "sh ${join(dir, "floor.sh")}"\ntests: []\n${extra}`);
  sh(root, "commit", "-qam", "config");
  const floorRuns = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : []);
  return { root, dir, floorRuns };
}
const commitFile = (wt: string, path: string, text: string) => {
  writeFileSync(join(wt, path), text);
  sh(wt, "add", path);
  sh(wt, "commit", "-qm", path);
};
const until = async (what: () => boolean, tries = 400) => {
  for (let i = 0; i < tries && !what(); i++) await Bun.sleep(25);
  expect(what()).toBe(true);
};
const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e): Record<string, unknown> => ({ subject: e.subject, ...(JSON.parse(e.detail) as Record<string, unknown>) }));
const entryOf = (root: string, wt: string) => ws(root).db.db.query<{ id: number; state: string; result: string | null; solo: number | null }, [string]>("SELECT id, state, result, solo FROM queue WHERE worktree = ? ORDER BY id DESC LIMIT 1").get(wt);
const spawnLand = (wt: string) => Bun.spawn(["bun", CLI, "work", "land"], { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });

/**
 * Queues each lander behind a silent entry, lets `before` change the queue, then frees it, so the first leads.
 * A worktree given as `{ spawn }` lands in its own `canon work land` process, so a signal can reach it.
 */
async function landTogether(root: string, landers: readonly (string | { spawn: string })[], before: () => void | Promise<void> = () => {}) {
  const other = ws(root, "agent:b");
  const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
  const said: string[][] = landers.map(() => []);
  const procs: (ReturnType<typeof spawnLand> | undefined)[] = [];
  const runs: Promise<unknown>[] = [];
  for (const [i, l] of landers.entries()) {
    const wt = typeof l === "string" ? l : l.spawn;
    if (typeof l === "string") {
      runs.push(land(ws(wt), FAST, (m) => said[i]!.push(m)));
      procs.push(undefined);
    } else {
      const p = spawnLand(wt);
      procs.push(p);
      runs.push(p.exited);
    }
    await until(() => entryOf(root, wt)?.state === "waiting");
  }
  await before();
  finishEntry(other.db, blocker, "landed", "x");
  return { done: Promise.all(runs), said, procs };
}

describe("a batch's own edges", () => {
  test("BR-2172: each landed change runs after_land once, with the commit below it as CANON_BASE and its own commit on main as CANON_HEAD", async () => {
    const { root, dir } = batchProject("land_batch_max: 3\n");
    const seen = join(dir, "after");
    writeFileSync(join(root, "canon/config.yaml"), readFileSync(join(root, "canon/config.yaml"), "utf8") + `hooks:\n  after_land: echo "$CANON_BASE $CANON_HEAD" >> ${seen}\n`);
    sh(root, "commit", "-qam", "after_land");
    const before = sh(root, "rev-parse", "main");
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    const run = await landTogether(root, [a.worktree, b.worktree]);
    const [oa, ob] = (await run.done) as { kind: string; sha: string }[];
    expect([oa!.kind, ob!.kind]).toEqual(["landed", "landed"]);
    await until(() => existsSync(seen) && readFileSync(seen, "utf8").trim().split("\n").length === 2);
    expect(readFileSync(seen, "utf8").trim().split("\n").sort()).toEqual([`${before} ${oa!.sha}`, `${oa!.sha} ${ob!.sha}`].sort());
  }, TIMED);

  test("BR-2172: land_batch_max 2 takes only the entry right behind the leader; the next one waits for its own turn", async () => {
    const { root, floorRuns } = batchProject("land_batch_max: 2\n");
    const wts = ["A", "B", "C"].map((t) => {
      const s = startNew(root, t);
      commitFile(s.worktree, `${t}.txt`, `${t}\n`);
      return s.worktree;
    });
    const run = await landTogether(root, wts);
    expect(((await run.done) as { kind: string }[]).map((o) => o.kind)).toEqual(["landed", "landed", "landed"]);
    const starts = events(root, "batch.start");
    expect((starts[0]!["members"] as unknown[]).length).toBe(1);
    expect(floorRuns().length).toBe(2); // A with B, then C alone
  }, TIMED);

  test("BR-2172: an entry queued by an older canon right behind the leader is not batched, and neither is any entry behind it", async () => {
    const { root, floorRuns } = batchProject("land_batch_max: 3\n");
    const wts = ["A", "Old", "C"].map((t) => {
      const s = startNew(root, t);
      commitFile(s.worktree, `${t}.txt`, `${t}\n`);
      return s.worktree;
    });
    const run = await landTogether(root, wts, () => {
      ws(root).db.db.query("UPDATE queue SET solo = NULL WHERE worktree = ?").run(wts[1]!); // what an older canon leaves
    });
    expect(((await run.done) as { kind: string }[]).map((o) => o.kind)).toEqual(["landed", "landed", "landed"]);
    const leaders = events(root, "batch.start").map((e) => e["entry"]);
    expect(leaders).not.toContain(entryOf(root, wts[0]!)!.id); // A led no batch
    expect(floorRuns().filter((p) => !p.includes("/batch/")).length).toBeGreaterThanOrEqual(1); // A ran its floor alone
  }, TIMED);

  test("BR-2172 BR-2099: a member locked in when its lander gets SIGTERM is still recorded landed once main moves", async () => {
    const { root } = batchProject("land_batch_max: 2\n");
    const a = startNew(root, "Leader");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Locked");
    commitFile(b.worktree, "b.txt", "b\n");
    // reason: main is checked out in the primary checkout, so it moves by `git merge --ff-only`; post-merge runs after the members are locked in.
    const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
    mkdirSync(hooks, { recursive: true });
    const marker = join(root, "..", `${root.split("/").pop()}-moving`);
    writeFileSync(join(hooks, "post-merge"), `#!/bin/sh\ntouch ${marker}\nsleep 2\n`, { mode: 0o755 });
    // reason: both landers run in their own process; the leader's git calls block its process, which would hold this test's polling too.
    const run = await landTogether(root, [{ spawn: a.worktree }, { spawn: b.worktree }]);
    await until(() => existsSync(marker), 1200);
    expect(entryOf(root, b.worktree)!.state).toBe("landing"); // locked
    run.procs[1]!.kill("SIGTERM");
    expect(await run.done).toEqual([0, 143]);
    expect(entryOf(root, b.worktree)!.state).toBe("landed");
    expect(events(root, "land.killed")).toEqual([]);
    expect(sh(root, "show", "main:b.txt")).toBe("b");
  }, TIMED);

  test("BR-2172 BR-2173: a member whose lander stops before the lock voids the batch; no member is locked and the others land alone", async () => {
    const { root, floorRuns } = batchProject("land_batch_max: 3\n", 3);
    const a = startNew(root, "Leader");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Stays");
    commitFile(b.worktree, "b.txt", "b\n");
    const c = startNew(root, "Stops");
    commitFile(c.worktree, "c.txt", "c\n");
    const run = await landTogether(root, [a.worktree, b.worktree, { spawn: c.worktree }]);
    await until(() => floorRuns().some((p) => p.includes("/batch/")), 1200); // the batch floor runs
    run.procs[2]!.kill("SIGTERM");
    const [oa, ob, code] = (await run.done) as [{ kind: string }, { kind: string }, number];
    expect(code).toBe(143);
    expect([oa.kind, ob.kind]).toEqual(["landed", "landed"]);
    expect(entryOf(root, c.worktree)).toMatchObject({ state: "failed", result: "killed" });
    const fails = events(root, "batch.fail");
    expect(fails.length).toBe(1);
    expect(fails[0]!["why"]).toContain("a member left the batch");
    expect(entryOf(root, b.worktree)!.solo).toBe(1); // B landed on its own afterwards
    expect(existsSync(join(root, "c.txt"))).toBe(false);
  }, TIMED);

  test("BR-2173: a setup that fails in the batch worktree voids the batch; each change then lands alone", async () => {
    const { root, floorRuns } = batchProject(`land_batch_max: 2\nsetup: "case $PWD in */batch/*) exit 1;; esac"\n`);
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    const run = await landTogether(root, [a.worktree, b.worktree]);
    expect(((await run.done) as { kind: string }[]).map((o) => o.kind)).toEqual(["landed", "landed"]);
    const fails = events(root, "batch.fail");
    expect(fails.length).toBe(1);
    expect(fails[0]!["why"]).toContain("setup exited 1");
    expect(floorRuns().length).toBe(2); // the batch never reached its floor
  }, TIMED);

  test("BR-2190: when the batch worktree cannot be made, the leader lands alone, records no batch.fail, and the member is not marked solo", async () => {
    const { root, floorRuns } = batchProject("land_batch_max: 2\n");
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    const batchRoot = join(dirname(ws(root).db.db.filename), "batch");
    mkdirSync(batchRoot, { recursive: true });
    chmodSync(batchRoot, 0o555);
    try {
      const run = await landTogether(root, [a.worktree, b.worktree]);
      const out = (await run.done) as { kind: string }[];
      expect(out.map((o) => o.kind)).toEqual(["landed", "landed"]);
      expect(run.said[0]!.some((m) => m.includes("could not create a worktree to test in"))).toBe(true);
      expect(events(root, "batch.fail")).toEqual([]);
      expect(entryOf(root, b.worktree)!.solo).toBe(0);
      expect(floorRuns().length).toBe(2);
    } finally {
      chmodSync(batchRoot, 0o755);
    }
  }, TIMED);

  test("BR-2190: a leader that finds it lost its turn before moving main sends the member back to the queue unmarked; the member lands", async () => {
    const { root, floorRuns } = batchProject("land_batch_max: 2\n", 2);
    const a = startNew(root, "Leader");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Member");
    commitFile(b.worktree, "b.txt", "b\n");
    const before = sh(root, "rev-parse", "main");
    const run = await landTogether(root, [a.worktree, b.worktree]);
    await until(() => floorRuns().some((p) => p.includes("/batch/")), 1200);
    // A later lander saw the leader silent past the stale time and skipped it, while the batch floor ran.
    ws(root).db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE id = ?").run(entryOf(root, a.worktree)!.id);
    const [oa, ob] = (await run.done) as { kind: string; reason?: string }[];
    expect(oa!.kind === "refused" && oa!.reason).toBe("lost-turn");
    expect(ob!.kind).toBe("landed");
    expect(events(root, "batch.fail")).toEqual([]);
    expect(entryOf(root, b.worktree)!.solo).toBe(0);
    expect(sh(root, "show", "main:b.txt")).toBe("b");
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    expect(sh(root, "merge-base", "--is-ancestor", before, "main")).toBe("");
  }, TIMED);

  test("BR-2191: a member whose branch moved after the batch landed it is left as it is, with a hint to rebase onto main", async () => {
    const { root } = batchProject("land_batch_max: 2\n");
    const b = startNew(root, "Moved");
    commitFile(b.worktree, "b.txt", "b\n");
    const joined = sh(b.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const leader = enqueue(other.db, "/leader", "C-98", "agent:b");
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const said: string[] = [];
    const landing = land(ws(b.worktree), FAST, (m) => said.push(m));
    await until(() => entryOf(root, b.worktree)?.state === "waiting");
    const id = entryOf(root, b.worktree)!.id;
    // The leader tested B at `joined` and landed it at main; B's branch got a commit meanwhile.
    commitFile(b.worktree, "late.txt", "late\n");
    const moved = sh(b.worktree, "rev-parse", "HEAD");
    other.db.db.query("UPDATE queue SET state = 'landed', batch = ?, head = ?, result = ? WHERE id = ?").run(leader, joined, sh(root, "rev-parse", "main"), id);
    const out = await landing;
    expect(out.kind).toBe("landed");
    expect(sh(b.worktree, "rev-parse", "HEAD")).toBe(moved);
    expect(said.some((m) => m.includes("branch moved after it joined the batch") && m.includes("git rebase main"))).toBe(true);
  }, TIMED);

  test("BR-2191: a member whose files have local edits the landed commit would overwrite keeps its branch and files, with the same hint", async () => {
    const { root } = batchProject("land_batch_max: 2\n");
    const b = startNew(root, "Edited");
    commitFile(b.worktree, "b.txt", "b\n");
    const joined = sh(b.worktree, "rev-parse", "HEAD");
    writeFileSync(join(root, "app.txt"), "main moved\n");
    sh(root, "commit", "-qam", "main moved"); // the commit B moves to changes app.txt
    const other = ws(root, "agent:b");
    const leader = enqueue(other.db, "/leader", "C-98", "agent:b");
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const said: string[] = [];
    const landing = land(ws(b.worktree), FAST, (m) => said.push(m));
    await until(() => entryOf(root, b.worktree)?.state === "waiting");
    const id = entryOf(root, b.worktree)!.id;
    writeFileSync(join(b.worktree, "app.txt"), "local edit\n");
    other.db.db.query("UPDATE queue SET state = 'landed', batch = ?, head = ?, result = ? WHERE id = ?").run(leader, joined, sh(root, "rev-parse", "main"), id);
    const out = await landing;
    expect(out.kind).toBe("landed");
    expect(sh(b.worktree, "rev-parse", "HEAD")).toBe(joined);
    expect(readFileSync(join(b.worktree, "app.txt"), "utf8")).toBe("local edit\n");
    expect(said.some((m) => m.includes("local edits keep this worktree's files") && m.includes("git rebase main"))).toBe(true);
  }, TIMED);
});
