import { err, ok, type Result } from "../kernel/result.ts";

/** Thin git wrapper. Every call is explicit about its cwd; output is trimmed stdout, failures carry stderr. */
export function git(cwd: string, ...args: string[]): Result<string> {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
