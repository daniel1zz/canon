import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import { LAND_MARKER } from "../../work/land/finish/finish.ts";

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

/**
 * The hook script for a project whose main branch is `main`, a name git accepts (checked by guardStatus). The name is
 * written inside double quotes, so the characters the shell still reads there (`$`, backquote, `"`, backslash) are escaped.
 */
export function guardScript(main: string): string {
  // reason: names of letters, digits and ._/- come out byte for byte as before, so installed guards stay current (BR-2123)
  const name = main.replace(/[$`"\\]/g, (c) => `\\${c}`);
  return `#!/bin/sh
${GUARD_HEADER}
# main moves only through \`canon work land\` (BR-2123, D-16).
[ "$1" = prepared ] || exit 0
status=0
while read -r old new ref; do
  [ "$ref" = "refs/heads/${name}" ] || continue
  # a deletion, including pack-refs removing the loose copy, puts nothing on main
  case "$new" in *[!0]*) ;; *) continue ;; esac
  # main does not exist yet: the repository's first commit
  cur=$(git rev-parse -q --verify "$ref^{commit}" 2>/dev/null) || continue
  # no-op rows (git reset to the same commit, pack-refs) move nothing
  [ "$new" = "$cur" ] && continue
  # before canon is on main there is nothing to land through (canon init's own commit)
  git cat-file -e "$cur:canon/config.yaml" 2>/dev/null || continue
  [ "$new" = "\${${LAND_MARKER}:-}" ] && continue
  echo "canon: refusing to move ${name}: in this project ${name} moves only through canon work land. Do the work in a change (canon work start), commit it there, then run canon work land." >&2
  status=1
  # git pull, merge --ff-only and reset have already put the refused commit in this checkout's index and working tree;
  # an existing commit (another ref or FETCH_HEAD has it) is put back to main two-way, which keeps uncommitted changes.
  # A new commit (git commit) is the user's own work and stays staged. (BR-2284)
  remote=$(git for-each-ref --format='%(refname)' --contains "$new" refs/remotes 2>/dev/null)
  [ "$(git rev-parse -q --verify FETCH_HEAD 2>/dev/null)" = "$new" ] && remote=FETCH_HEAD
  if [ "$(git symbolic-ref -q HEAD 2>/dev/null)" = "$ref" ] && { [ -n "$remote" ] || git for-each-ref --format='%(refname)' --contains "$new" 2>/dev/null | grep -Fqvx "$ref"; }; then
    if said=$(git read-tree -m -u "$new" "$cur" 2>&1); then
      echo "canon: the index and working tree are back at ${name} ($(git rev-parse --short "$cur")); uncommitted changes are kept." >&2
    else
      echo "canon: could not put the index and working tree back at ${name} ($(git rev-parse --short "$cur")): $said; git status shows what is staged." >&2
    fi
  fi
  if [ -n "$remote" ]; then
    echo "canon: to take in the remote's ${name}, run canon sync." >&2
  fi
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
  // A name git would refuse as a branch is a config error, found before anything is written (BR-2123, BR-2045).
  if (!git(root, "check-ref-format", `refs/heads/${main}`).ok) return err("invalid", `canon/config.yaml: main ${JSON.stringify(main)} is not a valid git branch name; fix it and run again`);
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

/** Whether `path` is a plain file whose second line is canon's marker: a hook canon wrote, of any version (BR-2124). */
function canonsOwn(path: string): boolean {
  try {
    return lstatSync(path).isFile() && readFileSync(path, "utf8").split("\n")[1] === GUARD_HEADER;
  } catch {
    return false;
  }
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * Puts `tmp` at `path` only when nothing is there: link fails with EEXIST instead of replacing, so a hook someone wrote
 * after the state was read is never overwritten (BR-2124, D-36). True when placed, false when `path` was taken.
 */
function placeExclusive(tmp: string, path: string): Result<boolean> {
  try {
    linkSync(tmp, path);
    return ok(true);
  } catch (e) {
    if (code(e) === "EEXIST") return ok(false);
    return err("io", `cannot put canon's guard at ${path} without risking someone else's hook there (${(e as Error).message}); the hooks directory must allow hard links`);
  }
}

/** What to say when `path` was taken while canon was writing it: done if it is now the current guard, else a conflict. */
function takenMeanwhile(root: string, main: string, path: string): Result<boolean> {
  const st = guardStatus(root, main);
  if (!st.ok) return st;
  if (st.value.state === "current") return ok(false);
  if (st.value.state === "foreign") return foreignGuard(path);
  return err("conflict", `${path} changed while canon was writing it; run again`);
}

/**
 * Writes canon's hook; true when it changed anything. Refuses someone else's hook (BR-2124), including one written
 * between reading the state and writing (#25). `beforeReplace` runs at that point; only tests pass it, to stage the race.
 */
export function ensureGuard(root: string, main: string, beforeReplace?: () => void): Result<boolean> {
  const st = guardStatus(root, main);
  if (!st.ok) return st;
  if (st.value.state === "current") return ok(false);
  if (st.value.state === "foreign") return foreignGuard(st.value.path);
  const path = st.value.path;
  mkdirSync(join(path, ".."), { recursive: true });
  // reason: git may run the hook at any moment; a temporary file made executable before it is placed means git never
  // sees an empty, half-written or not-yet-executable hook (#24)
  const tmp = `${path}.canon-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, guardScript(main), { mode: 0o755 });
    chmodSync(tmp, 0o755);
    beforeReplace?.();
    if (st.value.state === "missing") {
      const placed = placeExclusive(tmp, path);
      if (!placed.ok) return placed;
      return placed.value ? ok(true) : takenMeanwhile(root, main, path);
    }
    return replaceOld(root, main, tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Removes canon's guard, of any version, for `canon uninstall` (BR-2280); someone else's hook stays. Like replaceOld, the
 * file is first moved aside, which takes exactly what is there at that instant, and only then checked: anyone else's goes
 * back by an exclusive link, so a hook written in between is never deleted (BR-2124, D-36).
 */
export function removeGuard(root: string): Result<"removed" | "absent" | "foreign"> {
  const dir = hooksDir(root);
  if (!dir.ok) return dir;
  const path = join(dir.value, NAME);
  if (!existsSync(path) && !isLink(path)) return ok("absent");
  if (!canonsOwn(path)) return ok("foreign");
  const aside = `${path}.canon-${process.pid}.old`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if (code(e) === "ENOENT") return ok("absent");
    return err("io", `cannot move ${path} aside to remove it: ${(e as Error).message}`);
  }
  if (canonsOwn(aside)) {
    rmSync(aside, { force: true });
    return ok("removed");
  }
  const back = placeExclusive(aside, path);
  if (back.ok && back.value) {
    rmSync(aside, { force: true });
    return ok("foreign");
  }
  return err("conflict", `${path} was replaced by a hook canon did not write while canon was removing its guard, and canon could not put it back; that hook is kept at ${aside}. Put it back where it belongs.`);
}

/**
 * Replaces canon's older guard with `tmp` (D-36). rename has no compare-and-swap, so the file at `path` is first moved
 * aside, which takes exactly what is there at that instant, and checked: canon's own is dropped and the new guard put in
 * its place; anyone else's goes back and the install refuses (BR-2124). Only canon's files are ever deleted.
 */
function replaceOld(root: string, main: string, tmp: string, path: string): Result<boolean> {
  // reason: the old guard can only come back by an exclusive link, so a directory without hard links is found before it
  // is moved; otherwise it would stay aside and leave main unguarded after canon exits (BR-2124, #93)
  const probe = `${path}.canon-${process.pid}.probe`;
  rmSync(probe, { force: true });
  const linkable = placeExclusive(tmp, probe);
  rmSync(probe, { force: true });
  if (!linkable.ok) return linkable;
  const aside = `${path}.canon-${process.pid}.old`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if (code(e) !== "ENOENT") return err("io", `cannot move ${path} aside to replace it: ${(e as Error).message}`);
    // removed since it was read: now it is the missing case
    const placed = placeExclusive(tmp, path);
    if (!placed.ok) return placed;
    return placed.value ? ok(true) : takenMeanwhile(root, main, path);
  }
  if (!canonsOwn(aside)) {
    const back = placeExclusive(aside, path);
    if (back.ok && back.value) {
      rmSync(aside, { force: true });
      return foreignGuard(path);
    }
    return err("conflict", `${path} was replaced by a hook canon did not write while canon was installing its guard, and canon could not put it back${back.ok ? " (the path was taken again)" : ` (${back.error.message})`}; that hook is kept at ${aside}. Put it back where it belongs, then run again.`);
  }
  const placed = placeExclusive(tmp, path);
  if (!placed.ok) {
    // reason: the old guard goes back only by the same exclusive link; checking the path is empty and then renaming
    // would overwrite a hook written in between (BR-2124)
    const back = placeExclusive(aside, path);
    if (back.ok) {
      rmSync(aside, { force: true });
      return placed;
    }
    return err("io", `${placed.error.message}; canon's older guard was moved aside and could not be put back, it is kept at ${aside}`);
  }
  rmSync(aside, { force: true });
  return placed.value ? ok(true) : takenMeanwhile(root, main, path);
}
