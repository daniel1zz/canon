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

describe("canon stats: the verifier's answers per criterion", () => {
  const v = (criterion: string, holds: boolean | null) => ({ finding: `[${criterion}] ${criterion} finding`, holds, reason: "r" });

  test("BR-2451: verified, rejected and not verified findings of the reviews after landing are counted per criterion, in the prompts' order, with no share below 10", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.block", "C-1", { docs: ["BR-1"], findings: [], landed: 1, verified: [v("restatement", null), v("contradiction", true), v("contradiction", false)] });
    db.event("agent:a", "review.ok", "C-2", { docs: ["BR-2"], findings: [], landed: 2, verified: [v("contradiction", false)] });
    const r = canon(root, "stats");
    expect(r.code).toBe(0);
    const at = (s: string) => r.out.indexOf(s);
    expect(r.out).toContain("review findings after landing by criterion:");
    expect(r.out).toContain("  contradiction: 1 verified, 2 rejected, 0 not verified; fewer than 10 verified or rejected, no share");
    expect(r.out).toContain("  restatement: 0 verified, 0 rejected, 1 not verified; fewer than 10 verified or rejected, no share");
    expect(at("  contradiction:")).toBeLessThan(at("  restatement:"));
    expect(canon(root, "stats", "--json").out).not.toContain("by criterion");
  });

  test("BR-2451: 10 or more verified or rejected findings of a criterion give the rejected share", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.block", "C-1", { docs: ["BR-1"], findings: [], landed: 1, verified: [...Array.from({ length: 4 }, () => v("contradiction", true)), ...Array.from({ length: 8 }, () => v("contradiction", false))] });
    expect(canon(root, "stats").out).toContain("  contradiction: 4 verified, 8 rejected, 0 not verified, rejected share 66.7%");
  });

  test("BR-2451: reviews with only notes, or a window without reviews after landing, have no section", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.ok", "C-1", { docs: ["BR-1"], findings: ["a note"], landed: 1, verified: [] });
    expect(canon(root, "stats").out).not.toContain("by criterion");
    const last = db.event("agent:a", "review.block", "C-2", { docs: ["BR-2"], findings: [], landed: 2, verified: [v("untestable", true)] });
    expect(canon(root, "stats").out).toContain("  untestable: 1 verified");
    expect(canon(root, "stats", "--since", String(last)).out).not.toContain("by criterion");
  });
});
