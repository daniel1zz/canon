import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { project, sh } from "../testkit.ts";

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A project with a code root and a shared directory, and one search recorded in its coordination database. */
function withSharedAndSearch(): string {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\ncode_root: src\nshared: [src/kernel]\n");
  mkdirSync(join(root, "src/kernel"), { recursive: true });
  writeFileSync(join(root, "src/kernel/a.ts"), "a\n");
  writeFileSync(join(root, "src/b.ts"), "b\nb\nb\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "code");
  const db = CoordDb.open(join(root, ".git/canon/state.db"));
  if (!db.ok) throw new Error(db.error.message);
  db.value.event("agent:test", "search", null, { query: "q", results: 0, full: 0 });
  db.value.close();
  return root;
}

describe("canon stats output order", () => {
  test("BR-2121 BR-2135: the shared code line is the last line, after the search line (issue #70)", () => {
    const r = canon(withSharedAndSearch(), "stats");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n").filter((l) => l !== "");
    expect(lines.at(-1)).toBe("shared code: 1 of 4 lines under src (25.0%): above 20%; move code that serves one domain into that domain's directory");
    expect(lines.at(-2)).toBe("searches: 1, no result: 1 (100.0%), no full match: 1 (100.0%)");
  });
});
