import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../../invocation/config.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import type { Corpus } from "../../knowledge/documents/model.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { idsIn } from "../../knowledge/documents/types.ts";
import type { CoordDb } from "../db.ts";
import { loadReports, type TestReports } from "./ledger.ts";

/** What a change touched against main, for `canon work test` (BR-2157) and for the test files `canon check` finds relevant (BR-2344). */

/** NUL-separated git output, so paths with spaces or non-ASCII characters come back as written. */
export function paths(root: string, ...args: string[]): Result<string[]> {
  const r = git(root, ...args, "-z");
  return r.ok ? ok(r.value.split("\0").filter(Boolean)) : r;
}

/** The files this worktree changed against main and the rules it touched. */
export function changesOf(root: string, config: Config, known?: Corpus): Result<{ base: string; changed: string[]; rules: string[]; decisions: string[] }> {
  const base = git(root, "merge-base", "HEAD", config.main);
  if (!base.ok) return err("io", `cannot compare with ${config.main}: ${base.error.message}`);
  const diff = paths(root, "diff", "--name-only", "--no-renames", base.value);
  if (!diff.ok) return diff;
  const untracked = paths(root, "ls-files", "--others", "--exclude-standard");
  if (!untracked.ok) return untracked;
  const changed = [...new Set([...diff.value, ...untracked.value])].sort();

  const corpus = known ?? readCorpus(root, config.types, config).corpus;
  const ruleType = config.types.find((t) => t.name === "rule")!;
  const rulePrefix = `${ruleType.prefix}-`;
  const decisionType = config.types.find((t) => t.name === "decision")!;
  const touched = new Set(changed);
  const rules = new Set<string>();
  const decisions = new Set<string>();
  for (const path of changed) {
    // A deleted rule or decision file is no longer in the corpus; its file name is its id.
    const stem = basename(path).replace(/\.md$/, "");
    if (path.startsWith(`canon/${ruleType.dir}/`) && path.endsWith(".md") && stem.startsWith(rulePrefix)) rules.add(stem);
    if (path.startsWith(`canon/${decisionType.dir}/`) && path.endsWith(".md") && stem.startsWith(`${decisionType.prefix}-`)) decisions.add(stem);
  }
  for (const d of corpus.docs) {
    if (d.kind === "change" && touched.has(d.path)) for (const r of d.rules) rules.add(r);
  }
  const sorted = (ids: Set<string>) => [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return ok({ base: base.value, changed, rules: sorted(rules), decisions: sorted(decisions) });
}


/**
 * What the ledger says about `testFiles` in the tree at `root` (BR-2005), with the files this change makes relevant
 * (BR-2344): the ones it changed, and the ones whose newest report names a rule it touched. On the main branch itself,
 * outside any change, no file is relevant.
 */
export function reportsFor(db: CoordDb, root: string, config: Config, corpus: Corpus, testFiles: readonly string[]): Result<TestReports> {
  // reason: a repository with no commit yet has no change to be relevant to, like the main branch itself (BR-2344)
  if (!git(root, "rev-parse", "--verify", "--quiet", "HEAD").ok) return ok(loadReports(db, root, testFiles));
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (!branch.ok) return branch;
  if (branch.value === config.main) return ok(loadReports(db, root, testFiles));
  const ch = changesOf(root, config, corpus);
  if (!ch.ok) return ch;
  const rules = new Set(ch.value.rules);
  const namesTouched = (names: string) => [...idsIn(config.types, names)].some((id) => rules.has(id));
  return ok(loadReports(db, root, testFiles, { changed: new Set(ch.value.changed), namesTouched }));
}
