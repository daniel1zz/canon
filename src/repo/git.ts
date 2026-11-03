import { err, ok, type Result } from "../kernel/result.ts";

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
