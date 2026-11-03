import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../../config/config.ts";
import { check } from "../../knowledge/check/check.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { enqueue, finishEntry, tryTurn } from "./queue.ts";
import { land } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

// reason: these tests drive a spawned `canon work land` and wait out queue polls on purpose (C-111).
const TIMED = 30_000;
const CLI = join(import.meta.dir, "../../cli/main.ts");

async function canonIn(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

const commitFile = (wt: string, path: string, text: string) => {
  writeFileSync(join(wt, path), text);
  sh(wt, "add", path);
  sh(wt, "commit", "-qm", path);
};

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e): Record<string, unknown> => ({ subject: e.subject, ...(JSON.parse(e.detail) as Record<string, unknown>) }));

describe("canon work land refuses before queuing, with the exit code the rule names", () => {
  test("BR-2013: uncommitted work exits 2 and says to commit first", async () => {
    const root = project();
    const s = startNew(root, "Dirty");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.code).toBe(2);
    expect(r.err).toContain("commit them first");
    expect(ws(root).db.db.query("SELECT 1 FROM queue").all()).toEqual([]);
  });

  test("BR-2031: landing from the checkout that has main, or from a detached HEAD, exits 2", async () => {
    const root = project();
    expect((await canonIn(root, "work", "land")).code).toBe(2);
    const s = startNew(root, "Detached");
    sh(s.worktree, "checkout", "-q", "--detach");
    expect((await canonIn(s.worktree, "work", "land")).code).toBe(2);
  });

  test("BR-2043: a project without a floor exits 2 and says there is no floor", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "tests: []\n");
    sh(root, "commit", "-qam", "no floor");
    const s = startNew(root, "No floor");
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.code).toBe(2);
    expect(r.err).toContain("no `floor`");
  });
});

describe("refusals and waits after queuing", () => {
  test("BR-2014: a red floor exits 1, leaves main, and the message names the log holding the floor's whole output", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Red");
    commitFile(s.worktree, "FAIL", "x\n");
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.code).toBe(1);
    const log = r.err.match(/full log: ([^)]+)\)/)?.[1];
    expect(log).toBeString();
    expect(existsSync(log!)).toBe(true);
    expect(sh(root, "rev-parse", "main")).toBe(before);
  }, TIMED);

  test("BR-2048: without --timeout the configured land_timeout_minutes is the limit, then exit 75", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nland_timeout_minutes: 5\n");
    const five = readConfig(root);
    expect(five.ok && five.value.landTimeoutMs).toBe(5 * 60_000);
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nland_timeout_minutes: 0.02\n"); // 1.2 s, so the test does not wait 5 minutes
    sh(root, "commit", "-qam", "short timeout");
    const s = startNew(root, "Waits");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.code).toBe(75);
    expect(events(root, "land.refuse").map((e) => e["reason"])).toEqual(["timeout"]);
  }, TIMED);

  test("BR-2049: a landing refused by a check stops its heartbeat, and the lander behind it starts at once", async () => {
    const root = project();
    const s = startNew(root, "Refused");
    commitFile(s.worktree, "FAIL", "x\n");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("floor");
    const other = ws(root, "agent:b");
    expect(tryTurn(other.db, enqueue(other.db, "/elsewhere", "C-99", "agent:b")).mine).toBe(true);
  });

  test("BR-2122: a lander behind another records a wait at least as long as the one ahead held the turn", async () => {
    const root = project();
    const s = startNew(root, "Behind");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const held = Date.now();
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(1500);
    finishEntry(other.db, ahead, "landed", "x");
    const heldMs = Date.now() - held;
    expect((await landing).kind).toBe("landed");
    const turns = events(root, "land.turn");
    expect(turns.length).toBe(1);
    expect(turns[0]!["waited_ms"] as number).toBeGreaterThanOrEqual(heldMs - 100);
  }, TIMED);

  test("BR-2122: a lander killed by SIGTERM while queued records land.killed and no land.turn", async () => {
    const root = project();
    const s = startNew(root, "Killed waiting");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    for (let i = 0; i < 200 && !other.db.db.query("SELECT 1 FROM queue WHERE worktree = ?").get(s.worktree); i++) await Bun.sleep(50);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(events(root, "land.turn")).toEqual([]);
    expect(events(root, "land.killed").length).toBe(1);
  }, TIMED);
});

describe("closing a change", () => {
  test("BR-2161: an old change that is already done and has no lessons section is not reported by canon check", () => {
    const root = project();
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-1.md"), "---\nid: C-1\ntitle: Old\nstatus: done\nrules: []\n---\n\n## 为什么\n\nOld.\n\n## 要改什么\n\nOld.\n\n## 任务\n\n- [x] Old\n");
    const read = readCorpus(root);
    const findings = check({ root, ...read, testFiles: [], floorSkipPaths: [] });
    expect(findings.filter((f) => f.path.includes("C-1"))).toEqual([]);
  });

  test("BR-2018: --finish on a change that already says done makes no close commit, lands and releases the claim", async () => {
    const root = project();
    const s = startNew(root, "Already done");
    const file = sh(s.worktree, "ls-files", "canon/changes").split("\n").find((f) => f.includes(s.change))!;
    const text = await Bun.file(join(s.worktree, file)).text();
    writeFileSync(join(s.worktree, file), text.replace("status: open", "status: done"));
    sh(s.worktree, "commit", "-qam", "marked done earlier");
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind === "landed" && out.finished).toBe(true);
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe("marked done earlier"); // no `canon: close` on top
    expect(ws(root).db.db.query("SELECT 1 FROM claims WHERE subject = ?").all(s.change)).toEqual([]);
  });
});
