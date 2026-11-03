import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../workspace.ts";
import { dropHandoff } from "../session/handoffs.ts";
import { holdClaim, unholdClaim } from "../claims/claims.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git, gitEnv, ignoredPaths, unregenerable } from "../../kernel/git.ts";
import { GENERATED_DIR } from "../../config/reference/reference.ts";
import { processesIn } from "../../kernel/process.ts";
import { describeOccupants, worktreesDir } from "../session/session.ts";

/**
 * Dropping a change's work in flight (C-8): its worktree, its branch, its claim and its handoff. This is the
 * one sanctioned path for an operation that can lose work (P4). When nothing would be lost it runs at once
 * (BR-2064). Otherwise it first archives everything that would be lost under refs/canon/archive/<C-n>/<time>,
 * reads the archive back, and only then deletes (BR-2102); if archiving or the read-back fails it deletes
 * nothing (BR-2103). The owner chose archiving over asking a human every time (D-13). It does not intercept
 * an agent using git directly: that would be checking how an agent works, which D-1 rules out.
 */
export interface Dropped {
  readonly worktree: string | null;
  readonly branch: string | null;
  /** The archive ref, or null when nothing would have been lost. */
  readonly archive: string | null;
  readonly losses: readonly string[];
  /** Commands that bring the dropped work back; empty when nothing was archived. */
  readonly restore: readonly string[];
}

interface Target {
  readonly change: string;
  readonly worktree: string | null;
  readonly branch: string | null;
}

function locate(ws: Workspace, change: string): Result<Target> {
  const path = join(worktreesDir(ws), change);
  const worktree = existsSync(path) ? path : null;
  let branch: string | null = null;
  if (worktree) {
    const b = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
    if (b.ok && b.value !== "HEAD") branch = b.value;
  }
  if (!branch) {
    const list = git(ws.primary, "for-each-ref", "--format=%(refname:short)", `refs/heads/change/${change}`, `refs/heads/change/${change}-*`);
    const names = list.ok && list.value !== "" ? list.value.split("\n") : [];
    branch = names[0] ?? null;
  }
  if (!worktree && !branch) return err("not_found", `${change} has no worktree and no branch; nothing to drop`);
  if (branch === ws.config.main) return err("invalid", `${change}'s worktree has ${ws.config.main} checked out; refusing to delete ${ws.config.main}`);
  return ok({ change, worktree, branch });
}

/** What dropping would lose, one line each, plus the ignored paths that must go into the archive. */
function losses(ws: Workspace, t: Target): Result<{ lines: string[]; ignored: string[] }> {
  const lines: string[] = [];
  if (t.branch) {
    const log = git(ws.primary, "log", "--format=%h %s", `${ws.config.main}..${t.branch}`);
    if (!log.ok) return log;
    for (const line of log.value !== "" ? log.value.split("\n") : []) lines.push(`commit not on ${ws.config.main}: ${line}`);
  }
  let ignored: string[] = [];
  if (t.worktree) {
    const st = git(t.worktree, "status", "--porcelain");
    if (!st.ok) return st;
    for (const line of st.value !== "" ? st.value.split("\n") : []) lines.push(`uncommitted: ${line.trim()}`);
    // `git status` hides git-ignored files; the ones a build cannot regenerate are work too (BR-2064).
    const all = ignoredPaths(t.worktree);
    if (!all.ok) return all;
    // reason: canon's own generated files are always regenerable, whatever the project lists (BR-2176)
    ignored = unregenerable(all.value, [...ws.config.regenerable, GENERATED_DIR]);
    for (const p of ignored) lines.push(`ignored: ${p}`);
  }
  return ok({ lines, ignored });
}

/**
 * Archives the branch tip and the worktree's uncommitted, untracked and non-regenerable ignored files as one
 * commit (first parent: the branch tip) under a new ref, then reads it back. `git stash create` cannot do
 * this: it records tracked changes only. A scratch index (GIT_INDEX_FILE) captures the files without
 * touching the worktree's own index.
 */
function archive(ws: Workspace, t: Target, ignored: readonly string[]): Result<{ ref: string; tip: string; commit: string }> {
  const at = t.worktree ?? ws.primary;
  const tipR = git(at, "rev-parse", "--verify", t.worktree ? "HEAD^{commit}" : `refs/heads/${t.branch}^{commit}`);
  if (!tipR.ok) return tipR;
  const tip = tipR.value;
  let commit = tip;
  let tree: string;
  const scratch = mkdtempSync(join(tmpdir(), "canon-archive-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    if (t.worktree) {
      for (const args of [["read-tree", tip], ["add", "-A"], ...(ignored.length > 0 ? [["add", "-f", "--", ...ignored]] : [])]) {
        const r = gitEnv(t.worktree, env, ...args);
        if (!r.ok) return r;
      }
      const w = gitEnv(t.worktree, env, "write-tree");
      if (!w.ok) return w;
      tree = w.value;
      const tipTree = git(at, "rev-parse", `${tip}^{tree}`);
      if (!tipTree.ok) return tipTree;
      if (tree !== tipTree.value) {
        const who = { GIT_AUTHOR_NAME: ws.actor, GIT_AUTHOR_EMAIL: "canon@localhost", GIT_COMMITTER_NAME: ws.actor, GIT_COMMITTER_EMAIL: "canon@localhost" };
        const c = gitEnv(at, who, "commit-tree", tree, "-p", tip, "-m", `canon: archive of ${t.change}'s uncommitted work before canon work drop`);
        if (!c.ok) return c;
        commit = c.value;
      }
    } else {
      const r = git(at, "rev-parse", `${tip}^{tree}`);
      if (!r.ok) return r;
      tree = r.value;
    }
    const ref = `refs/canon/archive/${t.change}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const made = git(ws.primary, "update-ref", ref, commit, ""); // "" = create only, never overwrite an archive
    if (!made.ok) return made;

    // Read back: the ref names the commit, holds the captured tree, keeps the branch tip, and has every file.
    const back = git(ws.primary, "rev-parse", "--verify", `${ref}^{commit}`);
    if (!back.ok || back.value !== commit) return err("io", `${ref} does not read back as ${commit}`);
    const backTree = git(ws.primary, "rev-parse", `${ref}^{tree}`);
    if (!backTree.ok || backTree.value !== tree) return err("io", `${ref} does not hold tree ${tree}`);
    if (!git(ws.primary, "merge-base", "--is-ancestor", tip, ref).ok) return err("io", `${ref} does not contain the branch tip ${tip}`);
    if (t.worktree) {
      const files = git(ws.primary, "-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", ref);
      if (!files.ok) return files;
      const have = new Set(files.value.split("\0"));
      const untracked = git(t.worktree, "ls-files", "-z", "--others", "--exclude-standard");
      const modified = git(t.worktree, "ls-files", "-z", "--modified");
      if (!untracked.ok) return untracked;
      if (!modified.ok) return modified;
      const deleted = git(t.worktree, "ls-files", "-z", "--deleted");
      const gone = new Set(deleted.ok ? deleted.value.split("\0") : []);
      const want = [...untracked.value.split("\0"), ...modified.value.split("\0")].filter((p) => p !== "" && !gone.has(p));
      const missing = want.find((p) => !have.has(p)) ?? ignored.find((p) => (p.endsWith("/") ? ![...have].some((h) => h.startsWith(p)) : !have.has(p)));
      if (missing) return err("io", `${ref} lacks ${missing}`);
      // The captured state is the one on disk: no file changed between the capture and now.
      const same = gitEnv(t.worktree, env, "diff-files", "--quiet");
      if (!same.ok) return err("io", `the worktree changed while it was archived; ${ref} may be incomplete`);
    }
    return ok({ ref, tip, commit });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function drop(ws: Workspace, change: string, say: (line: string) => void): Result<Dropped> {
  const located = locate(ws, change.toUpperCase());
  if (!located.ok) return located;
  const t = located.value;
  if (t.worktree && ws.root === t.worktree) return err("invalid", `you are in ${t.worktree}; run \`canon work drop ${t.change}\` from another checkout`);
  // Someone else still at work there is not something an archive can save: refuse before looking at losses.
  // The hold is atomic and lasts until the end, so no `canon work start` can take the change over while the
  // archive is written and the worktree removed (issue #13).
  const holder = t.worktree ?? `branch:${t.branch}`;
  const hold = holdClaim(ws.db, t.change, holder, ws.actor, false, ws.config.claimLeaseMs);
  if (!hold.ok) {
    ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "claimed" });
    return hold;
  }
  const giveUp = <T>(r: Result<T>): Result<T> => {
    unholdClaim(ws.db, hold.value);
    return r;
  };
  if (t.worktree) {
    const occupied = processesIn([t.worktree]);
    if (!occupied.ok) {
      ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "no-process-list", message: occupied.error.message.slice(0, 2000) });
      return giveUp(err("io", `cannot tell whether a process is inside ${t.worktree}, so nothing was deleted: ${occupied.error.message}`));
    }
    const inside = occupied.value.get(t.worktree) ?? [];
    if (inside.length > 0) {
      ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "in-use", pids: inside.map((o) => o.pid) });
      return giveUp(err("conflict", `${t.worktree} is in use by ${describeOccupants(inside)}; nothing was deleted. Run this again once that process has left it`));
    }
  }
  const tip = t.branch ? git(ws.primary, "rev-parse", "--verify", `refs/heads/${t.branch}`) : ok("");
  if (!tip.ok) return giveUp(tip);
  const lost = losses(ws, t);
  if (!lost.ok) return giveUp(lost);

  let archived: { ref: string; tip: string; commit: string } | null = null;
  const restore: string[] = [];
  if (lost.value.lines.length > 0) {
    const a = archive(ws, t, lost.value.ignored);
    // reason: whatever appeared after the losses were listed is not in the archive; it must not be deleted (BR-2103).
    const again = a.ok ? losses(ws, t) : a;
    const failure = !a.ok ? a.error.message : !again.ok ? again.error.message : again.value.lines.join("\n") !== lost.value.lines.join("\n") ? `${t.change} changed while it was archived` : null;
    if (failure !== null || !a.ok) {
      const message = failure ?? "archive failed";
      ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "archive", message: message.slice(0, 2000), losses: lost.value.lines });
      return giveUp(err("io", `archiving ${t.change} failed, so nothing was deleted: ${message}`));
    }
    archived = a.value;
    const branch = t.branch ?? `change/${t.change}`;
    restore.push(`git branch ${branch} ${archived.tip}`);
    if (t.worktree) {
      restore.push(`git worktree add ${t.worktree} ${branch}`);
      if (archived.commit !== archived.tip) restore.push(`git -C ${t.worktree} restore --source=${archived.ref} --worktree -- .`);
    }
  }

  const kept = archived ? `; the work is also archived at ${archived.ref}` : "";
  if (t.branch) {
    // reason: compare-and-delete: a commit made since the tip was read (and so not archived) makes this fail (issue #13);
    // that is an archive failure, so it is recorded like one (BR-2103, issue #59).
    const del = git(ws.primary, "update-ref", "-d", `refs/heads/${t.branch}`, tip.value);
    if (!del.ok) {
      const message = `${t.branch} moved while ${t.change} was being dropped: ${del.error.message}`;
      ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "archive", message: message.slice(0, 2000), losses: lost.value.lines, archive: archived?.ref ?? null });
      return giveUp(err("io", `${message}; nothing was deleted${kept}`));
    }
  }
  if (t.worktree) {
    // reason: --force is safe here: everything it would destroy is in the archive verified above (BR-2102).
    const rm = git(ws.primary, "worktree", "remove", "--force", t.worktree);
    if (!rm.ok) {
      // reason: all or nothing (BR-2064): the branch deleted just above comes back at the same tip, create-only (issue #58).
      const back = t.branch ? git(ws.primary, "update-ref", `refs/heads/${t.branch}`, tip.value, "") : ok("");
      ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "remove", message: rm.error.message.slice(0, 2000), losses: lost.value.lines, archive: archived?.ref ?? null, branch_restored: back.ok });
      const branchNote = back.ok ? "nothing was deleted" : `the branch ${t.branch} was deleted and could not be put back (${back.error.message}); restore it with \`git branch ${t.branch} ${tip.value}\``;
      return giveUp(err("io", `removing ${t.worktree} failed, so ${branchNote}${kept}: ${rm.error.message}`));
    }
  }
  // reason: only this drop's own hold goes; a claim anyone took since is not this drop's to delete (issue #18).
  unholdClaim(ws.db, { ...hold.value, prior: null });
  dropHandoff(ws.db, t.change);
  ws.db.event(ws.actor, "drop.done", t.change, { worktree: t.worktree, branch: t.branch, losses: lost.value.lines, archive: archived?.ref ?? null, archive_commit: archived?.commit ?? null });
  say(`dropped ${t.change}${t.worktree ? `: removed ${t.worktree}` : ""}${t.branch ? `, deleted branch ${t.branch}` : ""}`);
  if (archived) {
    say(`archived to ${archived.ref}:\n${lost.value.lines.map((l) => `  - ${l}`).join("\n")}`);
    say(`restore with:\n${restore.map((c) => `  ${c}`).join("\n")}`);
  }
  return ok({ worktree: t.worktree, branch: t.branch, archive: archived?.ref ?? null, losses: lost.value.lines, restore });
}
