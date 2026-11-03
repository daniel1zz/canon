import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import { FILE_PLACEHOLDER } from "../../config/config.ts";
import { testFilesFor } from "../../knowledge/check/tests.ts";
import { testTitles } from "../../knowledge/check/test-titles.ts";
import { importedPaths } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { idsIn } from "../../knowledge/documents/types.ts";
import { claimOfWorktree } from "../claims/claims.ts";
import type { Workspace } from "../workspace.ts";

/**
 * `canon work test` (BR-2157, BR-2158, BR-2159, D-23): before landing, run only the test files this change can
 * break, one file per run of the project's `test_command`, instead of the full suite the floor runs anyway.
 */

const JS_TS = /\.[cm]?[jt]sx?$/;

export interface Selected {
  readonly file: string;
  /** Why it runs: "changed", "imports …", "names BR-n", or "--all". */
  readonly reasons: readonly string[];
}

export interface Selection {
  /** The commit the change is compared against: the merge base of HEAD and main. */
  readonly base: string;
  /** Repo paths changed since `base`: committed, uncommitted and untracked, deleted ones included. */
  readonly changed: readonly string[];
  /** Rule ids whose files changed, plus the `rules:` of changed change files. */
  readonly rules: readonly string[];
  readonly selected: readonly Selected[];
}

/** NUL-separated git output, so paths with spaces or non-ASCII characters come back as written. */
function paths(root: string, ...args: string[]): Result<string[]> {
  const r = git(root, ...args, "-z");
  return r.ok ? ok(r.value.split("\0").filter(Boolean)) : r;
}

function isFile(full: string): boolean {
  return existsSync(full) && statSync(full).isFile();
}

/** The files this worktree changed against main and the rules it touched. */
function changesOf(ws: Workspace): Result<{ base: string; changed: string[]; rules: string[] }> {
  const base = git(ws.root, "merge-base", "HEAD", ws.config.main);
  if (!base.ok) return err("io", `cannot compare with ${ws.config.main}: ${base.error.message}`);
  const diff = paths(ws.root, "diff", "--name-only", "--no-renames", base.value);
  if (!diff.ok) return diff;
  const untracked = paths(ws.root, "ls-files", "--others", "--exclude-standard");
  if (!untracked.ok) return untracked;
  const changed = [...new Set([...diff.value, ...untracked.value])].sort();

  const { corpus } = readCorpus(ws.root, ws.config.types, ws.config);
  const ruleType = ws.config.types.find((t) => t.name === "rule")!;
  const rulePrefix = `${ruleType.prefix}-`;
  const touched = new Set(changed);
  const rules = new Set<string>();
  for (const path of changed) {
    // A deleted rule file is no longer in the corpus; its file name is its id.
    const stem = basename(path).replace(/\.md$/, "");
    if (path.startsWith(`canon/${ruleType.dir}/`) && path.endsWith(".md") && stem.startsWith(rulePrefix)) rules.add(stem);
  }
  for (const d of corpus.docs) {
    if (d.kind === "change" && touched.has(d.path)) for (const r of d.rules) rules.add(r);
  }
  return ok({ base: base.value, changed, rules: [...rules].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) });
}

/**
 * The test files to run and why (BR-2157): changed test files; test files whose relative imports reach a changed
 * file, directly or through other source files (the import reading of `canon context`, BR-2119); test files whose
 * running titles name a touched rule. With `all`, every test file (BR-2159).
 */
export function selectTests(ws: Workspace, all: boolean): Result<Selection> {
  const ch = changesOf(ws);
  if (!ch.ok) return ch;
  const { base, changed, rules } = ch.value;
  const tests = testFilesFor(ws.root, ws.config).filter((f) => isFile(join(ws.root, f)));
  if (all) return ok({ base, changed, rules, selected: tests.map((file) => ({ file, reasons: ["--all"] })) });

  const changedSet = new Set(changed);
  const ruleSet = new Set(rules);
  const importsOf = new Map<string, string[]>();
  const importsFrom = (file: string): string[] => {
    let v = importsOf.get(file);
    if (!v) {
      v = JS_TS.test(file) && isFile(join(ws.root, file)) ? importedPaths(ws.root, file) : [];
      importsOf.set(file, v);
    }
    return v;
  };

  const selected: Selected[] = [];
  for (const file of tests) {
    const reasons: string[] = [];
    if (changedSet.has(file)) reasons.push("changed");

    // Breadth first, so each changed file is reported through its shortest chain of imports.
    const via = new Map<string, string | null>([[file, null]]);
    const queue = [file];
    const reached: string[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of importsFrom(cur)) {
        if (via.has(next)) continue;
        via.set(next, cur);
        if (changedSet.has(next)) reached.push(next);
        queue.push(next);
      }
    }
    for (const target of reached) {
      const chain: string[] = [];
      for (let p = via.get(target) ?? null; p && p !== file; p = via.get(p) ?? null) chain.unshift(p);
      reasons.push(`imports ${target}${chain.length ? ` (through ${chain.join(" → ")})` : ""}`);
    }

    if (ruleSet.size) {
      const text = readFileSync(join(ws.root, file), "utf8");
      // reason: as in canon check, only running titles name a rule in JS/TS; other languages count their whole text (BR-2005)
      const titles = JS_TS.test(file) ? testTitles(text).filter((t) => t.runs).map((t) => t.title) : [text];
      const named = new Set<string>();
      for (const title of titles) for (const id of idsIn(ws.config.types, title)) if (ruleSet.has(id)) named.add(id);
      if (named.size) reasons.push(`names ${[...named].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(", ")}`);
    }
    if (reasons.length) selected.push({ file, reasons });
  }
  return ok({ base, changed, rules, selected });
}

export interface TestRun {
  readonly file: string;
  readonly exitCode: number;
  readonly ms: number;
  /** Combined stdout and stderr of the run. */
  readonly output: string;
}

/** `test_command` with `{file}` replaced by the path, quoted for sh. */
export function commandFor(template: string, file: string): string {
  return template.replaceAll(FILE_PLACEHOLDER, `'${file.replaceAll("'", `'\\''`)}'`);
}

/** Runs one test file per invocation of `test_command` (BR-2158), reporting each as it finishes. */
export async function runTests(root: string, template: string, files: readonly string[], each: (r: TestRun) => void): Promise<TestRun[]> {
  const out: TestRun[] = [];
  for (const file of files) {
    const t0 = performance.now();
    const proc = Bun.spawn(["sh", "-c", commandFor(template, file)], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const r = { file, exitCode, ms: Math.round(performance.now() - t0), output: `${stdout}${stderr}` };
    out.push(r);
    each(r);
  }
  return out;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** Lines of a failing file's output shown under it; the rest is in the run itself. */
const TAIL_LINES = 40;

/** `canon work test` end to end: select, explain, run, summarize. Returns the number of failed files. */
export async function workTest(ws: Workspace, all: boolean, say: (line: string) => void): Promise<Result<{ files: number; failed: number }>> {
  if (!ws.config.testCommand) {
    return err("invalid", `canon/config.yaml has no \`test_command\`: set the command that runs one test file, with ${FILE_PLACEHOLDER} where its path goes (e.g. test_command: "bun test ${FILE_PLACEHOLDER}")`);
  }
  const sel = selectTests(ws, all);
  if (!sel.ok) return sel;
  const { base, changed, rules, selected } = sel.value;
  const against = `against ${ws.config.main} at ${base.slice(0, 9)}`;
  if (all) say(`canon work test --all: every test file, ${selected.length} (${against})`);
  else {
    say(`canon work test: ${selected.length} test file(s) related to this change (${against}; ${changed.length} changed file(s)${rules.length ? `; rules ${rules.join(", ")}` : ""})`);
    say("Selected: changed test files, test files whose relative imports reach a changed file, test files whose titles name a touched rule.");
    const width = Math.max(0, ...selected.map((s) => s.file.length));
    for (const s of selected) say(`  ${s.file.padEnd(width)}  ${s.reasons.join("; ")}`);
    say("Not selected: tests that only read changed files at run time; canon work test --all runs every test file.");
  }
  if (selected.length === 0) {
    say("nothing to run");
    return ok({ files: 0, failed: 0 });
  }
  const t0 = performance.now();
  const runs = await runTests(ws.root, ws.config.testCommand, selected.map((s) => s.file), (r) => {
    say(`${r.exitCode === 0 ? "pass" : "FAIL"}  ${secs(r.ms).padStart(6)}  ${r.file}${r.exitCode === 0 ? "" : ` (exit ${r.exitCode})`}`);
    if (r.exitCode !== 0) for (const line of r.output.trimEnd().split("\n").slice(-TAIL_LINES)) say(`    ${line}`);
  });
  const failed = runs.filter((r) => r.exitCode !== 0);
  const ms = Math.round(performance.now() - t0);
  say(`${runs.length} file(s): ${runs.length - failed.length} passed, ${failed.length} failed, ${secs(ms)}`);
  if (failed.length) say(`failed: ${failed.map((r) => r.file).join(", ")}`);
  ws.db.event(ws.actor, "work.test", claimOfWorktree(ws.db, ws.root)?.subject ?? null, { all, files: runs.length, failed: failed.length, ms });
  return ok({ files: runs.length, failed: failed.length });
}
