import { existsSync, readFileSync, statSync } from "node:fs";
import { changeIdsOnBranches, listedOnMain } from "../session/inflight.ts";
import { basename, join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import { FILE_PLACEHOLDER } from "./config-keys.ts";
import { backlogNotes, check, noteLine } from "../../knowledge/check/check.ts";
import { testFilesFor } from "../../knowledge/check/tests.ts";
import { testTitles } from "../../knowledge/check/test-titles.ts";
import { budgetHint, sessionText } from "../../knowledge/check/session-text.ts";
import { WORKFLOW_GUIDE } from "../../cli/guide.ts";
import { importedPaths } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { idsIn } from "../../knowledge/documents/types.ts";
import { openNotes, renderNote } from "../../knowledge/review/notes.ts";
import { claimOfWorktree } from "../claims/claims.ts";
import type { Workspace } from "../workspace.ts";

/**
 * `canon work test` (BR-2157, BR-2158, BR-2159, D-23): before landing, run only the test files this change can
 * break, one file per run of the project's `test_command`, instead of the full suite the floor runs anyway.
 */

const JS_TS = /\.[cm]?[jt]sx?$/;

export interface Selected {
  readonly file: string;
  /** Why it runs: "changed", "imports …", "names BR-n", "always", or "--all". */
  readonly reasons: readonly string[];
}

export interface Selection {
  /** The commit the change is compared against: the merge base of HEAD and main. */
  readonly base: string;
  /** Repo paths changed since `base`: committed, uncommitted and untracked, deleted ones included. */
  readonly changed: readonly string[];
  /** Rule ids whose files changed, plus the `rules:` of changed change files. */
  readonly rules: readonly string[];
  /** Decision ids whose files changed, added or deleted ones included (BR-2249). */
  readonly decisions: readonly string[];
  readonly selected: readonly Selected[];
  /** `always_tests` globs that match no test file `tests` finds (BR-2297). */
  readonly unmatched: readonly string[];
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
function changesOf(ws: Workspace): Result<{ base: string; changed: string[]; rules: string[]; decisions: string[] }> {
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
  const decisionType = ws.config.types.find((t) => t.name === "decision")!;
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
 * The test files to run and why (BR-2157): changed test files; test files whose relative imports reach a changed
 * file, directly or through other source files (the import reading of `canon context`, BR-2119); test files whose
 * running titles name a touched rule. With `all`, every test file (BR-2159).
 */
export function selectTests(ws: Workspace, all: boolean): Result<Selection> {
  const ch = changesOf(ws);
  if (!ch.ok) return ch;
  const { base, changed, rules, decisions } = ch.value;
  const tests = testFilesFor(ws.root, ws.config).filter((f) => isFile(join(ws.root, f)));
  const globs = ws.config.alwaysTests.map((g) => ({ g, glob: new Bun.Glob(g) }));
  const always = new Set(tests.filter((f) => globs.some(({ glob }) => glob.match(f))));
  const unmatched = globs.filter(({ glob }) => !tests.some((f) => glob.match(f))).map(({ g }) => g);
  if (all) return ok({ base, changed, rules, decisions, unmatched, selected: tests.map((file) => ({ file, reasons: ["--all"] })) });

  const changedSet = new Set(changed);
  const ruleSet = new Set(rules);
  // reason: an import written `./a` or `./a.js` must still reach the deleted `a.ts`, so a deleted file resolves as if it were there (BR-2157, issue #53)
  const deleted = new Set(changed.filter((p) => !existsSync(join(ws.root, p))));
  const exists = (p: string) => deleted.has(p) || isFile(join(ws.root, p));
  const importsOf = new Map<string, string[]>();
  const importsFrom = (file: string): string[] => {
    let v = importsOf.get(file);
    if (!v) {
      v = JS_TS.test(file) && isFile(join(ws.root, file)) ? importedPaths(ws.root, file, exists) : [];
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
    if (always.has(file)) reasons.push("always");
    if (reasons.length) selected.push({ file, reasons });
  }
  return ok({ base, changed, rules, decisions, unmatched, selected });
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

/** Runs one shell command in `root`, capturing its exit code, time and combined output. */
async function runShell(root: string, command: string): Promise<{ exitCode: number; ms: number; output: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn(["sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, ms: Math.round(performance.now() - t0), output: `${stdout}${stderr}` };
}

/** Runs one test file per invocation of `test_command` (BR-2158), reporting each as it finishes. */
export async function runTests(root: string, template: string, files: readonly string[], each: (r: TestRun) => void): Promise<TestRun[]> {
  const out: TestRun[] = [];
  for (const file of files) {
    const r = { file, ...(await runShell(root, commandFor(template, file))) };
    out.push(r);
    each(r);
  }
  return out;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** Lines of a failing file's output shown under it; the rest is in the run itself. */
const TAIL_LINES = 40;

export interface WorkTestResult {
  readonly files: number;
  readonly failed: number;
  /** Exit code of `typecheck_command`, null when the project sets none (BR-2226). */
  readonly typecheck: number | null;
  /** Number of `canon check` findings in the worktree (BR-2227). */
  readonly check: number;
  /** Number of `always_tests` globs that match no test file (BR-2297). */
  readonly unmatched: number;
}

/** True when `canon work test` must exit 1: a test file, the type check or canon check failed. */
export const workTestFailed = (r: WorkTestResult) => r.failed > 0 || (r.typecheck !== null && r.typecheck !== 0) || r.check > 0 || r.unmatched > 0;

/**
 * `canon work test` end to end: select, explain, type-check (BR-2226), run, canon check (BR-2227), summarize.
 * The type check runs first and the corpus check last, even when nothing is selected or an earlier step failed,
 * so one run reports every problem the floor or the landing check would refuse.
 */
export async function workTest(ws: Workspace, all: boolean, say: (line: string) => void): Promise<Result<WorkTestResult>> {
  if (!ws.config.testCommand) {
    return err("invalid", `canon/config.yaml has no \`test_command\`: set the command that runs one test file, with ${FILE_PLACEHOLDER} where its path goes (e.g. test_command: "bun test ${FILE_PLACEHOLDER}")`);
  }
  const sel = selectTests(ws, all);
  if (!sel.ok) return sel;
  const { base, changed, rules, decisions, selected, unmatched } = sel.value;
  const against = `against ${ws.config.main} at ${base.slice(0, 9)}`;
  if (all) say(`canon work test --all: every test file, ${selected.length} (${against})`);
  else {
    say(`canon work test: ${selected.length} test file(s) related to this change (${against}; ${changed.length} changed file(s)${rules.length ? `; rules ${rules.join(", ")}` : ""})`);
    say("Selected: changed test files, test files whose relative imports reach a changed file, test files whose titles name a touched rule, test files always_tests names.");
    const width = Math.max(0, ...selected.map((s) => s.file.length));
    for (const s of selected) say(`  ${s.file.padEnd(width)}  ${s.reasons.join("; ")}`);
    say("Not selected: tests that only read changed files at run time; canon work test --all runs every test file.");
  }
  const subject = claimOfWorktree(ws.db, ws.root)?.subject ?? null;
  const t0 = performance.now();
  const tail = (output: string) => {
    for (const line of output.trimEnd().split("\n").slice(-TAIL_LINES)) say(`    ${line}`);
  };

  let typecheck: number | null = null;
  if (ws.config.typecheckCommand) {
    const r = await runShell(ws.root, ws.config.typecheckCommand);
    typecheck = r.exitCode;
    say(`${r.exitCode === 0 ? "pass" : "FAIL"}  ${secs(r.ms).padStart(6)}  typecheck${r.exitCode === 0 ? "" : ` (exit ${r.exitCode})`}`);
    if (r.exitCode !== 0) tail(r.output);
  }

  let runs: TestRun[] = [];
  if (selected.length === 0) say("nothing to run");
  else {
    runs = await runTests(ws.root, ws.config.testCommand, selected.map((s) => s.file), (r) => {
      say(`${r.exitCode === 0 ? "pass" : "FAIL"}  ${secs(r.ms).padStart(6)}  ${r.file}${r.exitCode === 0 ? "" : ` (exit ${r.exitCode})`}`);
      if (r.exitCode !== 0) tail(r.output);
    });
  }
  const failed = runs.filter((r) => r.exitCode !== 0);

  // The same check as `canon check`, on the worktree's files (BR-2227).
  const read = readCorpus(ws.root, ws.config.types, ws.config);
  const onBranches = changeIdsOnBranches(ws);
  if (!onBranches.ok) return onBranches;
  const onMain = listedOnMain(ws);
  if (!onMain.ok) return onMain;
  const input = { root: ws.root, ...read, testFiles: testFilesFor(ws.root, ws.config), floorSkipPaths: ws.config.floorSkipPaths, branchChanges: onBranches.value, backlogBase: onMain.value };
  const findings = check(input);
  for (const f of findings) say(`${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
  for (const n of backlogNotes(input)) say(noteLine(n)); // never a failure (BR-2150, #112)
  say(findings.length === 0 ? "canon check: ok" : `canon check: ${findings.length} finding(s)`);
  // A hint on standard error, never a failure (BR-2257, D-37).
  const hint = budgetHint(sessionText(ws.root, WORKFLOW_GUIDE), ws.config.sessionTextBudget);
  if (hint) console.error(hint);

  // Open review notes on what this change touches, the ones canon context shows; a hint, never a failure (BR-2249, D-21).
  const notes = openNotes(ws.db, [...rules, ...decisions]);
  if (notes.length) {
    say("Open review notes on the rules and decisions this change touches (a hint, not a failure; handle them in this change):");
    for (const n of notes) say(`Open review note on ${renderNote(n)}`);
  }

  const ms = Math.round(performance.now() - t0);
  // reason: a glob that matches nothing stopped protecting anything, which must not pass unnoticed (BR-2297)
  for (const g of unmatched) say(`always_tests: ${JSON.stringify(g)} matches no test file`);
  const result: WorkTestResult = { files: runs.length, failed: failed.length, typecheck, check: findings.length, unmatched: unmatched.length };
  if (runs.length) say(`${runs.length} file(s): ${runs.length - failed.length} passed, ${failed.length} failed, ${secs(ms)}`);
  if (failed.length) say(`failed: ${failed.map((r) => r.file).join(", ")}`);
  if (typecheck !== null && typecheck !== 0) say(`typecheck failed (exit ${typecheck})`);
  if (findings.length) say(`canon check failed: ${findings.length} finding(s)`);
  // reason: a run that selected nothing is still a run before landing, which D-23 compares with floor refusals (BR-2158)
  ws.db.event(ws.actor, "work.test", subject, { all, ...result, ms });
  return ok(result);
}
