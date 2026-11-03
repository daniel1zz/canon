import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../coord/db.ts";
import { readConfig } from "../repo/config.ts";
import { drop } from "../work/drop.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../work/testkit.ts";
import { findingDetail, land } from "../work/work.ts";
import { computeStats, renderStats } from "./stats.ts";

const of = (stats: ReturnType<typeof computeStats>, check: string) => stats.find((s) => s.check === check)!;

function commit(wt: string, file: string, text: string) {
  writeFileSync(join(wt, file), text);
  sh(wt, "add", file);
  sh(wt, "commit", "-qm", file);
}

describe("canon stats", () => {
  test("BR-2067: runs count the landings that reached each check; an empty table is all zeros", () => {
    const empty = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-stats-")), "state.db"));
    if (!empty.ok) throw new Error(empty.error.message);
    expect(computeStats(empty.value, {}, "2026-11-03").every((s) => s.runs === 0 && s.refused === 0)).toBe(true);

    const d = empty.value;
    for (let i = 0; i < 3; i++) d.event("agent:a", "land.ok", `C-${i + 1}`, {});
    d.event("agent:a", "land.refuse", "C-4", { reason: "floor" });
    d.event("agent:a", "land.refuse", "C-5", { reason: "check" });
    const s = computeStats(d, {}, "2026-11-03");
    expect([of(s, "floor").runs, of(s, "floor").refused]).toEqual([5, 1]);
    expect([of(s, "check").runs, of(s, "check").refused]).toEqual([4, 1]);
    expect(of(s, "review").runs).toBe(3);
    d.event("agent:a", "land.refuse", "C-6", { reason: "dirty" });
    d.event("agent:a", "land.refuse", "C-7", { reason: "on-main" });
    const early = computeStats(d, {}, "2026-11-03");
    expect([of(early, "dirty").runs, of(early, "on-main").runs, of(early, "dirty").refused]).toEqual([7, 7, 1]); // one stage, same runs
  });

  test("BR-2067: claim counts takes, renewals and refusals; setup counts starts that ran it and its failures", () => {
    const opened = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-stats-")), "state.db"));
    if (!opened.ok) throw new Error(opened.error.message);
    const d = opened.value;
    d.event("a", "claim.take", "C-1", {});
    d.event("a", "claim.take", "C-2", {});
    d.event("b", "claim.refuse", "C-1", { reason: "held" });
    d.event("a", "start.ok", "C-1", { created: true, setup: true });
    d.event("a", "start.ok", "C-2", { created: true, setup: true });
    d.event("a", "start.ok", "C-3", { created: false, setup: false });
    d.event("a", "start.refuse", "C-4", { reason: "setup" });
    const s = computeStats(d, {}, "2026-11-03");
    expect([of(s, "claim").runs, of(s, "claim").refused]).toEqual([3, 1]);
    expect([of(s, "setup").runs, of(s, "setup").refused]).toEqual([3, 1]);
  });

  test("BR-2068: refused twice and not yet landed is pending twice; a drop that only asked is still pending; no change id is unknown", () => {
    const opened = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-stats-")), "state.db"));
    if (!opened.ok) throw new Error(opened.error.message);
    const d = opened.value;
    d.event("a", "land.refuse", "C-4", { reason: "floor", diff: "x" });
    d.event("a", "land.refuse", "C-4", { reason: "floor", diff: "y" });
    d.event("a", "land.refuse", "C-5", { reason: "floor", diff: "z" });
    d.event("a", "drop.escalate", "C-5", { question: 1 });
    d.event("a", "land.refuse", null, { reason: "floor", diff: "w" });
    expect(of(computeStats(d, {}, "2026-11-03"), "floor").outcomes).toEqual({ changed: 0, same: 0, abandoned: 0, pending: 3, unknown: 1 });
  });

  test("BR-2068: a refusal is changed when the change later lands with other code, same when it lands unchanged", async () => {
    const root = project();
    const fixed = startNew(root, "Fixed");
    commit(fixed.worktree, "FAIL", "x");
    expect((await land(ws(fixed.worktree), FAST, quiet)).kind).toBe("refused");
    sh(fixed.worktree, "rm", "-q", "FAIL");
    sh(fixed.worktree, "commit", "-qm", "fix");
    commit(fixed.worktree, "real.txt", "real\n");
    expect((await land(ws(fixed.worktree), FAST, quiet)).kind).toBe("landed");

    const same = startNew(root, "Same");
    commit(same.worktree, "same.txt", "s\n");
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nhooks:\n  before_land: test -e canon/changes/approved\n");
    sh(root, "commit", "-qam", "a gate that only change files satisfy");
    sh(same.worktree, "rebase", "-q", "main");
    expect((await land(ws(same.worktree), FAST, quiet)).kind).toBe("refused");
    commit(same.worktree, "canon/changes/approved", "ok\n");
    expect((await land(ws(same.worktree), FAST, quiet)).kind).toBe("landed");

    const s = computeStats(ws(root).db, {}, "2026-11-03");
    expect(of(s, "floor").outcomes).toMatchObject({ changed: 1, same: 0 });
    expect(of(s, "hook").outcomes).toMatchObject({ changed: 0, same: 1 });
  });

  test("BR-2068: a refusal followed by a drop is abandoned; one with nothing after it is pending", async () => {
    const root = project();
    const gone = startNew(root, "Gone");
    commit(gone.worktree, "FAIL", "x");
    await land(ws(gone.worktree), FAST, quiet);
    const waiting = startNew(root, "Waiting");
    commit(waiting.worktree, "FAIL", "y");
    await land(ws(waiting.worktree), FAST, quiet);
    const asked = drop(ws(root), gone.change, quiet);
    if (!asked.ok || asked.value.kind !== "asked") throw new Error("expected a question");
    ws(root).db.db.query("UPDATE questions SET answer = 'yes', answered_by = 'human:dz' WHERE id = ?").run(asked.value.question);
    expect(drop(ws(root), gone.change, quiet).ok).toBe(true);
    expect(of(computeStats(ws(root).db, {}, "2026-11-03"), "floor").outcomes).toMatchObject({ abandoned: 1, pending: 1 });
  });

  test("BR-2094: a check refusal records how many findings of each kind and the files involved; other refusals record neither", async () => {
    const root = project();
    const bad = startNew(root, "Bad");
    const change = (id: string, why: string) => `---\nid: ${id}\ntitle: Bad\n---\n## 为什么\n\n${why}\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [ ] <任务>\n`;
    writeFileSync(join(bad.worktree, "canon/changes/C-1-bad.md"), change("C-1", "See D-98 and D-99."));
    writeFileSync(join(bad.worktree, "canon/changes/C-2-other.md"), change("C-2", "See D-97."));
    sh(bad.worktree, "add", "-A");
    sh(bad.worktree, "commit", "-qm", "dangling");
    expect((await land(ws(bad.worktree), FAST, quiet)).kind).toBe("refused");
    const floor = startNew(root, "Floor");
    commit(floor.worktree, "FAIL", "x");
    expect((await land(ws(floor.worktree), FAST, quiet)).kind).toBe("refused");

    const details = ws(root)
      .db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse' ORDER BY id")
      .all()
      .map((r) => JSON.parse(r.detail) as Record<string, unknown>);
    expect(details[0]).toMatchObject({
      reason: "check",
      findings: { "ref-dangling": 3, "template-unfilled": 2 },
      paths: ["canon/changes/C-1-bad.md", "canon/changes/C-2-other.md"],
    });
    expect(details[1]!["reason"]).toBe("floor");
    expect(details[1]).not.toHaveProperty("findings");
    expect(details[1]).not.toHaveProperty("paths");

    const many = Array.from({ length: 51 }, (_, i) => ({ path: `f${String(50 - i).padStart(2, "0")}`, rule: "ref-dangling" as const, message: "" }));
    const kept = findingDetail(many).paths;
    expect([kept.length, kept[0], kept[49], kept.includes("f50")]).toEqual([50, "f00", "f49", false]);
  });

  test("BR-2095: check refusals are broken down per finding kind with what happened after; old refusals are unrecorded", () => {
    const opened = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-stats-")), "state.db"));
    if (!opened.ok) throw new Error(opened.error.message);
    const d = opened.value;
    expect(of(computeStats(d, {}, "2026-11-03"), "check").kinds).toEqual([]);
    expect(renderStats(computeStats(d, {}, "2026-11-03"))).not.toContain("by finding kind");
    d.event("a", "land.refuse", "C-1", { reason: "check", diff: "a", findings: { "ref-dangling": 2, "template-unfilled": 1 } });
    d.event("a", "land.ok", "C-1", { diff: "b" });
    d.event("a", "land.refuse", "C-2", { reason: "check", diff: "c", findings: { "ref-dangling": 1 } });
    d.event("a", "land.refuse", "C-3", { reason: "check", diff: "d" });
    d.event("a", "land.refuse", "C-4", { reason: "floor", diff: "e" });
    const s = computeStats(d, {}, "2026-11-03");
    const zero = { changed: 0, same: 0, abandoned: 0, pending: 0, unknown: 0 };
    expect(of(s, "check").kinds).toEqual([
      { kind: "ref-dangling", refused: 2, findings: 3, outcomes: { ...zero, changed: 1, pending: 1 } },
      { kind: "template-unfilled", refused: 1, findings: 1, outcomes: { ...zero, changed: 1 } },
      { kind: "unrecorded", refused: 1, findings: 0, outcomes: { ...zero, pending: 1 } },
    ]);
    expect(of(s, "floor").kinds).toBeNull();
    const text = renderStats(s);
    expect(text).toContain("check refusals by finding kind:");
    expect(text).toMatch(/ref-dangling +2 +3 +1 +0 +0 +1 +0/);
  });

  test("BR-2069: checks whose review date has come are listed as due, undated ones are named, and an unknown check is a config error", () => {
    const root = project();
    const s = computeStats(ws(root).db, { floor: "2026-01-01", check: "2027-02-03", review: "2026-11-03" }, "2026-11-03");
    expect([of(s, "floor").due, of(s, "check").due, of(s, "review").due]).toEqual([true, false, true]); // the day itself is due
    const text = renderStats(s);
    expect(text).toContain("Due for review:\n  floor (since 2026-01-01)");
    expect(text).not.toContain("  check (since");
    expect(text).toMatch(/No review date .*setup/);
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ncheck_reviews:\n  flor: "2027-01-01"\n');
    const bad = readConfig(root);
    expect(!bad.ok && bad.error.message).toContain("no such check");
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ncheck_reviews:\n  floor: "soon"\n');
    expect(readConfig(root).ok).toBe(false);
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ncheck_reviews:\n  floor: "2026-02-30"\n');
    expect(readConfig(root).ok).toBe(false); // well formed, but there is no 30 February
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ncheck_reviews:\n  floor: "2028-02-29"\n');
    expect(readConfig(root).ok).toBe(true);
  });
});
