import { basename } from "node:path";
import type { Workspace } from "../workspace.ts";
import { git, listWorktreesLocked } from "../../kernel/git.ts";
import { ok, type Result } from "../../kernel/result.ts";
import { worktreesDirOf } from "./config-keys.ts";

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

/** What the overlap comparison found, and what it could not compare (git failed), so a missing notice is never silent. */
export interface Overlaps {
  readonly found: Overlap[];
  readonly unreadable: string[];
}

/** Files a branch changed relative to main, from their merge base (`git diff main...branch`). */
function changedFiles(ws: Workspace, branch: string): Result<Set<string>> {
  const r = git(ws.primary, "diff", "--name-only", `${ws.config.main}...${branch}`);
  return r.ok ? ok(new Set(r.value !== "" ? r.value.split("\n") : [])) : r;
}

/** Every other change worktree whose branch changed a file this worktree's branch changed too. */
export function overlapsOf(ws: Workspace, worktree: string): Overlaps {
  const unreadable: string[] = [];
  const wts = listWorktreesLocked(ws.primary);
  if (!wts.ok) return { found: [], unreadable: [`cannot list worktrees: ${wts.error.message}`] };
  const dir = `${worktreesDirOf(ws.config, ws.primary)}/`;
  const mine = wts.value.find((w) => w.path === worktree);
  if (!mine?.branch || mine.branch === ws.config.main) return { found: [], unreadable };
  const own = changedFiles(ws, mine.branch);
  if (!own.ok) return { found: [], unreadable: [`cannot compare ${mine.branch} with ${ws.config.main}: ${own.error.message}`] };
  if (own.value.size === 0) return { found: [], unreadable };
  const out: Overlap[] = [];
  for (const w of wts.value) {
    if (w.path === worktree || !w.path.startsWith(dir) || !w.branch || w.branch === ws.config.main) continue;
    const theirs = changedFiles(ws, w.branch);
    if (!theirs.ok) {
      unreadable.push(`cannot compare ${w.branch} with ${ws.config.main}: ${theirs.error.message}`);
      continue;
    }
    const files = [...theirs.value].filter((f) => own.value.has(f)).sort();
    if (files.length > 0) out.push({ change: basename(w.path), files });
  }
  return { found: out.sort((a, b) => a.change.localeCompare(b.change, undefined, { numeric: true })), unreadable };
}

/** Prints each overlap and records it as an `overlap.notice` event; returns the overlaps found. */
export function noticeOverlaps(ws: Workspace, worktree: string, change: string | null, at: "start" | "land", say: (line: string) => void): Overlap[] {
  const { found, unreadable } = overlapsOf(ws, worktree);
  // reason: the notice never blocks, but a comparison that failed is said, not taken for "no overlap" (BR-2062)
  for (const u of unreadable) say(`overlap: ${u}`);
  for (const o of found) {
    say(`overlap: ${o.change} also changes ${o.files.join(", ")}; whoever lands second resolves the conflict`);
    ws.db.event(ws.actor, "overlap.notice", change, { at, with: o.change, files: o.files });
  }
  return found;
}
