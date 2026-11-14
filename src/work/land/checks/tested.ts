import type { CoordDb } from "../../db.ts";
import { git } from "../../../kernel/git.ts";

/**
 * BR-2463: what `canon work test` left failing on this branch in this worktree. Every run of a clean worktree at a commit of
 * the branch (one `main..HEAD` lists, HEAD included) counts, oldest first: a file fails when its latest run on the branch
 * failed; the typecheck counts as its latest exit there. A commit made after a failing run does not clear it: only a run
 * that passes does. A run with uncommitted edits, or on a commit not on the branch, is not counted.
 */
export function failedOnBranch(db: CoordDb, worktree: string, main: string): { files: string[]; typecheck: number | null } | { error: string } {
  const listed = git(worktree, "rev-list", `${main}..HEAD`);
  if (!listed.ok) return { error: listed.error.message };
  const commits = new Set(listed.value.split("\n").filter((l) => l !== ""));
  const rows = db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'work.test' AND worktree = ? ORDER BY id").all(worktree);
  const failing = new Set<string>();
  let typecheck: number | null = null;
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { head?: string | null; clean?: boolean; ranFiles?: string[]; failedFiles?: string[]; typecheck?: number | null };
    if (d.clean !== true || !d.head || !commits.has(d.head)) continue;
    const failed = new Set(d.failedFiles ?? []);
    for (const f of d.ranFiles ?? []) {
      if (failed.has(f)) failing.add(f);
      else failing.delete(f);
    }
    if (d.typecheck !== undefined && d.typecheck !== null) typecheck = d.typecheck;
  }
  return { files: [...failing].sort(), typecheck: typecheck === 0 ? null : typecheck };
}
