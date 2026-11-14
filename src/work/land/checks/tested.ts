import type { CoordDb } from "../../db.ts";

/**
 * BR-2463: what `canon work test` left failing on exactly this commit in this worktree. Every run of a clean worktree at
 * `head` counts, oldest first: a file fails when its latest run there failed; the typecheck counts as its latest exit there.
 * A run on another commit or with uncommitted edits tested something else and is not counted.
 */
export function failedOnCommit(db: CoordDb, worktree: string, head: string): { files: string[]; typecheck: number | null } {
  const rows = db.db.query<{ detail: string }, [string, string]>("SELECT detail FROM events WHERE kind = 'work.test' AND worktree = ? AND json_extract(detail, '$.head') = ? ORDER BY id").all(worktree, head);
  const failing = new Set<string>();
  let typecheck: number | null = null;
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { clean?: boolean; ranFiles?: string[]; failedFiles?: string[]; typecheck?: number | null };
    if (d.clean !== true) continue;
    const failed = new Set(d.failedFiles ?? []);
    for (const f of d.ranFiles ?? []) {
      if (failed.has(f)) failing.add(f);
      else failing.delete(f);
    }
    if (d.typecheck !== undefined && d.typecheck !== null) typecheck = d.typecheck;
  }
  return { files: [...failing].sort(), typecheck: typecheck === 0 ? null : typecheck };
}
