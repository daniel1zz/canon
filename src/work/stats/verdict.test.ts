import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoordDb } from "../db.ts";
import { ownDiffId } from "../land/worktree-state.ts";
import { project, sh } from "../testkit.ts";
import { pendingBlocks, recordVerdict, renderPending, renderVerdictSummary, verdictSummary } from "./verdict.ts";

// reason: the CLI cases spawn canon, which spawns git; under load a spawn can take seconds (C-111)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");

function canon(cwd: string, actor: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function freshDb(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-verdict-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function dbOf(root: string): CoordDb {
  const r = CoordDb.open(join(root, ".git/canon/state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function commit(root: string, file: string, text: string): string {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", file);
  return sh(root, "rev-parse", "HEAD").trim();
}

/**
 * A repository where C-1 was blocked by the review at commit `x` (its fingerprint taken the way a landing takes
 * it), then fixed in `y` and landed as `y` on top of `base`.
 */
function blockedThenLanded(withBase: boolean) {
  const root = project();
  const base = sh(root, "rev-parse", "HEAD").trim();
  sh(root, "checkout", "-qb", "change/C-1");
  commit(root, "canon/changes/C-1.md", "opened\n");
  const x = commit(root, "app.txt", "one\nTWO\nthree\n");
  const diff = ownDiffId(root, "main")!;
  const y = commit(root, "rule.md", "reworded\n");
  sh(root, "checkout", "-q", "main");
  sh(root, "merge", "-q", "--ff-only", "change/C-1");
  const db = dbOf(root);
  if (!withBase) db.event("agent:a", "land.ok", "C-0", { sha: base, diff: "d0" });
  db.event("agent:a", "claim.take", "C-1", {});
  db.event("agent:a", "land.refuse", "C-1", { reason: "review", message: "rule review blocked:\n  - BR-1 contradicts BR-2", diff });
  db.event("agent:a", "land.ok", "C-1", { sha: y, diff: "d1", ...(withBase ? { base } : {}) });
  return { root, db, x, y };
}

describe("canon verdict pending", () => {
  test("BR-2253: lists a landed change's review block with the commit it blocked, found by fingerprint, and the commit it landed as", () => {
    const { root, db, x, y } = blockedThenLanded(true);
    const blocks = pendingBlocks(db, root, "agent:b");
    expect(blocks.map((b) => [b.subject, b.before, b.after])).toEqual([["C-1", x, y]]);
    expect(renderPending(blocks)).toContain(`before ${x}  after ${y}\n    rule review blocked:`);
  });

  test("BR-2253: a landing that recorded no base uses the previous landing's commit as where main stood", () => {
    const { root, db, x } = blockedThenLanded(false);
    expect(pendingBlocks(db, root, "agent:b")[0]?.before).toBe(x);
  });

  test("BR-2253: not listed when unlanded, not a review block, already judged by this judge kind, or authored by the actor; no fingerprint gives ?", () => {
    const { root, db } = blockedThenLanded(true);
    const blocks0 = pendingBlocks(db, root, "agent:b")[0]!.refusal;
    db.event("agent:z", "land.refuse", "C-2", { reason: "review", message: "m", diff: "d" }); // never landed
    db.event("agent:z", "land.refuse", "C-3", { reason: "floor", message: "m", diff: "d" });
    db.event("agent:z", "land.ok", "C-3", { sha: "s3", diff: "e" });
    expect(pendingBlocks(db, root, "agent:a")).toEqual([]); // agent:a authored C-1
    db.event("agent:b", "review.verdict", "C-1", { refusal: blocks0, verdict: "real", judge: "agent", reason: "r" });
    expect(pendingBlocks(db, root, "agent:c")).toEqual([]);
    expect(pendingBlocks(db, root, "human:alice").map((b) => b.subject)).toEqual(["C-1"]);
    const old = freshDb();
    old.event("agent:z", "land.refuse", "C-9", { reason: "review", message: "m" });
    old.event("agent:z", "land.ok", "C-9", { sha: "s9" });
    expect(pendingBlocks(old, root, "agent:b").map((b) => b.before)).toEqual([null]);
    expect(renderPending([])).toBe("(nothing to judge)");
  });
});

describe("canon verdict record", () => {
  function blocked() {
    const db = freshDb();
    db.event("agent:a", "claim.take", "C-182", {});
    db.event("agent:a", "land.refuse", "C-182", { reason: "review", message: "m", diff: "d" }); // id 2
    db.event("agent:a", "land.refuse", "C-182", { reason: "floor", message: "m", diff: "d" }); // id 3
    return db;
  }
  const verdicts = (db: CoordDb) => db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.verdict'").get()!.n;

  test("BR-2254: an outside agent and a human each record one verdict; the judge kind comes from the executor", () => {
    const db = blocked();
    const a = recordVerdict(db, "agent:b", 2, "real", " the rule really had two versions ");
    expect(a.ok && a.value).toEqual({ subject: "C-182", judge: "agent" });
    const h = recordVerdict(db, "human:alice", 2, "wording", "no real problem");
    expect(h.ok && h.value.judge).toBe("human");
    const row = db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'review.verdict' ORDER BY id LIMIT 1").get()!;
    expect([row.subject, JSON.parse(row.detail)]).toEqual(["C-182", { refusal: 2, verdict: "real", judge: "agent", reason: "the rule really had two versions" }]);
  });

  test("BR-2254: a second verdict of the same kind, the author, a non-review refusal or bad input write nothing", () => {
    const db = blocked();
    expect(recordVerdict(db, "agent:b", 2, "real", "r").ok).toBe(true);
    const codes = [
      recordVerdict(db, "agent:c", 2, "wording", "r"),
      recordVerdict(db, "agent:a", 2, "real", "r"),
      recordVerdict(db, "agent:c", 3, "real", "r"),
      recordVerdict(db, "agent:c", 999, "real", "r"),
      recordVerdict(db, "agent:c", 2, "maybe", "r"),
      recordVerdict(db, "agent:c", 2, "real", "  "),
    ].map((r) => (r.ok ? "ok" : r.error.code));
    expect(codes).toEqual(["conflict", "refused", "not_found", "not_found", "invalid", "invalid"]);
    expect(verdicts(db)).toBe(1);
  });

  test("BR-2254: checks run in order: input before the id, the author before a duplicate; judging another block of the same change is no authorship", () => {
    const db = blocked();
    db.event("agent:a", "land.refuse", "C-182", { reason: "review", message: "m2", diff: "d2" }); // id 4
    expect(recordVerdict(db, "agent:b", 2, "real", "r").ok).toBe(true);
    const code = (r: ReturnType<typeof recordVerdict>) => (r.ok ? "ok" : r.error.code);
    expect(code(recordVerdict(db, "agent:c", 999, "maybe", "r"))).toBe("invalid");
    expect(code(recordVerdict(db, "agent:a", 2, "real", "r"))).toBe("refused");
    expect(code(recordVerdict(db, "agent:b", 4, "wording", "r"))).toBe("ok");
    expect(verdicts(db)).toBe(2);
  });

  test("BR-2254: through the CLI the exit codes are 0, 5, 1, 3 and 2", () => {
    const root = project();
    const db = dbOf(root);
    db.event("agent:a", "claim.take", "C-1", {});
    db.event("agent:a", "land.refuse", "C-1", { reason: "review", message: "m", diff: "d" });
    db.close();
    expect(canon(root, "agent:b", "verdict", "record", "2", "real", "--reason", "r").code).toBe(0);
    expect(canon(root, "agent:c", "verdict", "record", "2", "real", "--reason", "r").code).toBe(5);
    expect(canon(root, "agent:a", "verdict", "record", "2", "real", "--reason", "r").code).toBe(1);
    expect(canon(root, "agent:c", "verdict", "record", "1", "real", "--reason", "r").code).toBe(3);
    expect(canon(root, "agent:c", "verdict", "record", "2", "real").code).toBe(2);
  });
});

describe("canon stats review block verdicts", () => {
  function judged(agent: Record<string, number>, human: Record<string, number> = {}, blocks = 26) {
    const db = freshDb();
    for (let i = 0; i < blocks; i++) db.event("agent:a", "land.refuse", `C-${i + 1}`, { reason: "review", message: "m", diff: "d" });
    for (const [judge, counts] of [["agent", agent], ["human", human]] as const) {
      let n = 1; // each judge kind judges blocks from the first one on
      for (const [verdict, k] of Object.entries(counts)) for (let i = 0; i < k; i++) db.event(`${judge}:j`, "review.verdict", "C-x", { refusal: n++, verdict, judge, reason: "r" });
    }
    return db;
  }

  test("BR-2255: fewer than 10 verdicts of a judge kind give counts and no share; agent and human are never added", () => {
    const text = renderVerdictSummary(verdictSummary(judged({ real: 2, wording: 1 })));
    expect(text).toBe(
      "review block verdicts:\n  agent: 3 of 26 judged, real 2, wording 1; fewer than 10 verdicts, no share\n  human: 0 of 26 judged, real 0, wording 0; fewer than 10 verdicts, no share",
    );
    const both = verdictSummary(judged({ real: 1 }, { wording: 1 }, 1));
    expect(both.map((j) => [j.judge, j.judged, j.real, j.wording])).toEqual([["agent", 1, 1, 0], ["human", 1, 0, 1]]);
  });

  test("BR-2255: 10 verdicts give the wording share; no review block means no section", () => {
    expect(renderVerdictSummary(verdictSummary(judged({ real: 7, wording: 3 })))).toContain("  agent: 10 of 26 judged, real 7, wording 3, wording share 30.0%");
    expect(renderVerdictSummary(verdictSummary(freshDb()))).toBeUndefined();
  });

  test("BR-2255: --since counts only the window's blocks, with their verdicts written after it", () => {
    const db = freshDb();
    db.event("agent:a", "land.refuse", "C-1", { reason: "review", message: "m", diff: "d" }); // 1
    db.event("agent:a", "land.refuse", "C-2", { reason: "review", message: "m", diff: "d" }); // 2
    db.event("agent:b", "review.verdict", "C-1", { refusal: 1, verdict: "real", judge: "agent", reason: "r" });
    db.event("agent:b", "review.verdict", "C-2", { refusal: 2, verdict: "wording", judge: "agent", reason: "r" });
    const [agent] = verdictSummary(db, 1);
    expect([agent!.blocks, agent!.judged, agent!.wording]).toEqual([1, 1, 1]);
  });

  test("BR-2255: canon stats prints the section after the check table, and --json stays an array of checks", () => {
    const root = project();
    const db = dbOf(root);
    db.event("agent:a", "land.refuse", "C-1", { reason: "review", message: "m", diff: "d" });
    db.close();
    const r = canon(root, "agent:b", "stats");
    expect(r.code).toBe(0);
    expect(r.out).toContain("\nreview block verdicts:\n  agent: 0 of 1 judged");
    expect(r.out.indexOf("review block verdicts:")).toBeGreaterThan(r.out.indexOf("setup"));
    const j = JSON.parse(canon(root, "agent:b", "stats", "--json").out) as unknown[];
    expect(Array.isArray(j)).toBe(true);
  });
});
