import type { Workspace } from "../../workspace.ts";
import { git } from "../../../kernel/git.ts";
import { BACKLOG_FILE, parseUrgent } from "../../../knowledge/documents/backlog.ts";
import { redMain } from "../../watch/redmain.ts";
import type { LandOutcome } from "../outcome.ts";
import { ownDiffId } from "../worktree-state.ts";
import type { Priority } from "./queue.ts";
import { marks } from "./urgent.ts";

/** How often a waiting lander tries for its turn, at most. */
const POLL_MS = 2000;

/**
 * Each try for the turn is the waiting lander's heartbeat, so it comes at least three times per stale time, as
 * the landing heartbeat does (BR-2044, BR-2049): a stale time under 2 s must not make a waiting lander look gone.
 */
export const waitPollMs = (staleMs: number) => Math.min(POLL_MS, Math.max(50, staleMs / 3));

/**
 * Who goes first right now (BR-2232, BR-2363): the fix change of a failing main, the changes the owner marked with
 * `canon backlog urgent`, and the changes listed under 优先合入 in the backlog committed on main. Read from main, never from a worktree, so no change can promote itself by editing its own copy.
 */
export function priorityNow(ws: Workspace): Priority {
  const text = git(ws.primary, "cat-file", "-p", `refs/heads/${ws.config.main}:${BACKLOG_FILE}`);
  // reason: a main without canon/backlog.md lists nothing urgent; a backlog that cannot be read otherwise is checked by canon check (BR-2148).
  const urgent = text.ok ? parseUrgent(text.value, ws.config.types) : new Set<string>();
  return { fix: redMain(ws.db)?.change ?? undefined, marked: new Set(marks(ws.db).map((m) => m.change)), urgent };
}

/** What a conflict refusal tells the lander about the place it keeps in the queue (BR-2177). */
export function keptNote(until: string | null): string {
  if (!until) return "";
  return `\nThis landing keeps its place in the queue until ${until}: landing again from this worktree before then puts it back ahead of the landings queued after it; they go on landing while you resolve.`;
}

/**
 * The refusal of an entry that another lander marked abandoned: nothing moves, and the entry keeps the state
 * that lander gave it (BR-2144). `stage` says whether it was found while waiting or just before main would move.
 */
export function lostTurn(ws: Workspace, subject: string | null, wt: string, state: string, stage: "queue" | "before-main"): LandOutcome {
  const message = `this landing's queue entry is no longer active (${state}): another lander skipped it after it stopped heart-beating, so ${ws.config.main} was not moved; land again`;
  // reason: the lander was interrupted, not judged by a check, so it is its own event kind and no check in `canon stats` (BR-2144, like land.killed in BR-2099).
  ws.db.event(ws.actor, "land.lost", subject, { stage, state, diff: ownDiffId(wt, ws.config.main) });
  return { kind: "refused", reason: "lost-turn", message };
}

/**
 * Files a merge of `base` and HEAD would leave conflicted, from `git merge-tree --write-tree` (git 2.38+), which
 * merges in memory and touches neither the index nor the worktree (D-22). Not ok when the prediction cannot run
 * (an older git, a bad ref): then the real rebase at the turn decides, as before (BR-2015).
 */
export function predictedConflicts(wt: string, base: string): { ok: true; files: string[] } | { ok: false; error: string } {
  const r = Bun.spawnSync(["git", "-c", "core.quotePath=false", "merge-tree", "--write-tree", "--name-only", "--no-messages", base, "HEAD"], { cwd: wt, stdout: "pipe", stderr: "pipe" });
  const lines = r.stdout.toString().trim().split("\n");
  // reason: exit 1 is a conflict only when the merged tree's id came first; a bad ref also exits 1, with no tree (BR-2153).
  const merged = /^[0-9a-f]{40,64}$/.test(lines[0] ?? "");
  if (r.exitCode === 0 && merged) return { ok: true, files: [] };
  if (r.exitCode !== 1 || !merged) return { ok: false, error: `git merge-tree exited ${r.exitCode}: ${r.stderr.toString().trim().split("\n")[0] ?? ""}` };
  return { ok: true, files: [...new Set(lines.slice(1).filter((l) => l !== ""))].sort() };
}
