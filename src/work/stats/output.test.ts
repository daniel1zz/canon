import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { project, sh } from "../testkit.ts";
import { computeStats, renderStats, sharedShare } from "./stats.ts";
import { renderWindow, windowSummary } from "./window.ts";

// reason: the CLI cases spawn canon, which spawns git; under load a spawn can take seconds (C-111)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const ZERO = { changed: 0, same: 0, abandoned: 0, pending: 0, unknown: 0 };

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-stats-out-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Opens the coordination database of a project made by `project()`, to write events a test needs. */
function projectDb(root: string): CoordDb {
  const r = CoordDb.open(join(root, ".git/canon/state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const of = (stats: ReturnType<typeof computeStats>, check: string) => stats.find((s) => s.check === check)!;

describe("canon stats --json", () => {
  test("BR-2202: one item per check in CHECKS order with exactly the documented fields; no events gives zeros", () => {
    const root = project();
    const r = canon(root, "stats", "--json");
    expect(r.code).toBe(0);
    const items = JSON.parse(r.out) as Record<string, unknown>[];
    expect(items[0]).toEqual({ check: "on-main", runs: 0, refused: 0, outcomes: ZERO, review: null, due: false, kinds: null });
    expect(items.at(-1)!["check"]).toBe("setup");
    for (const i of items) expect(Object.keys(i).sort()).toEqual(["check", "due", "kinds", "outcomes", "refused", "review", "runs"]);
  });

  test("BR-2202: a dated check carries its review date and whether it is due; an undated one has null and false", () => {
    const s = computeStats(db(), { floor: "2026-01-01" }, "2026-11-03");
    expect([of(s, "floor").review, of(s, "floor").due]).toEqual(["2026-01-01", true]);
    expect([of(s, "check").review, of(s, "check").due]).toEqual([null, false]);
  });

  test("BR-2121 BR-2135: --json is the same array with shared code and searches present; neither adds a key", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\ncode_root: src\nshared: [src/kernel]\n");
    mkdirSync(join(root, "src/kernel"), { recursive: true });
    writeFileSync(join(root, "src/kernel/a.ts"), "a\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "code");
    const before = JSON.parse(canon(root, "stats", "--json").out) as unknown[];
    const d = projectDb(root);
    d.event("agent:test", "search", null, { query: "q", results: 0, full: 0 });
    d.close();
    const r = canon(root, "stats", "--json");
    expect(r.out).not.toContain("shared code");
    expect(r.out).not.toContain("searches");
    expect(JSON.parse(r.out)).toEqual(before);
  });
});

describe("outcomes of non-landing checks", () => {
  test("BR-2203: claim and setup have no outcomes: dashes in the table, null in JSON; a landing check with no refusal has zeros", () => {
    const d = db();
    d.event("a", "claim.refuse", "C-1", { reason: "held" });
    const s = computeStats(d, {}, "2026-11-03");
    expect([of(s, "claim").outcomes, of(s, "setup").outcomes]).toEqual([null, null]);
    expect(of(s, "floor").outcomes).toEqual(ZERO);
    const text = renderStats(s);
    expect(text).toMatch(/\nclaim +1 +1 +- +- +- +- +-  \(no date\)/);
    expect(text).toMatch(/\nfloor +0 +0 +0 +0 +0 +0 +0  \(no date\)/);
  });

  test("BR-2067: the check column is as wide as the longest check name, so every row lines up", () => {
    const rows = renderStats(computeStats(db(), {}, "2026-11-03")).split("\n").slice(0, 18);
    const reviewAt = rows[0]!.indexOf("review");
    for (const r of rows.slice(1)) expect(r.indexOf("(no date)")).toBe(reviewAt);
  });
});

describe("landing checks", () => {
  test("BR-2067: one dirty refusal, one on-main refusal and two landings: both checks ran 4 times, each refused once", () => {
    const d = db();
    d.event("a", "land.refuse", "C-1", { reason: "dirty" });
    d.event("a", "land.refuse", "C-2", { reason: "on-main" });
    d.event("a", "land.ok", "C-3", {});
    d.event("a", "land.ok", "C-4", {});
    const s = computeStats(d, {}, "2026-11-03");
    expect([of(s, "dirty").runs, of(s, "dirty").refused, of(s, "on-main").runs, of(s, "on-main").refused]).toEqual([4, 1, 4, 1]);
  });

  test("BR-2154: an outcome only looks at events inside the counted range", () => {
    const d = db();
    d.event("a", "land.refuse", "C-1", { reason: "floor", diff: "x" }); // #1
    d.event("a", "land.ok", "C-1", { diff: "y" }); // #2
    expect(of(computeStats(d, {}, "2026-11-03", 0, 1), "floor").outcomes).toEqual({ ...ZERO, pending: 1 });
    expect(of(computeStats(d, {}, "2026-11-03", 0, 2), "floor").outcomes).toEqual({ ...ZERO, changed: 1 });
  });

  test("BR-2154: stats --since that is not an event id exits 2 with the message and prints no statistics", () => {
    const root = project();
    for (const bad of ["x", "1.5"]) {
      const r = canon(root, "stats", "--since", bad);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--since must be an event id");
      expect(r.out).not.toContain("runs");
    }
  });

  test("BR-2069: a check_reviews entry naming no check makes canon stats exit 2", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\ncheck_reviews:\n  flor: "2027-01-01"\n');
    const r = canon(root, "stats");
    expect(r.code).toBe(2);
    expect(r.err).toContain("no such check");
  });
});

describe("window refusals by reason", () => {
  test("BR-2204: a refusal without a reason is unrecorded; equal counts go by reason name, more first", () => {
    const d = db();
    for (const reason of ["floor", "conflict", "check"]) d.event("a", "land.refuse", "C-1", { reason });
    expect(Object.entries(windowSummary(d, 0).landings.refused)).toEqual([["check", 1], ["conflict", 1], ["floor", 1]]);
    d.event("a", "land.refuse", "C-2", { reason: "floor" });
    d.event("a", "land.refuse", "C-3", {});
    const w = windowSummary(d, 0);
    expect(Object.entries(w.landings.refused)).toEqual([["floor", 2], ["check", 1], ["conflict", 1], ["unrecorded", 1]]);
    expect(renderWindow(w)).toContain("5 refused (floor 2, check 1, conflict 1, unrecorded 1)");
  });
});

describe("shared code files", () => {
  function codeRepo(): string {
    const root = project();
    mkdirSync(join(root, "src/kernel"), { recursive: true });
    writeFileSync(join(root, "src/kernel/a.ts"), "a\n");
    writeFileSync(join(root, "src/b.ts"), "b\nb\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "code");
    return root;
  }
  const layout = { codeRoot: "src", shared: ["src/kernel"] };

  test("BR-2205: tracked symlinks to a directory or a file are not counted, and canon stats does not fail on them", () => {
    const root = codeRepo();
    symlinkSync("kernel", join(root, "src/link"));
    symlinkSync("../b.ts", join(root, "src/kernel/b.ts"));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "links");
    expect(sharedShare(root, layout)).toEqual({ codeRoot: "src", sharedLines: 1, totalLines: 3 });
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\ncode_root: src\nshared: [src/kernel]\n");
    const r = canon(root, "stats");
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(r.out).toContain("shared code: 1 of 3 lines under src (33.3%)");
  });

  test("BR-2205: lines come from the working tree: an uncommitted edit counts as edited, a deleted tracked file not at all", () => {
    const root = codeRepo();
    writeFileSync(join(root, "src/kernel/a.ts"), "a\na\na\n");
    expect(sharedShare(root, layout)).toEqual({ codeRoot: "src", sharedLines: 3, totalLines: 5 });
    rmSync(join(root, "src/kernel/a.ts"));
    expect(sharedShare(root, layout)).toEqual({ codeRoot: "src", sharedLines: 0, totalLines: 2 });
  });
});

describe("canon events", () => {
  test("BR-2156: an event with no worktree and no subject shows dashes in the text and nulls in JSON", () => {
    const root = project();
    const d = projectDb(root); // opened without a worktree, like an event written before BR-2131
    d.event("agent:test", "search", null, { query: "q", results: 0, full: 0 });
    d.close();
    const r = canon(root, "events");
    expect(r.out.trim()).toMatch(/^#1 \S+ agent:test - search - \{"query":"q","results":0,"full":0\}$/);
    const [e] = JSON.parse(canon(root, "events", "--json").out) as { worktree: unknown; subject: unknown }[];
    expect([e!.worktree, e!.subject]).toEqual([null, null]);
  });
});
