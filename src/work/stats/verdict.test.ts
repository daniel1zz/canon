import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoordDb } from "../db.ts";
import { project, sh } from "../testkit.ts";
import { pendingBlocks, recordVerdict, renderPending, renderVerdictSummary, verdictSummary } from "./verdict.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

function canon(cwd: string, actor: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: actor };
  // reason: a human actor is only accepted outside a Claude Code session (BR-2023)
  if (!actor.startsWith("agent:")) delete env["CLAUDECODE"];
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
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
 * Change `change` blocked by the review at commit `x` (the block event records it), then fixed in `y` (which adds
 * `fix-<change>.md`) and landed. Events: claim, review.block, land.refuse, land.ok.
 */
function blockLand(root: string, db: CoordDb, change: string, findings: string[], opts: { actor?: string } = {}) {
  const actor = opts.actor ?? "agent:a";
  const base = sh(root, "rev-parse", "HEAD").trim();
  sh(root, "checkout", "-qb", `change/${change}`);
  commit(root, `canon/changes/${change}.md`, "opened\n");
  const x = commit(root, `blocked-${change}.txt`, "one\nTWO\nthree\n");
  const y = commit(root, `fix-${change}.md`, "reworded\n");
  sh(root, "checkout", "-q", "main");
  sh(root, "merge", "-q", "--ff-only", `change/${change}`);
  db.event(actor, "claim.take", change, {});
  db.event(actor, "review.block", change, { docs: ["BR-1"], findings, commit: x });
  db.event(actor, "land.refuse", change, { reason: "review", message: "rule review blocked", diff: "d0" });
  db.event(actor, "land.ok", change, { sha: y, diff: "d1", base });
  return { x, y, base };
}

/** blockLand, plus the id of the review.block it wrote. */
function blocked(root: string, db: CoordDb, change: string, findings: string[], opts: { actor?: string } = {}) {
  const r = blockLand(root, db, change, findings, opts);
  const block = db.db.query<{ id: number }, [string]>("SELECT id FROM events WHERE kind = 'review.block' AND subject = ? ORDER BY id DESC LIMIT 1").get(change)!.id;
  return { ...r, block };
}

const verdictRows = (db: CoordDb) => db.db.query<{ actor: string; subject: string; detail: string }, []>("SELECT actor, subject, detail FROM events WHERE kind = 'review.verdict' ORDER BY id").all().map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));

describe("canon verdict pending", () => {
  test("BR-2253: lists each finding of a landed change's review block with the commit it blocked, and never the landed commit", () => {
    const root = project();
    const db = dbOf(root);
    const { x, y, block } = blocked(root, db, "C-1", ["BR-1 contradicts BR-2", "BR-3 has no boundary"]);
    const blocks = pendingBlocks(db);
    expect(blocks.map((b) => [b.block, b.subject, b.before, b.findings.length])).toEqual([[block, "C-1", x, 2]]);
    const text = renderPending(blocks);
    const date = blocks[0]!.ts.slice(0, 10);
    expect(text).toBe(`#${block} C-1 ${date}  blocked commit ${x}\n  1. model - · human - · BR-1 contradicts BR-2\n  2. model - · human - · BR-3 has no boundary`);
    expect(text).not.toContain(y);
    expect(JSON.stringify(blocks)).not.toContain(y);
    expect(Object.keys(blocks[0]!)).toEqual(["block", "refusal", "subject", "ts", "before", "findings"]);
    expect(blocks[0]!.findings[0]).toEqual({ n: 1, text: "BR-1 contradicts BR-2", model: null, human: null });
  });

  test("BR-2253: a review.block written by the review after landing is listed at once with the landed commit it reviewed, with no refusal; a verdict on it closes nothing else", () => {
    const root = project();
    const db = dbOf(root);
    const landed = db.event("agent:a", "land.ok", "C-4", { sha: "z1", base: "b1", diff: "d" });
    const block = db.event("reviewer", "review.block", "C-4", { review: "rule", docs: ["BR-1"], findings: ["[contradiction] BR-1 contradicts BR-2"], landed, commit: "z1", base: "b1" });
    const blocks = pendingBlocks(db);
    expect(blocks.map((b) => [b.block, b.subject, b.refusal, b.before])).toEqual([[block, "C-4", null, "z1"]]);
    expect(renderPending(blocks)).toBe(`#${block} C-4 ${blocks[0]!.ts.slice(0, 10)}  reviewed after landing, commit z1\n  1. model - · human - · [contradiction] BR-1 contradicts BR-2`);
    expect(recordVerdict(db, "human:h", String(block), "1", "real", "it does").ok).toBe(true);
    expect(verdictRows(db).at(-1)!.detail).toMatchObject({ block, refusal: null, before: "z1" });
    expect(verdictSummary(db)[1]).toMatchObject({ blocks: 1, findings: 1, judged: 1, real: 1 });
  });

  test("BR-2253: existing verdicts show per finding; fully judged, unlanded and finding-less refusals are not listed; the author still sees it", () => {
    const root = project();
    const db = dbOf(root);
    const { block } = blocked(root, db, "C-1", ["first", "second", "third"]);
    db.event("agent:j", "review.verdict", "C-1", { block, finding: 1, verdict: "real", judge: "model", reason: "r" });
    db.event("human:h", "review.verdict", "C-1", { block, finding: 2, verdict: "spurious", judge: "human", reason: "r" });
    expect(renderPending(pendingBlocks(db))).toContain("  1. model real · human - · first\n  2. model - · human spurious · second\n  3. model - · human - · third");
    db.event("agent:z", "review.block", "C-2", { docs: [], findings: ["never landed"], commit: "c" });
    db.event("agent:z", "land.refuse", "C-2", { reason: "review", message: "m", diff: "d" });
    db.event("agent:z", "land.refuse", "C-3", { reason: "review", message: "the rule review could not run", diff: "d" });
    db.event("agent:z", "land.ok", "C-3", { sha: "s3", diff: "e" });
    expect(pendingBlocks(db).map((b) => b.subject)).toEqual(["C-1"]);
    expect(renderPending([])).toBe("(nothing to judge)");
  });

  test("BR-2253: one verdict per finding, from the model or a human, takes the block off the list", () => {
    const root = project();
    const db = dbOf(root);
    const { block } = blocked(root, db, "C-1", ["first", "second"]);
    db.event("agent:j", "review.verdict", "C-1", { block, finding: 1, verdict: "real", judge: "model", reason: "r" });
    expect(pendingBlocks(db).map((b) => b.block)).toEqual([block]);
    db.event("human:h", "review.verdict", "C-1", { block, finding: 2, verdict: "spurious", judge: "human", reason: "r" });
    expect(pendingBlocks(db)).toEqual([]);
  });

  test("BR-2253: a block written without the commit the review saw is not listed", () => {
    const root = project();
    const db = dbOf(root);
    db.event("agent:z", "review.block", "C-9", { docs: [], findings: ["f"] });
    db.event("agent:z", "land.refuse", "C-9", { reason: "review", message: "m" });
    db.event("agent:z", "land.ok", "C-9", { sha: "s9" });
    expect(pendingBlocks(db)).toEqual([]);
    expect(renderPending(pendingBlocks(db))).toBe("(nothing to judge)");
  });

  test("BR-2253: through the CLI the author is not filtered out", () => {
    const root = project();
    const db = dbOf(root);
    blocked(root, db, "C-1", ["f"]);
    db.close();
    const r = canon(root, "agent:a", "verdict", "pending");
    expect(r.code).toBe(0);
    expect(r.out).toContain(" C-1 ");
  });
});

describe("canon verdict record", () => {
  function setup() {
    const db = freshDb();
    db.event("human:alice", "claim.take", "C-182", {}); // 1
    db.event("agent:a", "review.block", "C-182", { docs: [], findings: ["one", "two", "three"] }); // 2
    db.event("agent:a", "land.refuse", "C-182", { reason: "review", message: "m", diff: "d" }); // 3
    return db;
  }
  const code = (r: ReturnType<typeof recordVerdict>) => (r.ok ? "ok" : r.error.code);

  test("BR-2254: a human records one verdict per finding, written as a self-reported human verdict with the block, finding and refusal", () => {
    const db = setup();
    expect(code(recordVerdict(db, "human:bob", "2", "2", "real", " BR-2244 really had a fragment "))).toBe("ok");
    expect(code(recordVerdict(db, "human:bob", "2", "3", "unclear", "r"))).toBe("ok");
    const [row] = verdictRows(db);
    expect([row!.subject, row!.detail]).toEqual(["C-182", { block: 2, refusal: null, finding: 2, verdict: "real", judge: "human", reason: "BR-2244 really had a fragment", before: null }]);
  });

  test("BR-2254: a model verdict does not block a human one; a second human verdict on the same finding is a conflict", () => {
    const db = setup();
    db.event("agent:j", "review.verdict", "C-182", { block: 2, finding: 1, verdict: "real", judge: "model", reason: "r" });
    expect(code(recordVerdict(db, "human:bob", "2", "1", "spurious", "r"))).toBe("ok");
    expect(code(recordVerdict(db, "human:carol", "2", "1", "real", "r"))).toBe("conflict");
    expect(verdictRows(db).length).toBe(2);
  });

  test("BR-2254: an agent, a missing block or finding and bad input write nothing, checked in order", () => {
    const db = setup();
    const codes = [
      recordVerdict(db, "agent:b", "2", "1", "real", "r"),
      recordVerdict(db, "human:bob", "2", "4", "real", "r"),
      recordVerdict(db, "human:bob", "3", "1", "real", "r"),
      recordVerdict(db, "human:bob", "999", "1", "real", "r"),
      recordVerdict(db, "human:bob", "2", "1", "wording", "r"),
      recordVerdict(db, "human:bob", "2", "0", "real", "r"),
      recordVerdict(db, "human:bob", "2", "x", "real", "r"),
      recordVerdict(db, "human:bob", "x", "1", "real", "r"),
      recordVerdict(db, "human:bob", "2", "1", "real", "  "),
      recordVerdict(db, "agent:b", "999", "1", "maybe", "r"),
      recordVerdict(db, "agent:b", "999", "1", "real", "r"),
    ].map(code);
    expect(codes).toEqual(["refused", "not_found", "not_found", "not_found", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "not_found"]);
    expect(verdictRows(db).length).toBe(0);
  });

  test("BR-2254: through the CLI the exit codes are 0, 5, 1, 3 and 2, and a landed block records its blocked commit", () => {
    const root = project();
    const db = dbOf(root);
    const { x, block } = blocked(root, db, "C-1", ["f"]);
    db.close();
    expect(canon(root, "human:bob", "verdict", "record", String(block), "1", "real", "--reason", "r").code).toBe(0);
    expect(canon(root, "human:carol", "verdict", "record", String(block), "1", "real", "--reason", "r").code).toBe(5);
    expect(canon(root, "agent:b", "verdict", "record", String(block), "1", "real", "--reason", "r").code).toBe(1);
    expect(canon(root, "human:carol", "verdict", "record", String(block + 1), "1", "real", "--reason", "r").code).toBe(3);
    expect(canon(root, "human:carol", "verdict", "record", String(block), "1", "real").code).toBe(2);
    const db2 = dbOf(root);
    expect(verdictRows(db2)[0]!.detail["before"]).toBe(x);
  });
});

/** A block that counts: it saw commit `c`, was refused for the review and landed afterwards. */
function landedBlock(db: CoordDb, change: string, findings: string[]) {
  db.event("agent:a", "review.block", change, { docs: [], findings, commit: "c" });
  db.event("agent:a", "land.refuse", change, { reason: "review", message: "m" });
  db.event("agent:a", "land.ok", change, { sha: "s" });
}

describe("canon stats review finding verdicts", () => {
  function judged(model: Record<string, number>, human: Record<string, number> = {}, blocks = 36, perBlock = 3) {
    const db = freshDb();
    for (let i = 0; i < blocks; i++) landedBlock(db, `C-${i + 1}`, Array.from({ length: perBlock }, (_, k) => `f${k}`));
    for (const [judge, counts] of [["model", model], ["human", human]] as const) {
      let n = 0; // each judge judges findings from the first block's first finding on
      for (const [verdict, k] of Object.entries(counts))
        for (let i = 0; i < k; i++, n++) db.event(`${judge === "model" ? "agent" : "human"}:j`, "review.verdict", "C-x", { block: 1 + 3 * Math.floor(n / perBlock), finding: 1 + (n % perBlock), verdict, judge, reason: "r" });
    }
    return db;
  }
  const CAVEAT = "  human verdicts are self-reported: canon cannot tell a person from an agent run outside Claude Code (BR-2023)";

  test("BR-2255: fewer than 10 real or spurious verdicts give counts and no share; model and human are never added; the caveat line ends the section", () => {
    const text = renderVerdictSummary(verdictSummary(judged({ real: 2, spurious: 1 }, {}, 36, 3)));
    expect(text).toBe(
      [
        "review finding verdicts:",
        "  model: 3 of 108 findings in 36 blocks judged, real 2, spurious 1, unclear 0; fewer than 10 real or spurious verdicts, no share",
        "  human: 0 of 108 findings in 36 blocks judged, real 0, spurious 0, unclear 0; fewer than 10 real or spurious verdicts, no share",
        CAVEAT,
      ].join("\n"),
    );
    const both = verdictSummary(judged({ real: 1 }, { spurious: 1 }, 1, 1));
    expect(both.map((j) => [j.judge, j.judged, j.real, j.spurious])).toEqual([["model", 1, 1, 0], ["human", 1, 0, 1]]);
  });

  test("BR-2255: 10 real or spurious verdicts give the spurious share; unclear does not count toward it; no block means no section", () => {
    expect(renderVerdictSummary(verdictSummary(judged({ real: 7, spurious: 3, unclear: 2 })))).toContain("  model: 12 of 108 findings in 36 blocks judged, real 7, spurious 3, unclear 2, spurious share 30.0%");
    expect(renderVerdictSummary(verdictSummary(judged({ real: 6, spurious: 3, unclear: 2 })))).toContain("unclear 2; fewer than 10 real or spurious verdicts, no share");
    expect(renderVerdictSummary(verdictSummary(freshDb()))).toBeUndefined();
  });

  test("BR-2255: the denominator counts only judgeable blocks: landed, with the commit the review saw", () => {
    const db = freshDb();
    landedBlock(db, "C-1", ["a", "b"]);
    db.event("agent:a", "review.block", "C-2", { docs: [], findings: ["never landed"], commit: "c" });
    db.event("agent:a", "land.refuse", "C-2", { reason: "review", message: "m" });
    db.event("agent:a", "review.block", "C-3", { docs: [], findings: ["old", "old2", "old3"] });
    db.event("agent:a", "land.refuse", "C-3", { reason: "review", message: "m" });
    db.event("agent:a", "land.ok", "C-3", { sha: "s" });
    const [model] = verdictSummary(db);
    expect([model!.blocks, model!.findings]).toEqual([1, 2]);
    expect(renderVerdictSummary(verdictSummary(db))).toContain("model: 0 of 2 findings in 1 blocks judged");
  });

  test("BR-2255: --since counts only the window's blocks, with their verdicts written after it", () => {
    const db = freshDb();
    landedBlock(db, "C-1", ["a"]); // 1..3
    landedBlock(db, "C-2", ["b", "c"]); // 4..6
    db.event("agent:b", "review.verdict", "C-1", { block: 1, finding: 1, verdict: "real", judge: "model", reason: "r" });
    db.event("agent:b", "review.verdict", "C-2", { block: 4, finding: 1, verdict: "spurious", judge: "model", reason: "r" });
    const [model] = verdictSummary(db, 1);
    expect([model!.blocks, model!.findings, model!.judged, model!.spurious]).toEqual([1, 2, 1, 1]);
  });

  test("BR-2255: canon stats prints the section after the check tables and before searches, and --json stays an array of checks", () => {
    const root = project();
    const db = dbOf(root);
    landedBlock(db, "C-1", ["a", "b"]);
    db.event("agent:a", "land.refuse", "C-1", { reason: "check", message: "m", diff: "d", findings: { "ref-dangling": 1 } });
    db.event("agent:a", "search", null, { query: "x", hits: 0 });
    db.close();
    const r = canon(root, "agent:b", "stats");
    expect(r.code).toBe(0);
    expect(r.out).toContain("\nreview finding verdicts:\n  model: 0 of 2 findings in 1 blocks judged");
    expect(r.out).toContain(CAVEAT);
    const at = r.out.indexOf("review finding verdicts:");
    expect(at).toBeGreaterThan(r.out.indexOf("check refusals by finding kind:"));
    expect(at).toBeLessThan(r.out.indexOf("searches:"));
    const j = JSON.parse(canon(root, "agent:b", "stats", "--json").out) as unknown[];
    expect(Array.isArray(j)).toBe(true);
  });
});
