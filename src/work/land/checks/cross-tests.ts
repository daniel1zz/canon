import { git } from "../../../kernel/git.ts";
import { ok, type Result } from "../../../kernel/result.ts";
import { runSelectCommand } from "../../verify/select-command.ts";

/** Why a landing's cross tests run: the paths both sides changed, and the test files both sides' selections share (BR-2645). */
export interface Cross {
  /** The test files to run on the tree being landed: what test_select_command picks for main's side; empty when nothing overlaps. */
  readonly files: string[];
  /** Paths changed on main since the fork and on this branch too. */
  readonly sharedPaths: string[];
  /** Test files test_select_command picks for both sides. */
  readonly sharedTests: string[];
}

const changedBetween = (wt: string, from: string, to: string): Result<string[]> => {
  const d = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", from, to);
  return d.ok ? ok(d.value.split("\n").filter(Boolean)) : d;
};
const picked = (wt: string, command: string, paths: readonly string[], tests: ReadonlySet<string>): Result<Set<string>> => {
  if (paths.length === 0) return ok(new Set());
  const r = runSelectCommand(wt, command, paths, tests);
  return r.ok ? ok(new Set(r.value.chosen.map((c) => c.file))) : r;
};

/**
 * The cross tests of a landing (BR-2645, D-137's heavier step only where it is needed): when main moved since this branch
 * forked and the two sides overlap (a path both changed, or a test file the project's test_select_command picks for both),
 * the test files it picks for main's side. Otherwise none, and the landing goes as usual. No test_select_command, none
 * (canon reads no source, D-64).
 */
export function crossTests(wt: string, before: string, base: string, command: string | undefined, tests: ReadonlySet<string>): Result<Cross> {
  const none: Cross = { files: [], sharedPaths: [], sharedTests: [] };
  if (command === undefined) return ok(none);
  const fork = git(wt, "merge-base", before, base);
  if (!fork.ok) return fork;
  if (fork.value === base) return ok(none);
  const theirs = changedBetween(wt, fork.value, base);
  if (!theirs.ok) return theirs;
  const mine = changedBetween(wt, fork.value, before);
  if (!mine.ok) return mine;
  const sharedPaths = theirs.value.filter((p) => mine.value.includes(p));
  const forTheirs = picked(wt, command, theirs.value, tests);
  if (!forTheirs.ok) return forTheirs;
  const forMine = picked(wt, command, mine.value, tests);
  if (!forMine.ok) return forMine;
  const sharedTests = [...forTheirs.value].filter((f) => forMine.value.has(f)).sort();
  if (sharedPaths.length === 0 && sharedTests.length === 0) return ok(none);
  return ok({ files: [...forTheirs.value].sort(), sharedPaths, sharedTests });
}
