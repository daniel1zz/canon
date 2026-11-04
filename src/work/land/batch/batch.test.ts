import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims } from "../../claims/claims.ts";
import { enqueue, finishEntry } from "../queue/queue.ts";
import { land } from "../land.ts";
import { reopenForGoneLander } from "./batch.ts";
import { processOf } from "../../claims/liveness.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

// reason: these tests wait out real time on purpose (sleeps, leases, stale times) or drive a spawned `canon work land`;
// under load that alone came within 0.4 s of the 5 s default (C-111), so they get room, not the rest of the file.
const TIMED = 30_000;

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

  test("BR-2173: a batch whose floor fails falls back: the good change lands alone, the bad one is refused on its own floor", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "Good");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Bad");
    commitFile(b.worktree, "FAIL", "x\n");
    const { out, said } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out[0]!.kind).toBe("landed");
    expect(out[1]!.kind === "refused" && out[1]!.reason).toBe("floor");
    expect(floorRuns()).toBe(3); // the batch, then each alone
    expect(existsSync(join(root, "FAIL"))).toBe(false);
    expect(sh(root, "show", "main:a.txt")).toBe("a");
    expect(said[0]!.some((m) => m.includes("go back to the queue to land on their own"))).toBe(true);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'batch.fail'").get()?.n).toBe(1);
  }, TIMED);

  test("BR-2173: a member whose worktree changes during the batch makes it fall back; both then land alone", async () => {
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
    const { root, floorRuns } = batchProject(`land_batch_max: 2\nlander_stale_minutes: 0.1\nsetup: "case $PWD in */batch/*) sleep 8;; esac"\n`);
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    const { out } = await landTogether(root, [a.worktree, b.worktree]);
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
