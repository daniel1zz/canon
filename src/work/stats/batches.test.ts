import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { project } from "../testkit.ts";
import { batchStats, renderBatchStats } from "./batches.ts";
import { lastEventId } from "./window.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const start = (d: CoordDb, entry: number, members: number[]) => d.event("agent:a", "batch.start", `C-${entry}`, { entry, members: members.map((m) => ({ entry: m, change: `C-${m}` })) });
const drop = (d: CoordDb, entry: number, leader: number, reason: string) => d.event("agent:a", "batch.drop", `C-${entry}`, { entry, leader, reason });
const end = (d: CoordDb, entry: number, leader: string, extra: Record<string, unknown> = {}) => d.event("agent:a", "batch.end", `C-${entry}`, { entry, leader, landed: [], sent_back: [], floors: 1, ...extra });

describe("canon stats batches", () => {
  test("BR-2379: leader outcomes, members landed and the reasons members left are counted, most frequent first", () => {
    const root = project();
    const d = CoordDb.open(join(root, ".git/canon/state.db"));
    if (!d.ok) throw new Error(d.error.message);
    const db = d.value;
    start(db, 1, [2, 3]); drop(db, 3, 1, "steps"); end(db, 1, "landed", { landed: [2] }); // landed with a member
    start(db, 4, [5, 6]); drop(db, 5, 4, "steps"); drop(db, 6, 4, "steps"); end(db, 4, "landed"); // landed alone
    start(db, 7, [8]); drop(db, 8, 7, "leader-refused"); end(db, 7, "refused", { reason: "floor" });
    start(db, 9, [10]); drop(db, 10, 9, "batch-failed"); end(db, 9, "alone", { reason: "setup" });
    start(db, 11, [12]); drop(db, 12, 11, "leader-lost-turn"); end(db, 11, "lost-turn");
    start(db, 13, [14]); // the leader stopped mid-batch: no batch.end
    const b = batchStats(db, 0, lastEventId(db));
    expect(b.batches).toBe(6);
    expect(b.unended).toBe(1);
    expect(b.leaders).toEqual({ landedWith: 1, landedAlone: 1, gaveUp: 1, lostTurn: 1, error: 0, refused: { floor: 1 } });
    expect(b.members).toEqual({ joined: 8, landed: 1, sentBack: { steps: 3, "batch-failed": 1, "leader-lost-turn": 1, "leader-refused": 1 } });
    const text = renderBatchStats(b);
    expect(text.split("\n")[0]).toContain("batches: 6 started, 5 ended, 1 without a batch.end");
    expect(text).toContain("leader: landed with members 1, landed alone 1, refused 1 (floor 1), gave up and went on alone 1, lost its turn 1, error 0");
    expect(text).toContain("members: 8 joined, 1 landed, 6 left without landing (steps 3, batch-failed 1, leader-lost-turn 1, leader-refused 1)");
    db.close();
  });

  test("BR-2379: only events after --since count, and no section at all when no batch started", () => {
    const root = project();
    const d = CoordDb.open(join(root, ".git/canon/state.db"));
    if (!d.ok) throw new Error(d.error.message);
    const db = d.value;
    start(db, 1, [2]); end(db, 1, "landed", { landed: [2] });
    const since = lastEventId(db);
    start(db, 3, [4]); drop(db, 4, 3, "rebase"); end(db, 3, "landed");
    expect(batchStats(db, since, lastEventId(db)).batches).toBe(1);
    expect(batchStats(db, since, lastEventId(db)).members).toMatchObject({ landed: 0, sentBack: { rebase: 1 } });
    expect(renderBatchStats(batchStats(db, lastEventId(db), lastEventId(db)))).toBe("");
    db.close();
  });

  test("BR-2379: canon stats prints the batch section, and --json stays the fixed array of checks", () => {
    const root = project();
    const d = CoordDb.open(join(root, ".git/canon/state.db"));
    if (!d.ok) throw new Error(d.error.message);
    start(d.value, 1, [2]); drop(d.value, 2, 1, "steps"); end(d.value, 1, "landed");
    d.value.close();
    const text = canon(root, "stats");
    expect(text.code).toBe(0);
    expect(text.out).toContain("batches: 1 started, 1 ended");
    expect(text.out).toContain("members: 1 joined, 0 landed, 1 left without landing (steps 1)");
    expect(canon(root, "stats", "--since", "0").out).toContain("batches: 1 started");
    expect(Array.isArray(JSON.parse(canon(root, "stats", "--json").out))).toBe(true);
  });
});
