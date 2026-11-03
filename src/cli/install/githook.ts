import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import { LAND_MARKER } from "../../work/land/land.ts";

/**
 * The git hook that makes `canon work land` the only way main moves (BR-2123, D-16). git runs a
 * `reference-transaction` hook for every ref update; in the `prepared` state a non-zero exit aborts the
 * transaction, so a plain `git commit`, `git merge`, `git update-ref` or `git push .` onto main is refused
 * before anything is written. `canon work land` passes by naming the commit it moves main to in
 * LAND_MARKER (BR-2125). The hook lives in the repository's hooks directory, which is not tracked: it is
 * installed straight into place, not landed as a change.
 */
/** The line that tells canon's hook apart from anyone else's, so canon can replace its own and never another's. */
export const GUARD_HEADER = "# canon: reference-transaction guard. Written by `canon install`; canon replaces this file, so change it in canon.";
const NAME = "reference-transaction";

/** The hook script for a project whose main branch is `main`. */
export function guardScript(main: string): string {
  if (!/^[A-Za-z0-9._\/-]+$/.test(main)) throw new Error(`main branch name ${JSON.stringify(main)} cannot be written into the hook`);
  return `#!/bin/sh
${GUARD_HEADER}
# main moves only through \`canon work land\` (BR-2123, D-16).
[ "$1" = prepared ] || exit 0
status=0
while read -r old new ref; do
  [ "$ref" = "refs/heads/${main}" ] || continue
  # a deletion, including pack-refs removing the loose copy, puts nothing on main
  case "$new" in *[!0]*) ;; *) continue ;; esac
  # main does not exist yet: the repository's first commit
  cur=$(git rev-parse -q --verify "$ref^{commit}" 2>/dev/null) || continue
  # no-op rows (git reset to the same commit, pack-refs) move nothing
  [ "$new" = "$cur" ] && continue
  # before canon is on main there is nothing to land through (canon init's own commit)
  git cat-file -e "$cur:canon/config.yaml" 2>/dev/null || continue
  [ "$new" = "\${${LAND_MARKER}:-}" ] && continue
  echo "canon: refusing to move ${main}: in this project ${main} moves only through canon work land. Do the work in a change (canon work start), commit it there, then run canon work land." >&2
  status=1
done
exit $status
`;
}

/** Where git looks for hooks: core.hooksPath when set, else the common .git/hooks (shared by every worktree). */
export function hooksDir(root: string): Result<string> {
  return git(root, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
}

/** current: canon's hook as this canon writes it; missing/old: an install writes it; foreign: someone else's hook, never overwritten. */
export type GuardState = "current" | "missing" | "old" | "foreign";

export function guardStatus(root: string, main: string): Result<{ state: GuardState; path: string }> {
  const dir = hooksDir(root);
  if (!dir.ok) return dir;
  const path = join(dir.value, NAME);
  if (!existsSync(path) && !isLink(path)) return ok({ state: "missing", path });
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return ok({ state: "foreign", path });
  const text = readFileSync(path, "utf8");
  if (text.split("\n")[1] !== GUARD_HEADER) return ok({ state: "foreign", path });
  const executable = (statSync(path).mode & 0o111) !== 0;
  return ok({ state: text === guardScript(main) && executable ? "current" : "old", path });
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The refusal for a hook canon did not write (BR-2124); checked before an install writes anything. */
export function foreignGuard(path: string): Result<never> {
  return err("conflict", `${path} exists and was not written by canon; canon will not overwrite it. Remove it or move what it does elsewhere, then run again (canon's guard keeps main moving only through canon work land).`);
}

/** Writes canon's hook; true when it changed anything. Refuses someone else's hook (BR-2124). */
export function ensureGuard(root: string, main: string): Result<boolean> {
  const st = guardStatus(root, main);
  if (!st.ok) return st;
  if (st.value.state === "current") return ok(false);
  if (st.value.state === "foreign") return foreignGuard(st.value.path);
  mkdirSync(join(st.value.path, ".."), { recursive: true });
  // reason: git may run the hook at any moment; a temporary file made executable and renamed into place means it
  // only ever sees the old hook or the whole new one, never an empty, half-written or not-yet-executable one (#24)
  const tmp = `${st.value.path}.canon-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, guardScript(main), { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, st.value.path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return ok(true);
}
