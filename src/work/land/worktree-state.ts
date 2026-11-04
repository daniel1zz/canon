import { existsSync } from "node:fs";
import { git } from "../../kernel/git.ts";

/** `git status --porcelain` lines of the worktree: uncommitted and untracked changes. */
export function changesIn(wt: string): string[] {
  const st = git(wt, "status", "--porcelain");
  if (!st.ok) return [`? (${st.error.message})`];
  return st.value === "" ? [] : st.value.split("\n");
}

/** Whether a rebase stopped midway in `wt` (BR-2099). */
export function rebaseInProgress(wt: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((d) => {
    const p = git(wt, "rev-parse", "--path-format=absolute", "--git-path", d);
    return p.ok && existsSync(p.value);
  });
}

/**
 * A fingerprint of the change's own committed edits: the zero-context diff from its merge base with main to
 * HEAD, outside canon/changes, through `git patch-id`. A rebase onto a newer main leaves it unchanged; editing
 * code changes it. `canon stats` compares a refusal's fingerprint with the later landing's (BR-2068).
 */
export function ownDiffId(wt: string, main: string): string | null {
  const r = Bun.spawnSync(["sh", "-c", `base=$(git merge-base ${JSON.stringify(main)} HEAD) && git diff -U0 "$base" HEAD -- . ':(exclude)canon/changes' | git patch-id --stable`], { cwd: wt, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().trim().split(/\s+/)[0] || "empty";
}
