import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { addWorktree, pruneWorktrees, removeWorktree } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { Workspace } from "../../workspace.ts";
import type { Running } from "../outcome.ts";

let sequence = 0;

/**
 * A temporary worktree at main's commit that one landing's review commands run in (BR-2216); `name` is unique per landing step.
 * reason: it lives here, not with the batch, so the review tree needs nothing from the landing it serves (#212)
 */
export const reviewDir = (ws: Workspace, name: string) => join(dirname(ws.db.db.filename), "review", name);

/** Removes the temporary review worktree at `dir`, whatever state it is in; an error says what is left behind. */
export function removeReviewTree(ws: Workspace, dir: string): Result<void> {
  const removed = existsSync(dir) ? removeWorktree(ws.primary, "--force", dir) : ok("");
  // reason: a failed `git worktree remove` can leave the directory or its registration; clear both before reporting (BR-2216)
  rmSync(dir, { recursive: true, force: true });
  pruneWorktrees(ws.primary);
  return removed.ok ? ok(undefined) : err("io", `the temporary review worktree ${dir} could not be removed: ${removed.error.message.split("\n")[0]}`);
}

/**
 * The detached temporary worktree at `rev` (main's commit) a landing's review commands run in, so the change under
 * review cannot edit the reviewer's script, CLAUDE.md, .claude/settings.json or skills (BR-2216, D-51, #115).
 * It is created by the first `get()` and removed by `release()`; the signal handler finds it in `running.reviewTree`.
 */
export function reviewTree(ws: Workspace, running: Running, rev: string): { get(): Result<string>; release(): Result<void> } {
  let dir: string | undefined;
  return {
    get() {
      if (dir !== undefined) return ok(dir);
      const next = reviewDir(ws, `${process.pid}-${++sequence}`);
      running.reviewTree = next;
      mkdirSync(dirname(next), { recursive: true });
      pruneWorktrees(ws.primary);
      // reason: --detach, so no branch is checked out and main's guard on its branch is never touched (BR-2125)
      const added = addWorktree(ws.primary, "-q", "--detach", next, rev);
      if (!added.ok) {
        removeReviewTree(ws, next);
        running.reviewTree = undefined;
        return err("io", `a temporary worktree at ${rev.slice(0, 9)} to run the review in could not be created: ${added.error.message.split("\n")[0]}`);
      }
      dir = next;
      return ok(next);
    },
    release() {
      if (dir === undefined) return ok(undefined);
      const gone = removeReviewTree(ws, dir);
      dir = undefined;
      running.reviewTree = undefined;
      return gone;
    },
  };
}
