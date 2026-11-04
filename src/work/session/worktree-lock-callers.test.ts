import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { listWorktreesKeepingState } from "../../kernel/git.ts";
import { project } from "../testkit.ts";
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

describe("listing worktrees for uninstall", () => {
  test("BR-2223 BR-2280: without canon's state directory the list is read unlocked and the directory stays gone; with it, the list is read under the worktree lock", () => {
    const root = project();
    const state = join(root, ".git", "canon");
    expect(existsSync(state)).toBe(false);
    const gone = listWorktreesKeepingState(root);
    expect(gone.ok && gone.value.length).toBe(1);
    expect(existsSync(state)).toBe(false);
    mkdirSync(state);
    const kept = listWorktreesKeepingState(root);
    expect(kept.ok && kept.value.length).toBe(1);
    expect(existsSync(join(state, "worktree.lock"))).toBe(true);
  });
});
