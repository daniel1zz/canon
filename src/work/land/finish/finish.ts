import type { Say, Workspace } from "../../workspace.ts";
import { logFile, runHooksInBackground } from "../../../config/hooks.ts";
import { git, gitEnv, isClean, listWorktreesLocked, moveBranch } from "../../../kernel/git.ts";
import { releaseOwnClaim } from "../../claims/claims.ts";
import { dropHandoff } from "../../session/handoffs.ts";
import type { LandOptions, LandOutcome } from "../outcome.ts";

/** The `canon: close C-n` commit `--finish` made before queuing, so a landing that fails can take it back. */
export interface CloseCommit {
  readonly subject: string;
  readonly path: string;
}

export const closeSubject = (change: string) => `canon: close ${change}`;

/** What a failed close commit leaves behind and what to do next (BR-2229). */
export const closeLeftNote = (path: string) =>
  `${path} is left with status: done and not committed (canon does not put it back, so no edit saved meanwhile is lost). Next: fix what made the commit fail, set status back to open in ${path} (git checkout -- ${path} when git diff shows only that line), then land --finish again`;

/**
 * Takes the close commit back out after a landing that did not reach main: only while HEAD is still `top`, the
 * close commit that was checked, and it changes nothing but the change file. The branch moves by a compare-and-swap
 * on HEAD, so a commit made in the worktree meanwhile is never dropped, and with the index and the change file in one
 * step under git's index lock (moveBranch), which refuses over local edits to the change file (BR-2018, BR-2258).
 */
export function reopen(wt: string, close: CloseCommit, say: Say, top = git(wt, "rev-parse", "HEAD")): boolean {
  const notReopened = (why: string) => {
    say(`${close.subject} was not reopened (${why}); it says done although it did not land`);
    return false;
  };
  if (!top.ok) return notReopened(top.error.message);
  const sha = top.value;
  const parent = git(wt, "rev-parse", `${sha}~1`);
  const subject = git(wt, "log", "-1", "--format=%s", sha);
  const files = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", `${sha}~1`, sha);
  if (!parent.ok || !subject.ok || subject.value !== closeSubject(close.subject) || !files.ok || files.value !== close.path) {
    return notReopened("its close commit is no longer the top commit");
  }
  // reason: compare-and-swap, so a commit made after the check above stays on the branch (issue #34); under git's
  // index lock, so a commit tried while the branch moves is refused instead of recording status: done (BR-2258, issue #36).
  const moved = moveBranch(wt, sha, parent.value, `canon: reopen ${close.subject}`);
  if (moved) return notReopened(moved.kind === "moved" ? "HEAD moved after the check" : moved.message);
  say(`${close.subject} reopened: the landing did not reach main, so its close commit was taken back`);
  return true;
}

/** Starts after_land in the background for one landed change, with its own base and head (BR-2030). */
export function afterLand(ws: Workspace, say: Say, l: { entry: number; subject: string | null; base: string; head: string; branch: string }): void {
  if (ws.config.hooks.after_land.length === 0) return;
  const env = { CANON_BASE: l.base, CANON_HEAD: l.head, CANON_BRANCH: l.branch };
  const log = runHooksInBackground({ db: ws.db, actor: ws.actor, event: "after_land", change: l.subject, cwd: ws.primary, env }, ws.config.hooks.after_land, logFile(ws.db, `after-land-${l.entry}.log`), l.entry);
  say(`after_land${l.subject ? ` for ${l.subject}` : ""} running in the background (log: ${log})`);
}

/** After main holds this change: with --finish, releases the own claim and handoff (BR-2018, BR-2108). */
export function finishLanding(ws: Workspace, opts: LandOptions, say: Say, l: { entry: number; subject: string | null; sha: string }): LandOutcome {
  let finished = false;
  if (opts.finish && l.subject) {
    // Another session that took the change over meanwhile keeps its claim and its handoff (BR-2108).
    if (releaseOwnClaim(ws.db, l.subject, ws.root, ws.actor)) dropHandoff(ws.db, l.subject);
    else say(`${l.subject} is claimed by another session now; its claim and handoff were left as they are`);
    finished = true;
    say(`${l.subject} closed; remove the worktree with \`canon work clean ${l.subject}\` once you have left it`);
  }
  return { kind: "landed", sha: l.sha, change: l.subject, finished };
}

/**
 * Compare-and-swap of main from `expected` to `next`. When a worktree has main checked out, it is
 * fast-forwarded in place so its files stay in step; it must be clean, or the swap is refused.
 */
/**
 * The environment variable naming the commit `canon work land` moves main to. The git guard canon installs
 * lets main move only to that commit (BR-2123); land sets it only on its own git command that moves main (BR-2125).
 */
export const LAND_MARKER = "CANON_LAND_MAIN";

export function moveMain(ws: Workspace, expected: string, next: string): "moved" | { reason: "main-moved" | "main-dirty" | "environment"; message: string } {
  const main = ws.config.main;
  const wts = listWorktreesLocked(ws.primary);
  if (!wts.ok) return { reason: "environment", message: wts.error.message };
  const holder = wts.value.find((w) => w.branch === main);
  if (holder) {
    if (holder.head !== expected) return { reason: "main-moved", message: `${main} moved to ${holder.head.slice(0, 9)} during the landing; land again` };
    const clean = isClean(holder.path);
    if (!clean.ok || !clean.value) return { reason: "main-dirty", message: `${holder.path} has ${main} checked out with uncommitted changes; ${main} was not moved` };
    const ff = gitEnv(holder.path, { [LAND_MARKER]: next }, "merge", "-q", "--ff-only", next);
    return ff.ok ? "moved" : { reason: "main-moved", message: ff.error.message };
  }
  const r = gitEnv(ws.primary, { [LAND_MARKER]: next }, "update-ref", `refs/heads/${main}`, next, expected);
  return r.ok ? "moved" : { reason: "main-moved", message: `${main} moved during the landing; land again (${r.error.message})` };
}
