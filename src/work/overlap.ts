import { basename } from "node:path";
import type { Workspace } from "../app/workspace.ts";
import { git, listWorktrees } from "../repo/git.ts";
import { worktreesDirOf } from "../repo/config.ts";

/**
 * Same-file overlap between changes in flight (C-7): two change branches that both changed a file relative
 * to main will meet in a rebase conflict at land (BR-2015). Telling both sessions early costs nothing and
 * never blocks: the notice changes no exit code (BR-2062), and each one is recorded as `overlap.notice` so
 * its usefulness can be measured later (P6).
 */
export interface Overlap {
  /** The other change (its worktree directory name, e.g. C-5). */
  readonly change: string;
  readonly files: readonly string[];
}

/** Files a branch changed relative to main, from their merge base (`git diff main...branch`). */
function changedFiles(ws: Workspace, branch: string): Set<string> {
  const r = git(ws.primary, "diff", "--name-only", `${ws.config.main}...${branch}`);
  return new Set(r.ok && r.value !== "" ? r.value.split("\n") : []);
}

/** Every other change worktree whose branch changed a file this worktree's branch changed too. */
export function overlapsOf(ws: Workspace, worktree: string): Overlap[] {
  const wts = listWorktrees(ws.primary);
  if (!wts.ok) return [];
  const dir = `${worktreesDirOf(ws.config, ws.primary)}/`;
  const mine = wts.value.find((w) => w.path === worktree);
  if (!mine?.branch || mine.branch === ws.config.main) return [];
  const own = changedFiles(ws, mine.branch);
  if (own.size === 0) return [];
  const out: Overlap[] = [];
  for (const w of wts.value) {
    if (w.path === worktree || !w.path.startsWith(dir) || !w.branch || w.branch === ws.config.main) continue;
    const files = [...changedFiles(ws, w.branch)].filter((f) => own.has(f)).sort();
    if (files.length > 0) out.push({ change: basename(w.path), files });
  }
  return out.sort((a, b) => a.change.localeCompare(b.change, undefined, { numeric: true }));
}

/** Prints each overlap and records it as an `overlap.notice` event; returns the overlaps found. */
export function noticeOverlaps(ws: Workspace, worktree: string, change: string | null, at: "start" | "land", say: (line: string) => void): Overlap[] {
  const found = overlapsOf(ws, worktree);
  for (const o of found) {
    say(`overlap: ${o.change} also changes ${o.files.join(", ")}; whoever lands second resolves the conflict`);
    ws.db.event(ws.actor, "overlap.notice", change, { at, with: o.change, files: o.files });
  }
  return found;
}
