import { Database } from "bun:sqlite";
import { closeSync, copyFileSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { err, ok, type Result } from "./result.ts";

/** Thin git wrapper. Every call is explicit about its cwd; output is trimmed stdout, failures carry stderr. */
export function git(cwd: string, ...args: string[]): Result<string> {
  return gitEnv(cwd, {}, ...args);
}

/** `git` with extra environment variables, e.g. GIT_INDEX_FILE for a scratch index. */
export function gitEnv(cwd: string, env: Readonly<Record<string, string>>, ...args: string[]): Result<string> {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", ...(Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}) });
  if (r.exitCode !== 0) return err("io", `git ${args.join(" ")}: ${(r.stderr.toString() || r.stdout.toString()).trim()}`);
  return ok(r.stdout.toString().trim());
}

export function toplevel(cwd: string): Result<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

export interface WorktreeInfo {
  readonly path: string;
  readonly head: string;
  readonly branch?: string; // short name, absent when detached
}

export function listWorktrees(cwd: string): Result<WorktreeInfo[]> {
  const r = git(cwd, "worktree", "list", "--porcelain");
  if (!r.ok) return r;
  const out: WorktreeInfo[] = [];
  for (const block of r.value.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
    if (path && head) out.push({ path, head, ...(branch ? { branch } : {}) });
  }
  return ok(out);
}

export function isClean(cwd: string): Result<boolean> {
  const r = git(cwd, "status", "--porcelain");
  return r.ok ? ok(r.value === "") : r;
}

/** Git-ignored files under a worktree, relative to it; a directory that is ignored as a whole appears once, as `dir/`. */
export function ignoredPaths(cwd: string): Result<string[]> {
  const r = git(cwd, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory");
  return r.ok ? ok(r.value.split("\0").filter((p) => p !== "")) : r;
}

/**
 * The ignored paths that are work rather than rebuildable output: no segment of the path matches a
 * `regenerable` name (BR-2019). `node_modules/` and `pkg/dist/` are regenerable by default, `.env` is not.
 */
export function unregenerable(paths: readonly string[], regenerable: readonly string[]): string[] {
  const globs = regenerable.map((p) => new Bun.Glob(p));
  return paths.filter((p) => !p.replace(/\/+$/, "").split("/").some((seg) => globs.some((g) => g.match(seg))));
}

/** How long canon waits for another canon process to finish adding or removing a worktree before failing loud. */
export const WORKTREE_LOCK_WAIT_MS = 300_000;

/** Set in the environment of a git command run under the worktree lock, so a canon run from its hooks does not wait on its own parent. */
export const WORKTREE_LOCK_ENV = "CANON_WORKTREE_LOCK_HELD";

/** `<git common dir>/canon/worktree.lock`: one lock for every worktree of the repository containing `cwd`. */
export function worktreeLockPath(cwd: string): Result<string> {
  const r = git(cwd, "rev-parse", "--git-common-dir");
  if (!r.ok) return r;
  return ok(join(isAbsolute(r.value) ? r.value : join(cwd, r.value), "canon", "worktree.lock"));
}

/**
 * Runs `fn` holding the repository's worktree lock (BR-2223, D-33). "change" is exclusive: no other canon process
 * changes or reads `.git/worktrees` meanwhile. "read" is shared: readers run together, but never while a change is
 * under way. The lock is a SQLite transaction on its own empty file: the others wait for it (SQLite's busy timeout),
 * and the OS drops it when the holder dies, so a crash never leaves it stuck.
 */
export function withWorktreeLock<T>(cwd: string, mode: "change" | "read", fn: () => T, waitMs: number = WORKTREE_LOCK_WAIT_MS): Result<T> {
  // reason: a canon run from a git hook of the locked command itself; its parent holds the lock, so waiting would deadlock (D-33)
  if (process.env[WORKTREE_LOCK_ENV] === "1") return ok(fn());
  const path = worktreeLockPath(cwd);
  if (!path.ok) return path;
  let db: Database | undefined;
  try {
    mkdirSync(dirname(path.value), { recursive: true });
    db = new Database(path.value, { create: true });
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))};`);
    if (mode === "change") db.exec("BEGIN EXCLUSIVE;");
    else {
      db.exec("BEGIN;");
      db.query("SELECT count(*) FROM sqlite_master").get(); // takes the shared lock
    }
  } catch (e) {
    db?.close();
    const message = (e as Error).message;
    if (/database is locked|SQLITE_BUSY/i.test(message)) return err("io", `waited ${waitMs} ms for the worktree lock ${path.value}: another canon process is still adding or removing a worktree`);
    return err("io", `cannot take the worktree lock ${path.value}: ${message}`);
  }
  try {
    return ok(fn());
  } finally {
    db.exec("ROLLBACK;");
    db.close();
  }
}

function lockedWorktreeChange(cwd: string, args: readonly string[]): Result<string> {
  const r = withWorktreeLock(cwd, "change", () => gitEnv(cwd, { [WORKTREE_LOCK_ENV]: "1" }, "worktree", ...args));
  return r.ok ? r.value : r;
}

/** `git worktree prune` under the exclusive worktree lock: it deletes `.git/worktrees/<id>` entries another process may be reading (BR-2223). */
export function pruneWorktrees(cwd: string): Result<string> {
  return lockedWorktreeChange(cwd, ["prune"]);
}

/**
 * `git worktree add <args>` under the exclusive worktree lock. git reads every `.git/worktrees/<id>` while adding or
 * listing and dies on one another add has made but not finished (`failed to read .git/worktrees/<id>/commondir`,
 * issue #32), so canon never runs one while another canon process is adding (BR-2223, D-33).
 */
export function addWorktree(cwd: string, ...args: string[]): Result<string> {
  return lockedWorktreeChange(cwd, ["add", ...args]);
}

/** `git worktree remove <args>` under the exclusive worktree lock: removing deletes a registration file by file (BR-2223, D-33). */
export function removeWorktree(cwd: string, ...args: string[]): Result<string> {
  return lockedWorktreeChange(cwd, ["remove", ...args]);
}

/** listWorktrees under the shared worktree lock, so it never reads a registration another canon process is adding (BR-2223, D-33). */
export function listWorktreesLocked(cwd: string): Result<WorktreeInfo[]> {
  const r = withWorktreeLock(cwd, "read", () => listWorktrees(cwd));
  return r.ok ? r.value : r;
}

/** How long moveBranch waits for another git command to release the worktree's index lock (BR-2258). */
export const INDEX_LOCK_WAIT_MS = 2_000;

/** Why moveBranch left the branch and the files as they were. */
export type BranchMoveFailure =
  | { readonly kind: "locked"; readonly message: string }
  | { readonly kind: "moved"; readonly message: string }
  | { readonly kind: "files"; readonly message: string }
  | { readonly kind: "io"; readonly message: string };

/** The file operations moveBranch uses on the index; tests pass ones that fail, as a full disk would. */
export interface IndexFiles {
  readonly copy: (from: string, to: string) => void;
  readonly rename: (from: string, to: string) => void;
}

const INDEX_FILES: IndexFiles = { copy: copyFileSync, rename: renameSync };

/**
 * Moves the branch checked out in `wt` from `from` to `to`, with its index and files following, as one step against
 * other git commands in that worktree (BR-2258, D-39): it takes git's own lock, `<index>.lock`, the way git does, so
 * a `git commit` or `git add` started meanwhile dies on it instead of committing the old index on the new HEAD
 * (issue #36). Under the lock the branch moves by a compare-and-swap from `from`, and `git read-tree -m -u` builds the
 * new index in a scratch file, which then replaces the index. A HEAD that is no longer `from`, or files with local
 * edits read-tree would overwrite, leave the branch, the index and the files as they were. Undefined when it moved.
 */
export function moveBranch(wt: string, from: string, to: string, message: string, waitMs: number = INDEX_LOCK_WAIT_MS, files: IndexFiles = INDEX_FILES): BranchMoveFailure | undefined {
  const fail = (kind: BranchMoveFailure["kind"], text: string): BranchMoveFailure => ({ kind, message: text });
  const index = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "index");
  if (!index.ok) return fail("locked", index.error.message);
  const lock = `${index.value}.lock`;
  const scratch = `${index.value}.canon-move`;
  let fd: number | undefined;
  for (const until = Date.now() + waitMs; ; ) {
    try {
      // reason: created exclusively, as git creates it; git itself never waits for it, so a short wait covers a `git status` refresh (BR-2258).
      fd = openSync(lock, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return fail("locked", `cannot take ${lock}: ${(e as Error).message}`);
      if (Date.now() >= until) return fail("locked", `${lock} exists: another git command is using this worktree's index`);
      Bun.sleepSync(25);
    }
  }
  let moved = false;
  let synced = false;
  try {
    // reason: copied before HEAD moves, so a copy that fails (a full disk) leaves nothing to undo (issue #95).
    files.copy(index.value, scratch);
    const cas = git(wt, "update-ref", "-m", message, "HEAD", to, from);
    if (!cas.ok) return fail("moved", `HEAD is no longer ${from.slice(0, 9)}`);
    moved = true;
    const sync = gitEnv(wt, { GIT_INDEX_FILE: scratch }, "read-tree", "-m", "-u", from, to);
    if (!sync.ok) {
      git(wt, "update-ref", "-m", `${message} (undone)`, "HEAD", from, to);
      return fail("files", sync.error.message.split("\n")[0] ?? "read-tree failed");
    }
    synced = true;
    files.rename(scratch, index.value);
    return undefined;
  } catch (e) {
    // reason: HEAD and the files go back to `from`, where the index still is, so no commit records one tree on top of the other (BR-2258, issue #95).
    if (synced) gitEnv(wt, { GIT_INDEX_FILE: scratch }, "read-tree", "-m", "-u", to, from);
    if (moved) git(wt, "update-ref", "-m", `${message} (undone)`, "HEAD", from, to);
    return fail("io", `the index could not be replaced (${(e as Error).message}); the branch and the files were left as they were`);
  } finally {
    closeSync(fd);
    rmSync(scratch, { force: true });
    rmSync(lock, { force: true });
  }
}
