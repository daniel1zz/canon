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

describe("canon stats: how the landings' rule reviews were done", () => {
  test("BR-2397: full, incremental and reused reviews are counted apart, reused split by prompts and documents", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.ok", "C-1", { docs: ["BR-1"], findings: [], hash: "h1", docs_hash: "d1", base: "b" });
    db.event("agent:a", "review.block", "C-2", { docs: ["BR-2"], findings: ["x"], hash: "h2", docs_hash: "d2", base: "b" });
    db.event("agent:a", "review.ok", "C-1", { docs: ["BR-1"], findings: [], docs_hash: "d1", base: "c", incremental: { from: 1, added: ["BR-9"] } });
    db.event("agent:a", "review.reused", "C-3", { review: "land", docs: ["BR-3"], hash: "h3", from: 1 });
    db.event("agent:a", "review.reused", "C-4", { review: "land", by: "docs", docs: ["BR-4"], docs_hash: "d4", from: 1 });
    const r = canon(root, "stats");
    expect(r.code).toBe(0);
    expect(r.out).toContain("rule reviews at landing: 2 full, 1 incremental, 2 reused (1 same prompts, 1 same documents)");
    expect(canon(root, "stats", "--json").out).not.toContain("incremental");
  });

  test("BR-2397: a window with only duplicate reviews and previews has no line", () => {
    const { root, db } = withDb();
    db.event("agent:a", "review.ok", "C-1", { docs: ["CLAUDE.md"], findings: [] });
    db.event("agent:a", "review.reused", "C-1", { review: "preview", docs: ["BR-1"], hash: "h", from: 1 });
    expect(canon(root, "stats").out).not.toContain("rule reviews at landing");
  });
});
