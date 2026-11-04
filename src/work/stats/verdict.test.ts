import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoordDb } from "../db.ts";
import { ownDiffId } from "../land/worktree-state.ts";
import { project, sh } from "../testkit.ts";
import { pendingBlocks, pendingJson, recordVerdict, renderPending, renderRun, renderVerdictSummary, runVerdicts, verdictSummary } from "./verdict.ts";

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");

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
 * Change `change` blocked by the review at commit `x` (fingerprint taken the way a landing takes it), then
 * fixed in `y` (which adds `fix-<change>.md`) and landed on top of `base`. Events: claim, review.block, land.refuse, land.ok.
 */
function blockLand(root: string, db: CoordDb, change: string, findings: string[], opts: { withBase?: boolean; actor?: string } = {}) {
  const actor = opts.actor ?? "agent:a";
  const base = sh(root, "rev-parse", "HEAD").trim();
  sh(root, "checkout", "-qb", `change/${change}`);
  commit(root, `canon/changes/${change}.md`, "opened\n");
  const x = commit(root, `blocked-${change}.txt`, "one\nTWO\nthree\n");
  const diff = ownDiffId(root, "main")!;
  const y = commit(root, `fix-${change}.md`, "reworded\n");
  sh(root, "checkout", "-q", "main");
  sh(root, "merge", "-q", "--ff-only", `change/${change}`);
  db.event(actor, "claim.take", change, {});
  db.event(actor, "review.block", change, { docs: ["BR-1"], findings });
  db.event(actor, "land.refuse", change, { reason: "review", message: "rule review blocked", diff });
  db.event(actor, "land.ok", change, { sha: y, diff: "d1", ...(opts.withBase === false ? {} : { base }) });
  return { x, y, base };
}

/** blockLand, plus the id of the review.block it wrote. */
function blocked(root: string, db: CoordDb, change: string, findings: string[], opts: { withBase?: boolean; actor?: string } = {}) {
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
    const blocks = pendingBlocks(db, root);
    expect(blocks.map((b) => [b.block, b.subject, b.before, b.findings.length])).toEqual([[block, "C-1", x, 2]]);
    const text = renderPending(blocks);
    const date = blocks[0]!.ts.slice(0, 10);
    expect(text).toBe(`#${block} C-1 ${date}  blocked commit ${x}\n  1. model - · human - · BR-1 contradicts BR-2\n  2. model - · human - · BR-3 has no boundary`);
    expect(text).not.toContain(y);
    expect(JSON.stringify(pendingJson(blocks))).not.toContain(y);
    expect(Object.keys(pendingJson(blocks)[0]!)).toEqual(["block", "refusal", "subject", "ts", "before", "findings"]);
    expect(pendingJson(blocks)[0]!.findings[0]).toEqual({ n: 1, text: "BR-1 contradicts BR-2", model: null, human: null });
  });

  test("BR-2253: a landing that recorded no base uses the previous landing's commit as where main stood", () => {
    const root = project();
    const db = dbOf(root);
    db.event("agent:a", "land.ok", "C-0", { sha: sh(root, "rev-parse", "HEAD").trim(), diff: "d0" });
    const { x } = blocked(root, db, "C-4", ["f"], { withBase: false });
    expect(pendingBlocks(db, root)[0]?.before).toBe(x);
  });

  test("BR-2253: existing verdicts show per finding; fully judged, unlanded and finding-less refusals are not listed; the author still sees it; no fingerprint gives ?", () => {
    const root = project();
    const db = dbOf(root);
    const { block } = blocked(root, db, "C-1", ["first", "second"]);
    db.event("agent:j", "review.verdict", "C-1", { block, finding: 1, verdict: "real", judge: "model", reason: "r" });
    db.event("human:h", "review.verdict", "C-1", { block, finding: 2, verdict: "spurious", judge: "human", reason: "r" });
    expect(renderPending(pendingBlocks(db, root))).toContain("  1. model real · human - · first\n  2. model - · human spurious · second");
    db.event("agent:z", "review.block", "C-2", { docs: [], findings: ["never landed"] });
    db.event("agent:z", "land.refuse", "C-2", { reason: "review", message: "m", diff: "d" });
    db.event("agent:z", "land.refuse", "C-3", { reason: "review", message: "the rule review could not run", diff: "d" });
    db.event("agent:z", "land.ok", "C-3", { sha: "s3", diff: "e" });
    expect(pendingBlocks(db, root).map((b) => b.subject)).toEqual(["C-1"]);
    db.event("human:h", "review.verdict", "C-1", { block, finding: 1, verdict: "real", judge: "human", reason: "r" });
    db.event("agent:j", "review.verdict", "C-1", { block, finding: 2, verdict: "real", judge: "model", reason: "r" });
    expect(pendingBlocks(db, root)).toEqual([]);
    const old = freshDb();
    old.event("agent:z", "review.block", "C-9", { docs: [], findings: ["f"] });
    old.event("agent:z", "land.refuse", "C-9", { reason: "review", message: "m" });
    old.event("agent:z", "land.ok", "C-9", { sha: "s9" });
    expect(renderPending(pendingBlocks(old, root))).toContain("blocked commit ?");
    expect(renderPending([])).toBe("(nothing to judge)");
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
    expect(code(recordVerdict(db, "/nonexistent", "human:bob", "2", "2", "real", " BR-2244 really had a fragment "))).toBe("ok");
    expect(code(recordVerdict(db, "/nonexistent", "human:bob", "2", "3", "unclear", "r"))).toBe("ok");
    const [row] = verdictRows(db);
    expect([row!.subject, row!.detail]).toEqual(["C-182", { block: 2, refusal: null, finding: 2, verdict: "real", judge: "human", reason: "BR-2244 really had a fragment", before: null }]);
  });

  test("BR-2254: a model verdict does not block a human one; a second human verdict on the same finding is a conflict", () => {
    const db = setup();
    db.event("agent:j", "review.verdict", "C-182", { block: 2, finding: 1, verdict: "real", judge: "model", reason: "r" });
    expect(code(recordVerdict(db, "/nonexistent", "human:bob", "2", "1", "spurious", "r"))).toBe("ok");
    expect(code(recordVerdict(db, "/nonexistent", "human:carol", "2", "1", "real", "r"))).toBe("conflict");
    expect(verdictRows(db).length).toBe(2);
  });

  test("BR-2254: an agent, a missing block or finding and bad input write nothing, checked in order", () => {
    const db = setup();
    const codes = [
      recordVerdict(db, "/nonexistent", "agent:b", "2", "1", "real", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "2", "4", "real", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "3", "1", "real", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "999", "1", "real", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "2", "1", "wording", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "2", "0", "real", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "2", "x", "real", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "x", "1", "real", "r"),
      recordVerdict(db, "/nonexistent", "human:bob", "2", "1", "real", "  "),
      recordVerdict(db, "/nonexistent", "agent:b", "999", "1", "maybe", "r"),
      recordVerdict(db, "/nonexistent", "agent:b", "999", "1", "real", "r"),
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

describe("canon verdict run", () => {
  /** A judge script in the current worktree that records where it ran and what it got, and answers `answer`. */
  function judge(root: string, answer: string, exit = 0) {
    const log = mkdtempSync(join(tmpdir(), "canon-judge-log-"));
    const script = join(root, "scripts", "judge.sh");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(
      script,
      `#!/bin/sh\nn=$(ls ${log} | wc -l | tr -d ' ')\npwd > ${log}/$n.pwd\nls -a > ${log}/$n.ls\ncat > ${log}/$n.prompt\nprintf '%s' '${answer}'\nexit ${exit}\n`,
    );
    chmodSync(script, 0o755);
    const read = (n: number, what: string) => readFileSync(join(log, `${n}.${what}`), "utf8");
    return { log, read };
  }
  const answer = (...vs: string[]) => JSON.stringify({ verdicts: vs.map((v, i) => ({ finding: i + 1, verdict: v, reason: `because ${i + 1}` })) });

  test("BR-2290: the judge runs on the blocked commit's tree without .git or the fix, sees only the findings, and each finding gets a model verdict", async () => {
    const root = project();
    const db = dbOf(root);
    const { x, y, block } = blocked(root, db, "C-1", ["BR-1 contradicts BR-2", "BR-3 has no boundary"]);
    blocked(root, db, "C-2", ["other"]);
    const j = judge(root, answer("real", "spurious"));
    const r = await runVerdicts(db, root, "agent:runner", "scripts/judge.sh", 1, false);
    expect(r.failure).toBeUndefined();
    const files = j.read(0, "ls").split("\n");
    expect(files).toContain("blocked-C-1.txt");
    expect(files).not.toContain(".git");
    expect(files).not.toContain("fix-C-1.md");
    const prompt = j.read(0, "prompt");
    expect(prompt).toContain("1. BR-1 contradicts BR-2\n2. BR-3 has no boundary");
    expect(prompt).toContain("- blocked-C-1.txt");
    expect(prompt).not.toContain(y);
    expect(existsSync(j.read(0, "pwd").trim())).toBe(false);
    expect(verdictRows(db).map((v) => [v.actor, v.subject, v.detail])).toEqual([
      ["agent:runner", "C-1", { block, refusal: block + 1, finding: 1, verdict: "real", judge: "model", reason: "because 1", before: x, command: "scripts/judge.sh" }],
      ["agent:runner", "C-1", { block, refusal: block + 1, finding: 2, verdict: "spurious", judge: "model", reason: "because 2", before: x, command: "scripts/judge.sh" }],
    ]);
    expect(renderRun(r)).toBe(`#${block} C-1: real 1, spurious 1, unclear 0 (prompt ${prompt.length} characters)\njudged 1 block(s), 2 finding(s); 0 block(s) without a blocked commit skipped; prompts ${prompt.length} characters`);
  });

  test("BR-2290: a finding already judged by a model is skipped, a block without a blocked commit is counted, and a dry run writes nothing", async () => {
    const root = project();
    const db = dbOf(root);
    const { block } = blocked(root, db, "C-1", ["a", "b"]);
    db.event("agent:j", "review.verdict", "C-1", { block, finding: 1, verdict: "real", judge: "model", reason: "r" });
    db.event("agent:z", "review.block", "C-9", { docs: [], findings: ["f"] });
    db.event("agent:z", "land.refuse", "C-9", { reason: "review", message: "m" });
    db.event("agent:z", "land.ok", "C-9", { sha: "s9" });
    judge(root, answer("unclear", "unclear"));
    const dry = await runVerdicts(db, root, "agent:runner", "scripts/judge.sh", 5, true);
    expect(renderRun(dry)).toMatch(/^#\d+ C-1: 2 finding\(s\), prompt \d+ characters\nwould judge 1 block\(s\), 2 finding\(s\); 1 block\(s\) without a blocked commit skipped; prompts \d+ characters$/);
    expect(verdictRows(db).length).toBe(1);
    const r = await runVerdicts(db, root, "agent:runner", "scripts/judge.sh", 5, false);
    expect(renderRun(r)).toContain("C-1: real 0, spurious 0, unclear 1");
    expect(verdictRows(db).map((v) => v.detail["finding"])).toEqual([1, 2]);
    expect(renderRun(await runVerdicts(db, root, "agent:runner", "scripts/judge.sh", 5, false))).toStartWith("judged 0 block(s), 0 finding(s); 1 block(s)");
  });

  test("BR-2290: an answer missing a finding, or a failing judge, writes nothing for that block and stops before the next", async () => {
    const root = project();
    const db = dbOf(root);
    blocked(root, db, "C-1", ["a", "b"]);
    blocked(root, db, "C-2", ["c"]);
    const j = judge(root, answer("real"));
    const r = await runVerdicts(db, root, "agent:runner", "scripts/judge.sh", 5, false);
    expect(r.failure).toContain("answered 1 of 2 findings");
    expect(verdictRows(db).length).toBe(0);
    expect(existsSync(join(j.log, "1.prompt"))).toBe(false);
    judge(root, answer("real", "real"), 1);
    expect((await runVerdicts(db, root, "agent:runner", "scripts/judge.sh", 5, false)).failure).toContain("exited 1");
    expect(verdictRows(db).length).toBe(0);
  });

  test("BR-2290: through the CLI a bad --limit is 2, no review command is 4, a failing judge is 4", () => {
    const root = project();
    const db = dbOf(root);
    blocked(root, db, "C-1", ["a"]);
    db.close();
    expect(canon(root, "agent:r", "verdict", "run").code).toBe(2);
    expect(canon(root, "agent:r", "verdict", "run", "--limit", "0").code).toBe(2);
    expect(canon(root, "agent:r", "verdict", "run", "--limit", "x").code).toBe(2);
    expect(canon(root, "agent:r", "verdict", "run", "--limit", "1").code).toBe(4);
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nreview: scripts/judge.sh\n");
    judge(root, "no json here");
    const r = canon(root, "agent:r", "verdict", "run", "--limit", "1");
    expect(r.code).toBe(4);
    expect(r.err).toContain("printed no JSON");
    judge(root, answer("real"));
    expect(canon(root, "agent:r", "verdict", "run", "--limit", "1").code).toBe(0);
  });
});

describe("canon stats review finding verdicts", () => {
  function judged(model: Record<string, number>, human: Record<string, number> = {}, blocks = 36, perBlock = 3) {
    const db = freshDb();
    for (let i = 0; i < blocks; i++) db.event("agent:a", "review.block", `C-${i + 1}`, { docs: [], findings: Array.from({ length: perBlock }, (_, k) => `f${k}`) });
    for (const [judge, counts] of [["model", model], ["human", human]] as const) {
      let n = 0; // each judge judges findings from the first block's first finding on
      for (const [verdict, k] of Object.entries(counts))
        for (let i = 0; i < k; i++, n++) db.event(`${judge === "model" ? "agent" : "human"}:j`, "review.verdict", "C-x", { block: 1 + Math.floor(n / perBlock), finding: 1 + (n % perBlock), verdict, judge, reason: "r" });
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

  test("BR-2255: --since counts only the window's blocks, with their verdicts written after it", () => {
    const db = freshDb();
    db.event("agent:a", "review.block", "C-1", { docs: [], findings: ["a"] }); // 1
    db.event("agent:a", "review.block", "C-2", { docs: [], findings: ["b", "c"] }); // 2
    db.event("agent:b", "review.verdict", "C-1", { block: 1, finding: 1, verdict: "real", judge: "model", reason: "r" });
    db.event("agent:b", "review.verdict", "C-2", { block: 2, finding: 1, verdict: "spurious", judge: "model", reason: "r" });
    const [model] = verdictSummary(db, 1);
    expect([model!.blocks, model!.findings, model!.judged, model!.spurious]).toEqual([1, 2, 1, 1]);
  });

  test("BR-2255: canon stats prints the section after the check tables and before searches, and --json stays an array of checks", () => {
    const root = project();
    const db = dbOf(root);
    db.event("agent:a", "review.block", "C-1", { docs: [], findings: ["a", "b"] });
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
