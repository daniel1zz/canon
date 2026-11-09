import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { enqueue, finishEntry } from "../queue/queue.ts";
import { land } from "../land.ts";
import { FAST, boundedLoop, gapCommit, project, sh, startNew, waitFor, ws, landingProcess } from "../../testkit.ts";

// reason: end-to-end batches run real landings through 2 s queue polls and spawned landers on purpose (C-111).
const TIMED = 60_000;
const CLI = join(import.meta.dir, "../../../invocation/main.ts");

/**
 * A project whose floor counts its runs in a file and fails on a FAIL file. With `hold`, the floor of a batch
 * worktree also waits until `release()` is called (at most LOOP_SECONDS), so a test can act while the batch floor
 * runs and then let it go, instead of guessing how long a sleeping floor lasts.
 */
function batchProject(extra: string, hold = false) {
  const root = project();
  const dir = join(root, "..", `${root.split("/").pop()}-floor`);
  mkdirSync(dir, { recursive: true });
  const runs = join(dir, "runs");
  const releaseFile = join(dir, "release");
  writeFileSync(join(dir, "floor.sh"), `echo "$PWD" >> ${runs}\n${hold ? `case $PWD in */batch/*) ${boundedLoop(`[ ! -e ${releaseFile} ]`)};; esac\n` : ""}test ! -e FAIL\n`);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "sh ${join(dir, "floor.sh")}"\ntests: []\n${extra}`);
  sh(root, "commit", "-qam", "config");
  const floorRuns = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : []);
  const release = () => writeFileSync(releaseFile, "");
  return { root, dir, floorRuns, release };
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
/** Collects what a spawned canon prints, so a test can wait for a line instead of guessing how long it takes. */
function collect(p: ReturnType<typeof spawnLand>) {
  const heard = { text: "" };
  for (const stream of [p.stdout, p.stderr]) {
    void (async () => {
      for await (const chunk of stream as ReadableStream<Uint8Array>) heard.text += new TextDecoder().decode(chunk);
    })();
  }
  return heard;
}
const spawnLand = (wt: string) => Bun.spawn(["bun", CLI, "work", "land"], { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...landingProcess() } });

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
    const release = `${marker}.release`;
    writeFileSync(join(hooks, "post-merge"), `#!/bin/sh\ntouch ${marker}\n${boundedLoop(`[ ! -e ${release} ]`)}\n`, { mode: 0o755 });
    // reason: both landers run in their own process; the leader's git calls block its process, which would hold this test's polling too.
    const run = await landTogether(root, [{ spawn: a.worktree }, { spawn: b.worktree }]);
    await until(() => existsSync(marker), 1200);
    expect(entryOf(root, b.worktree)!.state).toBe("landing"); // locked
    const heard = collect(run.procs[1]!);
    run.procs[1]!.kill("SIGTERM");
    await waitFor("the locked lander to say it waits for the batch", () => heard.text.includes("signal received while this landing is locked"));
    writeFileSync(release, ""); // main's update finishes only now: the SIGTERM came while the member was locked
    expect(await run.done).toEqual([0, 143]);
    expect(entryOf(root, b.worktree)!.state).toBe("landed");
    expect(events(root, "land.killed")).toEqual([]);
    expect(sh(root, "show", "main:b.txt")).toBe("b");
  }, TIMED);

  test("BR-2172 BR-2173 BR-2378 BR-2377: a member whose lander stops during the batch leaves it; the ones before it are tested again without it and land together", async () => {
    const { root, floorRuns, release } = batchProject("land_batch_max: 3\n", true);
    const a = startNew(root, "Leader");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Stays");
    commitFile(b.worktree, "b.txt", "b\n");
    const c = startNew(root, "Stops");
    commitFile(c.worktree, "c.txt", "c\n");
    const run = await landTogether(root, [a.worktree, b.worktree, { spawn: c.worktree }]);
    await until(() => floorRuns().some((p) => p.includes("/batch/")), 1200); // the batch floor runs
    run.procs[2]!.kill("SIGTERM");
    await until(() => entryOf(root, c.worktree)?.state === "failed"); // C is out of the batch before its floor ends
    release();
    const [oa, ob, code] = (await run.done) as [{ kind: string }, { kind: string }, number];
    expect(code).toBe(143);
    expect([oa.kind, ob.kind]).toEqual(["landed", "landed"]);
    expect(entryOf(root, c.worktree)).toMatchObject({ state: "failed", result: "killed" });
    expect(events(root, "batch.fail")).toEqual([]);
    expect(events(root, "batch.drop").map((d) => [d["entry"], d["reason"]])).toEqual([[entryOf(root, c.worktree)!.id, "lander-gone"]]);
    expect(events(root, "batch.end")).toMatchObject([{ leader: "landed", landed: [entryOf(root, b.worktree)!.id], sent_back: [{ entry: entryOf(root, c.worktree)!.id, reason: "lander-gone" }] }]);
    expect(events(root, "land.ok").find((o) => o["subject"] === "C-2")?.["batched_by"]).toBeDefined(); // B landed in A's batch
    expect(existsSync(join(root, "c.txt"))).toBe(false);
  }, TIMED);

  test("BR-2173 BR-2378 BR-2377: a setup that fails in the batch worktree voids the batch; each change then lands alone", async () => {
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
    expect(events(root, "batch.drop").map((d) => [d["entry"], d["reason"]])).toEqual([[entryOf(root, b.worktree)!.id, "batch-failed"]]);
    expect(events(root, "batch.end")).toMatchObject([{ leader: "alone", reason: "setup", landed: [], floors: 0 }]);
  }, TIMED);

  test("BR-2190 BR-2378 BR-2377: when the batch worktree cannot be made, the leader lands alone, records no batch.fail, and the member goes back to the queue and lands", async () => {
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
      expect(entryOf(root, b.worktree)!.state).toBe("landed");
      expect(floorRuns().length).toBe(2);
      expect(events(root, "batch.start").length).toBe(1);
      expect(events(root, "batch.drop").map((d) => d["reason"])).toEqual(["batch-failed"]);
      expect(events(root, "batch.end")).toMatchObject([{ leader: "alone", reason: "no-worktree", landed: [] }]);
    } finally {
      chmodSync(batchRoot, 0o755);
    }
  }, TIMED);

  test("BR-2190 BR-2378 BR-2377: a leader that finds it lost its turn before moving main sends the member back to the queue; the member lands", async () => {
    const { root, floorRuns, release } = batchProject("land_batch_max: 2\n", true);
    const a = startNew(root, "Leader");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Member");
    commitFile(b.worktree, "b.txt", "b\n");
    const before = sh(root, "rev-parse", "main");
    const run = await landTogether(root, [a.worktree, b.worktree]);
    await until(() => floorRuns().some((p) => p.includes("/batch/")), 1200);
    // A later lander saw the leader silent past the stale time and skipped it, while the batch floor ran.
    ws(root).db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE id = ?").run(entryOf(root, a.worktree)!.id);
    release();
    const [oa, ob] = (await run.done) as { kind: string; reason?: string }[];
    expect(oa!.kind === "refused" && oa!.reason).toBe("lost-turn");
    expect(ob!.kind).toBe("landed");
    expect(events(root, "batch.fail")).toEqual([]);
    expect(events(root, "batch.drop").map((d) => d["reason"])).toEqual(["leader-lost-turn"]);
    expect(events(root, "batch.end")).toMatchObject([{ leader: "lost-turn", landed: [] }]);
    expect(entryOf(root, b.worktree)!.state).toBe("landed");
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

  test("BR-2258 BR-2191: a commit tried while a landed member's branch follows main is refused by git, so the member never drops what the batch brought", async () => {
    const { root } = batchProject("land_batch_max: 2\n");
    const b = startNew(root, "Follows");
    commitFile(b.worktree, "b.txt", "b\n");
    const joined = sh(b.worktree, "rev-parse", "HEAD");
    commitFile(root, "a.txt", "a\n"); // what the leader's change brought to main
    sh(root, "cherry-pick", `${joined}~1`, joined); // B's commits on main, above it
    const onMain = sh(root, "rev-parse", "main");
    const other = ws(root, "agent:b");
    const leader = enqueue(other.db, "/leader", "C-98", "agent:b");
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const landing = land(ws(b.worktree), FAST, () => {});
    await until(() => entryOf(root, b.worktree)?.state === "waiting");
    writeFileSync(join(b.worktree, "b.txt"), "fix\n"); // the session's fix, not committed yet
    const tried = gapCommit(root, b.worktree, onMain);
    other.db.db.query("UPDATE queue SET state = 'landed', batch = ?, head = ?, result = ? WHERE id = ?").run(leader, joined, onMain, entryOf(root, b.worktree)!.id);
    expect((await landing).kind).toBe("landed");
    expect(existsSync(tried)).toBe(true); // the commit was tried in the gap
    expect(readFileSync(tried, "utf8")).toContain("index.lock");
    expect(sh(b.worktree, "rev-parse", "HEAD")).toBe(onMain);
    expect(sh(b.worktree, "show", "HEAD:a.txt")).toBe("a");
    expect(sh(b.worktree, "status", "--porcelain")).toBe("M b.txt");
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
