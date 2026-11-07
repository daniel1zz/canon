import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claims } from "../../claims/claims.ts";
import { enqueue, finishEntry, joinBatch, landBatched, refuseInBatch, unlockBatch } from "../queue/queue.ts";
import { land } from "../land.ts";
import { reopenForGoneLander } from "./batch.ts";
import { processOf } from "../../claims/liveness.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { FAST, boundedLoop, project, quiet, sh, startNew, waitFor, ws } from "../../testkit.ts";

// reason: these tests wait out real time on purpose (sleeps, leases, stale times) or drive a spawned `canon work land`;
// under load that alone came within 0.4 s of the 5 s default (C-111), so they get room, not the rest of the file.
const TIMED = 30_000;
const CLI = join(import.meta.dir, "../../../invocation/main.ts");
const until = async (what: () => boolean, tries = 400) => {
  for (let i = 0; i < tries && !what(); i++) await Bun.sleep(25);
  expect(what()).toBe(true);
};
/** Everything a stream has said so far, read in the background. */
function collect(stream: ReadableStream<Uint8Array>): { text: string } {
  const seen = { text: "" };
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of stream) seen.text += dec.decode(chunk, { stream: true });
  })();
  return seen;
}

describe("batched landings", () => {
  function batchProject(extra = "land_batch_max: 3\n") {
    const root = project();
    const dir = join(root, "..", `${root.split("/").pop()}-floor`);
    mkdirSync(dir, { recursive: true });
    const runs = join(dir, "runs");
    const sneak = join(dir, "sneak");
    writeFileSync(join(dir, "floor.sh"), `echo run >> ${runs}\nif [ -f ${sneak} ]; then git -C "$(cat ${sneak})" commit -q --allow-empty -m sneaky; rm ${sneak}; fi\ntest ! -e FAIL\n`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "sh ${join(dir, "floor.sh")}"\ntests: []\n${extra}`);
    sh(root, "commit", "-qam", "config");
    const floorRuns = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").length : 0);
    return { root, floorRuns, sneak };
  }
  const commitFile = (wt: string, path: string, text: string) => {
    writeFileSync(join(wt, path), text);
    sh(wt, "add", path);
    sh(wt, "commit", "-qm", path);
  };
  /** Lands the worktrees together: all queue behind a silent entry, which then finishes, so the first leads. */
  async function landTogether(root: string, worktrees: readonly string[], opts = FAST) {
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    const said: string[][] = worktrees.map(() => []);
    const runs: Promise<Awaited<ReturnType<typeof land>>>[] = [];
    for (const [i, wt] of worktrees.entries()) {
      runs.push(land(ws(wt), opts, (m) => said[i]!.push(m)));
      for (let n = 0; n < 200 && !other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(wt); n++) await Bun.sleep(10);
    }
    finishEntry(other.db, blocker, "landed", "x");
    return { out: await Promise.all(runs), said };
  }
  const landOks = (root: string) =>
    ws(root).db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'land.ok' ORDER BY id").all().map((r) => ({ ...(JSON.parse(r.detail) as Record<string, unknown>), subject: r.subject }) as Record<string, unknown>);

  test("BR-2172: landings waiting behind the leader are tested with it under one floor run, keep their own commits and land in order", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    const { out, said } = await landTogether(root, [a.worktree, b.worktree], { ...FAST, finish: true });
    expect(out.map((o) => o.kind === "landed" && o.finished)).toEqual([true, true]);
    expect(floorRuns()).toBe(1);
    for (const c of [a.change, b.change]) expect(sh(root, "show", `main:canon/changes/${c}-${c === a.change ? "a" : "b"}.md`)).toContain("status: done");
    expect(claims(ws(root).db).filter((c) => c.subject === a.change || c.subject === b.change)).toEqual([]);
    const main = sh(root, "rev-parse", "main");
    expect(out[1]!.kind === "landed" && out[1]!.sha).toBe(main);
    expect(out[0]!.kind === "landed" && sh(root, "merge-base", "--is-ancestor", out[0]!.sha, main)).toBe("");
    expect(sh(root, "log", "--format=%s", "main").split("\n").slice(0, 3)).toEqual([`canon: close ${b.change}`, "b.txt", `canon: open ${b.change} B`]);
    expect(sh(b.worktree, "rev-parse", "HEAD")).toBe(main); // the member's branch follows its landed commit
    expect(existsSync(join(b.worktree, "a.txt"))).toBe(true);
    expect(said[0]!.some((m) => m.startsWith(`batch: testing ${b.change} together with ${a.change}`))).toBe(true);
    const oks = landOks(root);
    expect(oks.map((o) => o.subject)).toEqual([a.change, b.change]);
    expect(oks[1]!["batched_by"]).toBeNumber();
    const { computeStats } = await import("../../stats/stats.ts");
    expect(computeStats(ws(root).db, {}, "2026-11-03").find((x) => x.check === "floor")!.runs).toBe(1);
  }, TIMED);

  test("BR-2173: a batch whose floor fails finds the change that makes it fail: the one before it lands, that one is refused for the floor", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "Good");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Bad");
    commitFile(b.worktree, "FAIL", "x\n");
    const { out, said } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out[0]!.kind).toBe("landed");
    expect(out[1]!.kind === "refused" && out[1]!.reason).toBe("floor");
    expect(out[1]!.kind === "refused" && out[1]!.message).toContain(`the floor failed once ${b.change} joined the batch of ${a.change}`);
    expect(floorRuns()).toBe(2); // the whole batch, then the leader alone
    expect(existsSync(join(root, "FAIL"))).toBe(false);
    expect(sh(root, "show", "main:a.txt")).toBe("a");
    expect(said[0]!.some((m) => m.startsWith(`batch: the floor fails once ${b.change} joins; it is refused`))).toBe(true);
    const fails = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'batch.fail'").all().map((r) => JSON.parse(r.detail) as Record<string, unknown>);
    expect(fails.length).toBe(1);
    expect(fails[0]!["floors"]).toBe(2);
  }, TIMED);

  test("BR-2173: with the failing change in the middle, the ones ahead of it land together, it is refused, and the one after it goes back to the queue and lands", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Bad");
    commitFile(b.worktree, "FAIL", "x\n");
    const c = startNew(root, "C");
    commitFile(c.worktree, "c.txt", "c\n");
    const { out } = await landTogether(root, [a.worktree, b.worktree, c.worktree]);
    expect(out.map((o) => (o.kind === "refused" ? o.reason : o.kind))).toEqual(["landed", "floor", "landed"]);
    // the batch of 3, prefix 1 passes, prefix 2 fails; then C on its own turn
    expect(floorRuns()).toBe(4);
    expect(existsSync(join(root, "FAIL"))).toBe(false);
    expect(sh(root, "show", "main:c.txt")).toBe("c");
  }, TIMED);

  test("BR-2173: when the leader alone already fails the floor, the leader is refused for the floor and the member goes back to the queue and lands", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "Bad leader");
    commitFile(a.worktree, "FAIL", "x\n");
    const b = startNew(root, "Good");
    commitFile(b.worktree, "b.txt", "b\n");
    const { out } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out.map((o) => (o.kind === "refused" ? o.reason : o.kind))).toEqual(["floor", "landed"]);
    expect(floorRuns()).toBe(3); // the batch, the leader alone, then B
    expect(existsSync(join(root, "FAIL"))).toBe(false);
  }, TIMED);

  test("BR-2172: land_batch_max all takes every landing waiting in the queue into one batch under one floor run", async () => {
    const { root, floorRuns } = batchProject("land_batch_max: all\n");
    const wts = ["A", "B", "C", "D", "E"].map((n) => {
      const s = startNew(root, n);
      commitFile(s.worktree, `${n}.txt`, `${n}\n`);
      return s.worktree;
    });
    const { out } = await landTogether(root, wts);
    expect(out.map((o) => o.kind)).toEqual(["landed", "landed", "landed", "landed", "landed"]);
    expect(floorRuns()).toBe(1);
  }, TIMED);

  test("BR-2173: a member its own steps refuse leaves the batch alone; the others land together under one floor, and it is judged again on its own turn", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Dangling");
    const file = sh(b.worktree, "ls-files", "canon/changes").split("\n").find((f) => f.includes(b.change))!;
    writeFileSync(join(b.worktree, file), `${readFileSync(join(b.worktree, file), "utf8")}\nSee D-99.\n`);
    sh(b.worktree, "commit", "-qam", "dangling");
    const c = startNew(root, "C");
    commitFile(c.worktree, "c.txt", "c\n");
    const { out, said } = await landTogether(root, [a.worktree, b.worktree, c.worktree]);
    expect(out.map((o) => (o.kind === "refused" ? o.reason : o.kind))).toEqual(["landed", "check", "landed"]);
    expect(said[0]!.some((m) => m.startsWith(`batch: ${b.change} was refused in the batch (check); it goes back to the queue, the others go on`))).toBe(true);
    const oks = landOks(root);
    expect(oks.find((o) => o["subject"] === c.change)!["batched_by"]).toBeDefined();
    expect(floorRuns()).toBe(1); // A and C together; B's own landing is refused by canon check before its floor (BR-2014)
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'batch.fail'").get()?.n).toBe(0);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'batch.drop'").get()?.n).toBe(1);
  }, TIMED);

  test("BR-2173 BR-2106: a member whose worktree changes during the batch goes back to the queue; the leader is tested again without it and lands", async () => {
    const { root, floorRuns, sneak } = batchProject();
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    writeFileSync(sneak, b.worktree);
    const { out } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out.map((o) => o.kind)).toEqual(["landed", "landed"]);
    expect(floorRuns()).toBe(3);
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe("sneaky");
  }, TIMED);

  test("BR-2172: a member that does not rebase onto the batch is left out and lands on its own turn; land_batch_max 1 never batches", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "One");
    commitFile(a.worktree, "app.txt", "one\nTWO\nthree\n");
    const b = startNew(root, "Two");
    commitFile(b.worktree, "app.txt", "one\n2\nthree\n");
    const { out } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out[0]!.kind).toBe("landed");
    expect(out[1]!.kind === "refused" && out[1]!.reason).toBe("conflict");
    expect(floorRuns()).toBe(1);

    const single = batchProject("");
    const c = startNew(single.root, "C");
    commitFile(c.worktree, "c.txt", "c\n");
    const d = startNew(single.root, "D");
    commitFile(d.worktree, "d.txt", "d\n");
    const both = await landTogether(single.root, [c.worktree, d.worktree]);
    expect(both.out.map((o) => o.kind)).toEqual(["landed", "landed"]);
    expect(single.floorRuns()).toBe(2);
  }, TIMED);

  test("BR-2049 BR-2172: a slow setup in the batch worktree keeps the leader's heartbeat, so the batch lands (issue #60)", async () => {
    // reason: setup runs only in the batch worktree (its path has /batch/), so starting the changes stays fast.
    // the setup holds until the test has seen the leader beat for longer than the 1.2 s stale time, so it lasts as long as the test needs
    const hold = join(tmpdir(), `canon-setup-hold-${process.pid}-${Date.now()}`);
    writeFileSync(`${hold}.sh`, `touch ${hold}.started\n${boundedLoop(`[ ! -e ${hold}.release ]`)}\n`);
    const { root, floorRuns } = batchProject(`land_batch_max: 2\nlander_stale_minutes: 0.02\nsetup: "case $PWD in */batch/*) sh ${hold}.sh;; esac"\n`);
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    const beat = () => Date.parse(ws(root).db.db.query<{ heartbeat: string }, [string]>("SELECT heartbeat FROM queue WHERE worktree = ? ORDER BY id DESC LIMIT 1").get(a.worktree)!.heartbeat);
    const released = (async () => {
      await waitFor("the setup in the batch worktree to start", () => existsSync(`${hold}.started`), 30_000);
      const first = beat();
      await waitFor("a leader heartbeat more than the stale time after the first, while the setup still holds", () => beat() > first + 1200, 30_000);
      writeFileSync(`${hold}.release`, "");
    })();
    const { out } = await landTogether(root, [a.worktree, b.worktree]);
    await released;
    expect(out.map((o) => o.kind)).toEqual(["landed", "landed"]);
    expect(floorRuns()).toBe(1);
    expect(landOks(root)[1]!["batched_by"]).toBeNumber();
  }, TIMED);

  test("BR-2018 BR-2099: a locked member whose lander is gone gets its close commit taken back when main does not move; a live one keeps it", () => {
    const { root } = batchProject();
    const b = startNew(root, "Closed");
    const file = `canon/changes/${b.change}-closed.md`;
    writeFileSync(join(b.worktree, file), readFileSync(join(b.worktree, file), "utf8").replace("status: open", "status: done"));
    sh(b.worktree, "commit", "-qam", `canon: close ${b.change}`);
    const w = ws(b.worktree);
    const live = enqueue(w.db, b.worktree, b.change, "agent:a", processOf(process.pid)!);
    expect(reopenForGoneLander(w, { entry: live, subject: b.change, worktree: b.worktree }, quiet)).toBe(false);
    expect(sh(b.worktree, "log", "-1", "--format=%s")).toBe(`canon: close ${b.change}`);
    const gone = enqueue(w.db, b.worktree, b.change, "agent:a", { pid: 2 ** 22 + 12345, start: "never" });
    expect(reopenForGoneLander(w, { entry: gone, subject: b.change, worktree: b.worktree }, quiet)).toBe(true);
    expect(readFileSync(join(b.worktree, file), "utf8")).toContain("status: open");
  });

  test("BR-2099 BR-2018: a locked member signalled while main moves waits until the batch is settled; unlocked, it takes its own close commit back even though the leader saw it alive", async () => {
    const { root } = batchProject();
    const b = startNew(root, "Signalled");
    const head = sh(b.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const leader = enqueue(other.db, "/leader", "C-98", "agent:b", processOf(process.pid)!); // alive and beating
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const p = Bun.spawn(["bun", CLI, "work", "land", "--finish"], { cwd: b.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const out = collect(p.stdout);
    const entry = () => other.db.db.query<{ id: number; state: string; result: string | null }, [string]>("SELECT id, state, result FROM queue WHERE worktree = ? ORDER BY id DESC LIMIT 1").get(b.worktree);
    await until(() => entry()?.state === "waiting");
    expect(sh(b.worktree, "log", "-1", "--format=%s")).toBe(`canon: close ${b.change}`);
    // The leader took B into its batch and locked it in; now it moves main.
    other.db.db.query("UPDATE queue SET batch = ?, head = ?, state = 'landing' WHERE id = ?").run(leader, sh(b.worktree, "rev-parse", "HEAD"), entry()!.id);
    p.kill("SIGTERM");
    await until(() => out.text.includes("waiting for the batch"));
    // main was refused (e.g. main-dirty): the leader unlocks B and finds B's lander still alive, so it leaves B alone.
    unlockBatch(other.db, leader, [entry()!.id]);
    expect(reopenForGoneLander(other, { entry: entry()!.id, subject: b.change, worktree: b.worktree }, quiet)).toBe(false);
    expect(await p.exited).toBe(143);
    expect(entry()).toMatchObject({ state: "failed", result: "killed" });
    expect(sh(b.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(readCorpus(b.worktree).corpus.docs.find((d) => d.id === b.change)).toMatchObject({ status: "open" });
  }, TIMED);

  test("BR-2099 BR-2018: a locked member signalled while main moves exits once it is recorded landed, keeping its close commit", async () => {
    const { root } = batchProject();
    const b = startNew(root, "Signalled landed");
    const other = ws(root, "agent:b");
    const leader = enqueue(other.db, "/leader", "C-98", "agent:b", processOf(process.pid)!);
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const p = Bun.spawn(["bun", CLI, "work", "land", "--finish"], { cwd: b.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const out = collect(p.stdout);
    const entry = () => other.db.db.query<{ id: number; state: string; result: string | null }, [string]>("SELECT id, state, result FROM queue WHERE worktree = ? ORDER BY id DESC LIMIT 1").get(b.worktree);
    await until(() => entry()?.state === "waiting");
    const closed = sh(b.worktree, "rev-parse", "HEAD");
    other.db.db.query("UPDATE queue SET batch = ?, head = ?, state = 'landing' WHERE id = ?").run(leader, closed, entry()!.id);
    p.kill("SIGTERM");
    await until(() => out.text.includes("waiting for the batch"));
    expect(landBatched(other.db, entry()!.id, closed)).toBe(true); // main moved with B on it
    expect(await p.exited).toBe(143);
    expect(entry()!.state).toBe("landed");
    expect(sh(b.worktree, "log", "-1", "--format=%s")).toBe(`canon: close ${b.change}`);
  }, TIMED);

  test("BR-2173 BR-2018: a member the leader refused in its batch takes its close commit back even when a signal comes before it reads the refusal", async () => {
    const { root } = batchProject();
    const b = startNew(root, "Refused then signalled");
    const head = sh(b.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const leader = enqueue(other.db, "/leader", "C-98", "agent:b", processOf(process.pid)!);
    other.db.db.query("UPDATE queue SET state = 'landing' WHERE id = ?").run(leader);
    const p = Bun.spawn(["bun", CLI, "work", "land", "--finish"], { cwd: b.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const entry = () => other.db.db.query<{ id: number; state: string }, [string]>("SELECT id, state FROM queue WHERE worktree = ? ORDER BY id DESC LIMIT 1").get(b.worktree);
    await until(() => entry()?.state === "waiting");
    expect(sh(b.worktree, "log", "-1", "--format=%s")).toBe(`canon: close ${b.change}`);
    expect(joinBatch(other.db, leader, entry()!.id, sh(b.worktree, "rev-parse", "HEAD"))).toBe(true);
    expect(refuseInBatch(other.db, leader, entry()!.id, "the floor failed once it joined")).toBe(true);
    // reason: the lander polls at most every 2 s; the signal comes right after the refusal, before it polls again
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(sh(b.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(readCorpus(b.worktree).corpus.docs.find((d) => d.id === b.change)).toMatchObject({ status: "open" });
  }, TIMED);

  test("BR-2173: a member whose commits a dead leader already put on main lands again with nothing new", async () => {
    const root = project();
    const b = startNew(root, "Already there");
    commitFile(b.worktree, "b.txt", "b\n");
    sh(root, "cherry-pick", `${sh(b.worktree, "rev-parse", "HEAD")}~1`, `${sh(b.worktree, "rev-parse", "HEAD")}`);
    const before = sh(root, "rev-parse", "main");
    const out = await land(ws(b.worktree), FAST, quiet);
    expect(out.kind === "landed" && out.sha).toBe(before);
    expect(sh(root, "rev-parse", "main")).toBe(before);
  }, TIMED);
});
