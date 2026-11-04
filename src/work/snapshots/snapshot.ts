import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { git, gitEnv } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * Snapshots of a worktree's uncommitted work, taken before every Bash call by the PreToolUse hook canon installs
 * (D-30). They make lost work recoverable whatever lost it (`git checkout <file>`, `rm`, a script overwriting a file)
 * without blocking anything: canon records outcomes, it does not judge how an agent works (D-1).
 */

export const SNAPSHOT_REFS = "refs/canon/snapshots";
/**
 * How long snapshots are kept (BR-2183). Work is snapshotted before nearly every Bash call, so a count limit would
 * cover only minutes; age decides instead. Every snapshot of the last day stays, so any state of that day can be
 * recovered; from then on the newest of each hour per worktree stays; after MAX_AGE_DAYS none. Age, not the worktree's
 * removal, ends a snapshot: work lost unnoticed and then landed and cleaned up stays recoverable for a while.
 */
export const KEEP_ALL_HOURS = 24;
export const MAX_AGE_DAYS = 14;
/** A changed or untracked file larger than this is left out of a snapshot and named in it (BR-2182). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The name a worktree's snapshots are kept under: its directory name, which for a change worktree is the change id. */
export const snapshotKey = (worktree: string) => basename(worktree).replace(/[^A-Za-z0-9._-]/g, "_") || "_";

export type TakeOutcome =
  | { readonly kind: "taken"; readonly ref: string; readonly skipped: readonly string[] }
  | { readonly kind: "none"; readonly why: "not a git worktree" | "not a canon project" | "nothing uncommitted" | "same as the last snapshot" };

const who = { GIT_AUTHOR_NAME: "canon", GIT_AUTHOR_EMAIL: "canon@localhost", GIT_COMMITTER_NAME: "canon", GIT_COMMITTER_EMAIL: "canon@localhost" };

/**
 * Records the worktree containing `cwd` (tracked changes and untracked files git does not ignore) as a commit whose
 * parent is HEAD, under `refs/canon/snapshots/<key>/<time>`, unless there is nothing uncommitted or it equals the last
 * snapshot (BR-2182). A copy of the worktree's own index is the starting point, so unchanged files are not hashed
 * again and the worktree's index and files are never touched.
 */
export function takeSnapshot(cwd: string, now: Date = new Date()): Result<TakeOutcome> {
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (!top.ok) return ok({ kind: "none", why: "not a git worktree" });
  const root = top.value;
  if (!existsSync(join(root, "canon", "config.yaml"))) return ok({ kind: "none", why: "not a canon project" });
  // reason: without --no-optional-locks, git status refreshes the index under .git/index.lock, so a hook before every
  // Bash call would make a git command running at the same moment (a landing's ff-merge, a commit) fail on that lock (BR-2182, #83).
  const status = git(root, "--no-optional-locks", "status", "--porcelain");
  if (!status.ok) return status;
  if (status.value === "") return ok({ kind: "none", why: "nothing uncommitted" });

  const listed = (args: string[]) => {
    const r = git(root, "-c", "core.quotePath=false", "ls-files", "-z", ...args);
    return r.ok ? r.value.split("\0").filter(Boolean) : [];
  };
  const skipped = [...new Set([...listed(["--others", "--exclude-standard"]), ...listed(["--modified"])])].filter((p) => {
    try {
      return statSync(join(root, p)).size > MAX_FILE_BYTES;
    } catch {
      return false; // deleted since the listing: nothing to read
    }
  }).sort();

  const head = git(root, "rev-parse", "--verify", "-q", "HEAD^{commit}");
  const scratch = mkdtempSync(join(tmpdir(), "canon-snapshot-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    const own = git(root, "rev-parse", "--git-path", "index");
    if (!own.ok) return own;
    const ownPath = isAbsolute(own.value) ? own.value : join(root, own.value);
    if (existsSync(ownPath)) copyFileSync(ownPath, env.GIT_INDEX_FILE);
    else if (head.ok) {
      const r = gitEnv(root, env, "read-tree", head.value);
      if (!r.ok) return r;
    }
    const add = gitEnv(root, env, "add", "-A");
    if (!add.ok) return add;
    if (skipped.length > 0) {
      // reason: back to HEAD's version (or out, for an untracked file) in the scratch index only (BR-2182)
      const back = head.ok ? gitEnv(root, env, "reset", "-q", head.value, "--", ...skipped) : gitEnv(root, env, "rm", "-q", "--cached", "--", ...skipped);
      if (!back.ok) return back;
    }
    const tree = gitEnv(root, env, "write-tree");
    if (!tree.ok) return tree;

    const key = snapshotKey(root);
    const last = latest(root, key);
    const headTree = head.ok ? git(root, "rev-parse", `${head.value}^{tree}`) : undefined;
    if ((last && last.tree === tree.value) || (headTree?.ok && headTree.value === tree.value)) return ok({ kind: "none", why: "same as the last snapshot" });

    const message = [`canon: snapshot of ${key} before a Bash call`, ...(skipped.length ? ["", `left out, larger than ${MAX_FILE_BYTES} bytes: ${skipped.join(", ")}`] : [])].join("\n");
    const commit = gitEnv(root, { ...who, GIT_COMMITTER_DATE: now.toISOString(), GIT_AUTHOR_DATE: now.toISOString() }, "commit-tree", tree.value, ...(head.ok ? ["-p", head.value] : []), "-m", message);
    if (!commit.ok) return commit;
    const ref = `${SNAPSHOT_REFS}/${key}/${now.toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
    const made = git(root, "update-ref", ref, commit.value, ""); // "" = create only, never overwrite a snapshot
    if (!made.ok) return made;
    const pruned = prune(root, now);
    if (!pruned.ok) return pruned;
    return ok({ kind: "taken", ref, skipped });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface Snapshot {
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly at: string;
}

/** A worktree's snapshots, newest first (ref names sort by the time in them). */
export function snapshots(root: string, key: string): Snapshot[] {
  const r = git(root, "for-each-ref", "--sort=-refname", "--format=%(refname) %(objectname) %(tree) %(creatordate:iso-strict)", key === "" ? `${SNAPSHOT_REFS}/` : `${SNAPSHOT_REFS}/${key}/`);
  if (!r.ok || r.value === "") return [];
  return r.value.split("\n").map((l) => {
    const [ref, commit, tree, at] = l.split(" ");
    return { ref: ref!, commit: commit!, tree: tree!, at: at! };
  });
}

const latest = (root: string, key: string) => snapshots(root, key)[0];

/** Applies the keeping policy to every worktree's snapshots, deleting in one ref transaction (BR-2183). */
function prune(root: string, now: Date): Result<void> {
  const hour = 3_600_000;
  const recent = now.getTime() - KEEP_ALL_HOURS * hour;
  const cutoff = now.getTime() - MAX_AGE_DAYS * 24 * hour;
  const seen = new Set<string>();
  const doomed: string[] = [];
  // Newest first, so the first one met in an hour is the one that stays.
  for (const s of snapshots(root, "")) {
    const t = Date.parse(s.at);
    if (t >= recent) continue;
    const bucket = `${s.ref.slice(SNAPSHOT_REFS.length + 1, s.ref.lastIndexOf("/"))} ${Math.floor(t / hour)}`;
    if (t < cutoff || seen.has(bucket)) doomed.push(s.ref);
    else seen.add(bucket);
  }
  if (doomed.length === 0) return ok(undefined);
  const r = Bun.spawnSync(["git", "update-ref", "--stdin"], { cwd: root, stdin: new TextEncoder().encode(doomed.map((d) => `delete ${d}\n`).join("")), stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? ok(undefined) : err("io", `cannot delete ${doomed.length} old snapshot(s): ${r.stderr.toString().trim()}`);
}

/** The files a snapshot holds that differ from the commit it was taken on. */
export function changedFiles(root: string, s: Snapshot): string[] {
  const parent = git(root, "rev-parse", "--verify", "-q", `${s.commit}^`);
  const r = parent.ok
    ? git(root, "-c", "core.quotePath=false", "diff", "--name-only", "-z", parent.value, s.commit)
    : git(root, "-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", s.commit);
  return r.ok ? r.value.split("\0").filter(Boolean) : [];
}

/** The message's "left out" line, if the snapshot left files out. */
export function leftOut(root: string, s: Snapshot): string | undefined {
  const r = git(root, "log", "-1", "--format=%b", s.commit);
  return r.ok ? r.value.split("\n").find((l) => l.startsWith("left out")) : undefined;
}
