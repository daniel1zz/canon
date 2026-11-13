import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../work/land/land.ts";
import { enqueue, finishEntry } from "../../work/land/queue/queue.ts";
import { selfProcess } from "../../work/claims/liveness.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";
import { NO_START_ENV, ensureLandedReviewer, landedReview, requeueLandedReview, runLandedReviews } from "./landed-queue.ts";

const CLI = join(import.meta.dir, "../../invocation/main.ts");

interface Row {
  id: number;
  entry: number;
  change: string | null;
  base: string;
  head: string;
  landed: number;
  log: string;
  state: string;
}
const jobs = (root: string) => ws(root).db.db.query<Row, []>("SELECT id, entry, change, base, head, landed, log, state FROM landed_reviews ORDER BY id").all();
/** The log's last line that is not an indented continuation of the one before it. */
const lastLine = (log: string) => readFileSync(log, "utf8").trimEnd().split("\n").filter((l) => !l.startsWith(" ")).at(-1);

/** A project with the billing domain on main and `review` set to a script that records each run's start and end, and fails while `fail` exists. */
function queueProject(extra = "") {
  const root = project();
  const dir = join(root, "..", `${root.split("/").pop()}-reviewer`);
  mkdirSync(dir, { recursive: true });
  const runs = join(dir, "runs");
  const fail = join(dir, "fail");
  const script = join(dir, "review.sh");
  // reason: a lock directory that already exists means another review is running at the same time (BR-2441)
  writeFileSync(
    script,
    `#!/bin/sh\ncat > /dev/null\nmkdir ${dir}/lock 2>/dev/null || echo overlap >> ${runs}\necho start >> ${runs}\nsleep 0.3\necho end >> ${runs}\nrmdir ${dir}/lock\nif [ -e ${fail} ]; then rm ${fail}; exit 3; fi\necho '{"findings":[]}'\n`,
  );
  chmodSync(script, 0o755);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(script)}\n${extra}`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  const seen = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : []);
  return { root, seen, fail };
}
function ruleChange(root: string, n: number) {
  const s = startNew(root, `Rule ${n}`);
  writeFileSync(join(s.worktree, `canon/rules/billing/BR-${n}.md`), `---\nid: BR-${n}\ntitle: Rule ${n}\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRule ${n} holds.\n`);
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", `rule ${n}`);
  return s;
}

describe("the queue of reviews after landing (BR-2441)", () => {
  test("BR-2441: a landing that changes a rule queues one review of the commit it put on main and ends before the reviewer ran; the reviewer runs it and its log ends with review: done", async () => {
    const { root, seen } = queueProject();
    const before = sh(root, "rev-parse", "main");
    const s = ruleChange(root, 1);
    const lines: string[] = [];
    const out = await land(ws(s.worktree), FAST, (l) => lines.push(l));
    expect(out.kind).toBe("landed");
    const said = lines.join("\n");
    expect(said).toContain("review: BR-1 are reviewed after the landing, in the background (log: ");
    expect(said).toContain(`canon work after-land --wait ${s.change} reports it`);
    expect(seen()).toEqual([]); // the landing did not wait for the review
    const [job] = jobs(root);
    const landOk = ws(root).db.db.query<{ id: number }, []>("SELECT id FROM events WHERE kind = 'land.ok' ORDER BY id DESC LIMIT 1").get()!.id;
    expect(job).toMatchObject({ change: s.change, base: before, head: sh(root, "rev-parse", "main"), landed: landOk, state: "queued" });
    expect(job!.log).toEndWith(`logs/landed-review-${job!.entry}-${landOk}.log`);
    expect((await runLandedReviews(ws(root), quiet, undefined)).ok).toBe(true);
    expect(seen()).toEqual(["start", "end"]);
    expect(readFileSync(job!.log, "utf8").split("\n")[0]).toBe(`review of ${s.change}: landed ${job!.head.slice(0, 9)} on ${before.slice(0, 9)}`);
    expect(lastLine(job!.log)).toBe("review: done");
    expect(jobs(root)[0]!.state).toBe("done");
  });

  test("BR-2441: two queued reviews run one after the other in queue order, never at the same time, by one reviewer", async () => {
    const { root, seen } = queueProject();
    for (const n of [1, 2]) expect((await land(ws(ruleChange(root, n).worktree), FAST, quiet)).kind).toBe("landed");
    const r = await runLandedReviews(ws(root), quiet, undefined);
    expect(r.ok && r.value).toBe(2);
    expect(seen()).toEqual(["start", "end", "start", "end"]);
    const [a, b] = jobs(root);
    expect([a!.state, b!.state]).toEqual(["done", "done"]);
    expect(readFileSync(a!.log, "utf8")).toContain("BR-1");
    expect(b!.base).toBe(a!.head);
  });

  test("BR-2441: with a reviewer alive, a landing that queues a review starts no second one; with none alive and the variable unset, it starts one", async () => {
    const { root } = queueProject();
    expect((await land(ws(ruleChange(root, 1).worktree), FAST, quiet)).kind).toBe("landed");
    const self = selfProcess()!;
    const db = ws(root).db;
    db.db.query("INSERT INTO landed_reviewer(id, pid, pid_start, started_at) VALUES (1, ?, ?, ?)").run(self.pid, self.start, new Date().toISOString());
    const said: string[] = [];
    delete process.env[NO_START_ENV];
    try {
      ensureLandedReviewer(ws(root), (l) => said.push(l));
    } finally {
      process.env[NO_START_ENV] = "0";
    }
    expect(said).toEqual([]);
    expect(jobs(root)[0]!.state).toBe("queued");
  });

  test("BR-2441: canon work review-landed while another reviewer is alive says so and exits 0, leaving the queue alone", async () => {
    const { root, seen } = queueProject();
    expect((await land(ws(ruleChange(root, 1).worktree), FAST, quiet)).kind).toBe("landed");
    const self = selfProcess()!;
    ws(root).db.db.query("INSERT INTO landed_reviewer(id, pid, pid_start, started_at) VALUES (1, ?, ?, ?)").run(self.pid, self.start, new Date().toISOString());
    const p = Bun.spawn(["bun", CLI, "work", "review-landed"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(0);
    expect(`${out}${err}`).toContain("another reviewer is running");
    expect(seen()).toEqual([]);
    expect(jobs(root)[0]!.state).toBe("queued");
  }, 30_000);

  test("BR-2441: a review left running by a reviewer whose process is gone is queued again and run by the next reviewer", async () => {
    const { root, seen } = queueProject();
    expect((await land(ws(ruleChange(root, 1).worktree), FAST, quiet)).kind).toBe("landed");
    const db = ws(root).db;
    db.db.query("UPDATE landed_reviews SET state = 'running'").run();
    // a pid that is not running: the start time recorded for it cannot match any process
    db.db.query("INSERT INTO landed_reviewer(id, pid, pid_start, started_at) VALUES (1, 999999, 'Thu Jan  1 00:00:00 1970', ?)").run(new Date().toISOString());
    const r = await runLandedReviews(ws(root), quiet, undefined);
    expect(r.ok && r.value).toBe(1);
    expect(seen()).toEqual(["start", "end"]);
    expect(jobs(root)[0]!.state).toBe("done");
    expect(db.db.query("SELECT COUNT(*) AS n FROM landed_reviewer").get()).toEqual({ n: 0 });
  });

  test("BR-2441: a reviewer command that exits 3 fails that review with a review.fail and a last log line review: could not run; the next queued review still runs", async () => {
    const { root, seen, fail } = queueProject();
    for (const n of [1, 2]) expect((await land(ws(ruleChange(root, n).worktree), FAST, quiet)).kind).toBe("landed");
    writeFileSync(fail, "");
    const r = await runLandedReviews(ws(root), quiet, undefined);
    expect(r.ok && r.value).toBe(2);
    const [a, b] = jobs(root);
    expect([a!.state, b!.state]).toEqual(["failed", "done"]);
    expect(lastLine(a!.log)).toStartWith("review: could not run: ");
    expect(lastLine(b!.log)).toBe("review: done");
    const fails = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'review.fail'").all().map((e) => JSON.parse(e.detail) as Record<string, unknown>);
    expect(fails.length).toBe(1);
    expect(fails[0]).toMatchObject({ landed: a!.landed, commit: a!.head });
    expect(String(fails[0]!["message"])).toContain("exit");
    expect(seen().filter((l) => l === "start").length).toBe(2);
  });

  test("BR-2441: two batch members that both change rules queue two reviews, each against the commit below its own", async () => {
    const { root } = queueProject("land_batch_max: 3\n");
    const a = ruleChange(root, 1);
    const b = ruleChange(root, 2);
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    const runs: Promise<Awaited<ReturnType<typeof land>>>[] = [];
    for (const wt of [a.worktree, b.worktree]) {
      runs.push(land(ws(wt), FAST, quiet));
      for (let n = 0; n < 200 && !other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(wt); n++) await Bun.sleep(10);
    }
    const base = sh(root, "rev-parse", "main");
    finishEntry(other.db, blocker, "landed", "x");
    const out = await Promise.all(runs);
    expect(out.map((o) => o.kind)).toEqual(["landed", "landed"]);
    const q = jobs(root);
    expect(q.map((j) => j.change)).toEqual([a.change, b.change]);
    expect(q[0]!.base).toBe(base);
    expect(q[1]!.base).toBe(q[0]!.head);
    expect(q[1]!.head).toBe(sh(root, "rev-parse", "main"));
    expect(q[0]!.entry).not.toBe(q[1]!.entry);
    expect(ws(root).db.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'batch.end'").get()).toEqual({ n: 1 }); // they did land as one batch
  }, 30_000);

  test("BR-2441 BR-2166 BR-2167: with CANON_LANDED_REVIEWER=0 the landing only queues; canon work after-land --wait starts the reviewer, waits for the review and prints its lines", async () => {
    const { root, seen } = queueProject();
    const s = ruleChange(root, 1);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(jobs(root)[0]!.state).toBe("queued");
    expect(ws(root).db.db.query("SELECT COUNT(*) AS n FROM landed_reviewer").get()).toEqual({ n: 0 });
    const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a" };
    delete env[NO_START_ENV];
    const p = Bun.spawn(["bun", CLI, "work", "after-land", s.change, "--wait"], { cwd: root, stdout: "pipe", stderr: "pipe", env });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect([code, `${out}${err}`]).toEqual([0, expect.stringContaining(`review after the landing of ${s.change}`)]);
    expect(out).toContain("finished");
    expect(out).toContain("review: done");
    expect(seen()).toEqual(["start", "end"]);
    expect(landedReview(ws(root).db, { change: s.change })?.state).toBe("done");
    // the reviewer it started has given up its place: the queue is empty
    for (let i = 0; i < 50 && ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM landed_reviewer").get()!.n > 0; i++) await Bun.sleep(100);
    expect(ws(root).db.db.query("SELECT COUNT(*) AS n FROM landed_reviewer").get()).toEqual({ n: 0 });
  }, 60_000);

  test("BR-2441: a landing that only changes code queues nothing", async () => {
    const { root } = queueProject();
    const s = startNew(root, "Code");
    writeFileSync(join(s.worktree, "src/billing/a.ts"), "export const a = 1;\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "code");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(jobs(root)).toEqual([]);
  });
});

describe("canon work review-landed --again (BR-2449)", () => {
  const cli = (root: string, ...args: string[]) => {
    const r = Bun.spawnSync(["bun", CLI, "work", "review-landed", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", [NO_START_ENV]: "0" } });
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  test("BR-2449: a failed review after a landing is queued again with the same base, head and entry and a new log; the reviewer then runs it to done; a done one is not queued again", async () => {
    const { root, fail } = queueProject();
    writeFileSync(fail, "");
    const s = ruleChange(root, 1);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect((await runLandedReviews(ws(root), quiet, undefined)).ok).toBe(true);
    const [failed] = jobs(root);
    expect(failed!.state).toBe("failed");
    const r = cli(root, "--again", s.change);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`is queued again after it failed`);
    expect(r.out).toContain(`canon work after-land --wait ${s.change} reports it`);
    const again = jobs(root)[1]!;
    expect(again).toMatchObject({ entry: failed!.entry, change: s.change, base: failed!.base, head: failed!.head, landed: failed!.landed, state: "queued" });
    expect(again.log).toEndWith(`logs/landed-review-${failed!.entry}-${failed!.landed}-again-1.log`);
    expect((await runLandedReviews(ws(root), quiet, undefined)).ok).toBe(true);
    expect(lastLine(again.log)).toBe("review: done");
    expect(landedReview(ws(root).db, { change: s.change })?.id).toBe(again.id);
    const done = cli(root, "--again", s.change);
    expect(done.code).toBe(5);
    expect(done.out).toContain("is done");
    expect(jobs(root)).toHaveLength(2);
  });

  test("BR-2449: canon work status lists a failed review with its log and the --again command until a later run is done", async () => {
    const { root, fail } = queueProject();
    writeFileSync(fail, "");
    const s = ruleChange(root, 1);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect((await runLandedReviews(ws(root), quiet, undefined)).ok).toBe(true);
    const status = () => Bun.spawnSync(["bun", CLI, "work", "status"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } }).stdout.toString();
    const shown = status();
    expect(shown).toContain(`the review after the landing of ${s.change} failed`);
    expect(shown).toContain(`canon work review-landed --again ${s.change}`);
    expect(shown).toContain(jobs(root)[0]!.log);
    rmSync(fail, { force: true });
    expect(cli(root, "--again", s.change).code).toBe(0);
    expect((await runLandedReviews(ws(root), quiet, undefined)).ok).toBe(true);
    expect(status()).not.toContain("failed (log:");
  }, 60_000);

  test("BR-2449: a queued review is not queued twice; a landing that never had a review is queued with its landed entry and a log without -again", async () => {
    const { root } = queueProject();
    const s = ruleChange(root, 1);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(cli(root, "--again", s.change).code).toBe(5);
    const [first] = jobs(root);
    ws(root).db.db.query("DELETE FROM landed_reviews").run();
    const q = requeueLandedReview(ws(root), quiet, s.change);
    expect(q.ok).toBe(true);
    const [job] = jobs(root);
    expect(job).toMatchObject({ entry: first!.entry, base: first!.base, head: first!.head, state: "queued" });
    expect(job!.log).toEndWith(`logs/landed-review-${first!.entry}-${first!.landed}.log`);
  });

  test("BR-2449: no landing is exit 3, a land.ok with no base is exit 1, and a value that is not a change id is exit 2", () => {
    const { root } = queueProject();
    expect(cli(root, "--again", "C-999").code).toBe(3);
    ws(root).db.event("agent:a", "land.ok", "C-7", { sha: "abc", recovered: true });
    const r = cli(root, "--again", "C-7");
    expect(r.code).toBe(1);
    expect(r.out).toContain("records no base commit");
    for (const bad of ["5", "foo"]) expect(cli(root, "--again", bad).code).toBe(2);
  });
});
