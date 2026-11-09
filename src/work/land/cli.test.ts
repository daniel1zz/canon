import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../../invocation/config.ts";
import { check } from "../../knowledge/check/check.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { enqueue, finishEntry, tryTurn } from "./queue/queue.ts";
import { land } from "./land.ts";
import { FAST, project, quiet, sh, startNew, waitFor, ws, landingProcess } from "../testkit.ts";

// reason: these tests drive a spawned `canon work land` and wait out queue polls on purpose (C-111).
const TIMED = 30_000;
const CLI = join(import.meta.dir, "../../invocation/main.ts");

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
    await waitFor("the landing to wait in the queue", () => other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(s.worktree) !== null);
    await waitFor("the one ahead to have held the turn for a while", () => Date.now() > held + 500); // so the wait to compare with is not close to 0
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
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...landingProcess() } });
    await waitFor("the landing to queue", () => other.db.db.query("SELECT 1 FROM queue WHERE worktree = ?").get(s.worktree) !== null);
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
    const findings = check({ root, ...read, testFiles: []});
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

describe("a landing that adds a decision still proposed says so", () => {
  // Fixture ids are assembled at runtime so this file does not itself name decisions when canon check scans the repo.
  const d = (n: number) => ["D", n].join("-");
  const decision = (n: number, status: string) =>
    `---\nid: ${d(n)}\ntitle: Pick ${n}\nstatus: ${status}\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n   - 来源：refund.txt “export function refund(order)”\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
  const add = (wt: string, ...files: [number, string][]) => {
    mkdirSync(join(wt, "canon/decisions"), { recursive: true });
    writeFileSync(join(wt, "refund.txt"), "export function refund(order) {}\n");
    for (const [n, status] of files) writeFileSync(join(wt, `canon/decisions/${d(n)}.md`), decision(n, status));
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "decisions");
  };

  test("BR-2355: each new proposed decision is named in the output and one event lists them, and the landing still succeeds", async () => {
    const root = project();
    const s = startNew(root, "Proposes");
    add(s.worktree, [5, "proposed"], [6, "proposed"], [7, "accepted"]);
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`proposed decision: ${d(5)} Pick 5 lands still proposed`);
    expect(r.out).toContain(`canon decision accept ${d(6)}`);
    expect(r.out).not.toContain(`proposed decision: ${d(7)}`);
    expect(events(root, "land.proposed").map((e) => e["decisions"])).toEqual([[d(5), d(6)]]);
  }, TIMED);

  test("BR-2355: an accepted new decision, an edit of a decision already on main, or no decision at all prints nothing and records no event", async () => {
    const root = project();
    const a = startNew(root, "Accepted");
    add(a.worktree, [5, "accepted"], [6, "proposed"]);
    sh(a.worktree, "rm", "-q", `canon/decisions/${d(6)}.md`);
    sh(a.worktree, "commit", "-qm", "only the accepted one");
    const ra = await canonIn(a.worktree, "work", "land");
    expect(ra.code).toBe(0);
    expect(ra.out).not.toContain("proposed decision:");

    const root2 = project();
    const old = startNew(root2, "Old");
    add(old.worktree, [6, "proposed"]);
    expect((await canonIn(old.worktree, "work", "land")).code).toBe(0);
    const edit = startNew(root2, "Edits");
    writeFileSync(join(edit.worktree, `canon/decisions/${d(6)}.md`), decision(6, "proposed").replace("B.\n", "B, reworded.\n"));
    sh(edit.worktree, "commit", "-qam", "edit");
    const re = await canonIn(edit.worktree, "work", "land");
    expect(re.code).toBe(0);
    expect(re.out).not.toContain("proposed decision:");
    expect(events(root2, "land.proposed").length).toBe(1); // the first landing's only

    const root3 = project();
    const none = startNew(root3, "None");
    commitFile(none.worktree, "app.txt", "changed\n");
    expect((await canonIn(none.worktree, "work", "land")).out).not.toContain("proposed decision:");
    expect(events(root3, "land.proposed")).toEqual([]);
    expect(events(root, "land.proposed")).toEqual([]);
  }, TIMED * 2);
});
