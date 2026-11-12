import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { project } from "../testkit.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function withDb() {
  const root = project();
  const d = CoordDb.open(join(root, ".git/canon/state.db"));
  if (!d.ok) throw new Error(d.error.message);
  return { root, db: d.value };
}

describe("canon stats: how the rule reviews after landing were done", () => {
  test("BR-2397: full, incremental and reused reviews are counted apart, reused split by prompts and documents", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.ok", "C-1", { docs: ["BR-1"], findings: [], hash: "h1", docs_hash: "d1", base: "b" });
    db.event("agent:a", "review.block", "C-2", { docs: ["BR-2"], findings: ["x"], hash: "h2", docs_hash: "d2", base: "b" });
    db.event("agent:a", "review.ok", "C-1", { docs: ["BR-1"], findings: [], docs_hash: "d1", base: "c", incremental: { from: 1, added: ["BR-9"] } });
    db.event("agent:a", "review.reused", "C-3", { review: "land", docs: ["BR-3"], hash: "h3", from: 1 });
    db.event("agent:a", "review.reused", "C-4", { review: "land", by: "docs", docs: ["BR-4"], docs_hash: "d4", from: 1 });
    const r = canon(root, "stats");
    expect(r.code).toBe(0);
    expect(r.out).toContain("rule reviews after landing: 2 full, 1 incremental, 2 reused (1 same prompts, 1 same documents)");
    expect(canon(root, "stats", "--json").out).not.toContain("incremental");
  });

  test("BR-2397: a window with only duplicate reviews and previews has no line", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.ok", "C-1", { docs: ["CLAUDE.md"], findings: [] });
    db.event("agent:a", "review.reused", "C-1", { review: "preview", docs: ["BR-1"], hash: "h", from: 1 });
    expect(canon(root, "stats").out).not.toContain("rule reviews after landing");
  });
});

describe("canon stats: how the findings of the reviews after landing ended, per criterion", () => {
  /** Records one finding of `criterion` at a fresh review event and closes it `how` (null leaves it open); returns the event. */
  function finding(db: CoordDb, criterion: string, how: string | null, n: number): number {
    const event = db.event("agent:a", "review.block", "C-1", { findings: [] });
    db.db
      .query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, sha, opened_at, closed_at, closed_how) VALUES (?, ?, '[]', '[\"BR-1\"]', 't', 'C-1', ?, NULL, 'x', ?, ?)")
      .run(`${criterion} ${n}`, criterion, event, how === null ? null : "y", how);
    return event;
  }

  test("BR-2451: open, fixed, spurious and retired findings are counted per criterion, in the prompts' order, with no share below 10; other closes are named", () => {
    const { root, db } = withDb();
    finding(db, "restatement", null, 1);
    finding(db, "contradiction", "fixed", 2);
    finding(db, "contradiction", "spurious", 3);
    finding(db, "contradiction", "spurious", 4);
    finding(db, "contradiction", "no-longer-holds", 5);
    const r = canon(root, "stats");
    expect(r.code).toBe(0);
    const at = (s: string) => r.out.indexOf(s);
    expect(r.out).toContain("review findings after landing by criterion:");
    expect(r.out).toContain("  contradiction: 0 open, 1 fixed, 2 spurious, 0 retired, 1 closed otherwise; fewer than 10 fixed or spurious, no share");
    expect(r.out).toContain("  restatement: 1 open, 0 fixed, 0 spurious, 0 retired; fewer than 10 fixed or spurious, no share");
    expect(at("  contradiction:")).toBeLessThan(at("  restatement:"));
    expect(canon(root, "stats", "--json").out).not.toContain("by criterion");
  });

  test("BR-2451: 10 or more fixed or spurious findings of a criterion give the spurious share", () => {
    const { root, db } = withDb();
    for (let i = 0; i < 4; i++) finding(db, "contradiction", "fixed", i);
    for (let i = 4; i < 12; i++) finding(db, "contradiction", "spurious", i);
    expect(canon(root, "stats").out).toContain("  contradiction: 0 open, 4 fixed, 8 spurious, 0 retired, spurious share 66.7%");
  });

  test("BR-2451: reviews with only notes, or a window without recorded findings, have no section", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.ok", "C-1", { docs: ["BR-1"], findings: [], notes: ["a note"], landed: 1 });
    expect(canon(root, "stats").out).not.toContain("by criterion");
    const last = finding(db, "untestable", "retired", 1);
    expect(canon(root, "stats").out).toContain("  untestable: 0 open, 0 fixed, 0 spurious, 1 retired");
    expect(canon(root, "stats", "--since", String(last)).out).not.toContain("by criterion");
  });
});
