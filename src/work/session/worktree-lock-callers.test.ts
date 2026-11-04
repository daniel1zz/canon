import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
/** The one file allowed to run these git commands itself: it wraps them in the worktree lock (BR-2223). */
const LOCK_HOME = join("kernel", "git.ts");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

describe("every canon worktree change and list takes the worktree lock", () => {
  test("BR-2223: outside kernel/git.ts no code runs git worktree add, remove, prune or list, or the unlocked listWorktrees", () => {
    const raw = /["']worktree["']\s*,\s*["'](add|remove|prune|list)["']|\blistWorktrees\(/;
    const found = sources(SRC)
      .filter((f) => relative(SRC, f) !== LOCK_HOME)
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .flatMap((line, i) => (raw.test(line) && !line.includes("withWorktreeLock(") ? [`${relative(SRC, f)}:${i + 1}`] : [])),
      );
    expect(found).toEqual([]);
  });
});
