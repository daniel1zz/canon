import { existsSync, readFileSync, statSync } from "node:fs";
import { changeIdsOnBranches, listedBefore } from "../session/inflight.ts";
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
import { groupAlive, stopGroups } from "./stop-groups.ts";
import { availableParallelism } from "node:os";
import { commandsRegisteredIn, namesCommand, pathsBuiltFromDir, type CliDrive, type RegisteredCommand } from "./cli-tests.ts";
import { jobCap, readCpu, startPool, type CpuSample, type CpuState, type FileResult, type Outcome } from "./pool.ts";
import type { Workspace } from "../workspace.ts";

/**
 * `canon work test` (BR-2157, BR-2158, BR-2159, D-23): before landing, run only the test files this change can
 * break, one file per run of the project's `test_command`, instead of the full suite the floor runs anyway.
 */

const JS_TS = /\.[cm]?[jt]sx?$/;

export interface Selected {
  readonly file: string;
  /** Why it runs: "changed", "imports …", "drives canon …", "runs the CLI …", "names BR-n", "always", or "--all". */
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
 * file, directly or through other source files (the import reading of `canon context`, BR-2119); test files that
 * spawn the CLI and name a command whose module, or a file that module imports, changed (D-60); test files whose
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

  // The CLI a test spawns, found from the test's own text and the command table (D-60, BR-2157).
  const tables = new Map<string, RegisteredCommand[]>();
  const tableOf = (entry: string): RegisteredCommand[] => {
    let t = tables.get(entry);
    if (!t) {
      t = [];
      const seen = new Set([entry]);
      const queue = [entry];
      while (queue.length) {
        const cur = queue.shift()!;
        if (JS_TS.test(cur) && isFile(join(ws.root, cur))) t.push(...commandsRegisteredIn(cur, readFileSync(join(ws.root, cur), "utf8")));
        for (const next of importsFrom(cur)) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      tables.set(entry, t);
    }
    return t;
  };
  const cliOf = (file: string, text: string): CliDrive | null => {
    for (const entry of pathsBuiltFromDir(file, text)) {
      if (!JS_TS.test(entry) || !isFile(join(ws.root, entry))) continue;
      const table = tableOf(entry);
      if (table.length) return { entry, driven: table.filter((c) => namesCommand(text, c.words)) };
    }
    return null;
  };
  /** The changed files a spawned CLI runs: from its entry file, and from the module of each command the test names. */
  const cliReasons = (cli: CliDrive): string[] => {
    const modules = new Set(tableOf(cli.entry).map((c) => c.module));
    const seeds = new Map<string, string>([[cli.entry, "runs the CLI"]]);
    for (const m of new Set(cli.driven.map((c) => c.module))) {
      seeds.set(m, `drives ${cli.driven.filter((c) => c.module === m).map((c) => `canon ${c.words.join(" ")}`).join(", ")}`);
    }
    const out: string[] = [];
    for (const [start, label] of seeds) {
      const via = new Map<string, string | null>([[start, null]]);
      const queue = [start];
      const reached: string[] = changedSet.has(start) ? [start] : [];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const next of importsFrom(cur)) {
          // reason: only the command table (a file that registers no command) imports every command module; following it would select each CLI test for each command's change. Commands import each other for helpers, and that is followed (D-60)
          if (via.has(next) || (modules.has(next) && !modules.has(cur))) continue;
          via.set(next, cur);
          if (changedSet.has(next)) reached.push(next);
          queue.push(next);
        }
      }
      for (const target of reached) {
        const chain: string[] = [];
        for (let p = via.get(target) ?? null; p; p = via.get(p) ?? null) chain.unshift(p);
        out.push(`${label} (${target} changed${chain.length ? `, through ${chain.join(" → ")}` : ""})`);
      }
    }
    return out;
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

    if (JS_TS.test(file)) {
      const cli = cliOf(file, readFileSync(join(ws.root, file), "utf8"));
      if (cli) reasons.push(...cliReasons(cli));
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

/** `test_command` with `{file}` replaced by the path, quoted for sh. */
export function commandFor(template: string, file: string): string {
  return template.replaceAll(FILE_PLACEHOLDER, `'${file.replaceAll("'", `'\\''`)}'`);
}

/**
 * Runs one shell command in `root`, in a process group of its own so a stop reaches all it started (BR-2304), capturing
 * its exit code, time and combined output. `groups` holds the group's leader while it runs.
 */
async function runShell(root: string, command: string, groups: Set<number>): Promise<Outcome> {
  const t0 = performance.now();
  const proc = Bun.spawn(["sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  groups.add(proc.pid);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  // reason: a group that still has members (a background process the file left) stays, so a stop signal reaches it; dead ones are dropped, so a reused pid is never signalled (BR-2304)
  for (const g of [...groups]) if (!groupAlive(g)) groups.delete(g);
  // reason: sh reports a command killed by a signal as 128 + the signal's number (BR-2304)
  const signalled = ["SIGHUP", "SIGINT", "SIGTERM"].includes(String(proc.signalCode)) || [129, 130, 143].includes(exitCode);
  return { exitCode, ms: Math.round(performance.now() - t0), output: `${stdout}${stderr}`, signalled };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** Lines of a failing file's output shown under it; the rest is in the run itself. */
const TAIL_LINES = 40;
/** The most files that failed while others ran that are run alone again; more are not (BR-2303). */
export const RERUN_MAX = 3;
const EXIT_OF_SIGNAL: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export interface WorkTestResult {
  /** Files with a final result, each counted once; a rerun alone does not add one (BR-2158). */
  readonly files: number;
  readonly failed: number;
  /** Exit code of `typecheck_command`, null when the project sets none (BR-2226). */
  readonly typecheck: number | null;
  /** Number of `canon check` findings in the worktree (BR-2227). */
  readonly check: number;
  /** Number of `always_tests` globs that match no test file (BR-2297). */
  readonly unmatched: number;
  /** The signal that stopped the run, when one did (BR-2304). */
  readonly signal?: string;
}

/** True when `canon work test` must exit 1: a test file, the type check or canon check failed. */
export const workTestFailed = (r: WorkTestResult) => r.signal !== undefined || r.failed > 0 || (r.typecheck !== null && r.typecheck !== 0) || r.check > 0 || r.unmatched > 0;

/** What `workTest` needs from the machine, so tests can give a machine that is idle, busy or stopped (BR-2302, BR-2304). */
export interface WorkTestDeps {
  readonly readCpu: () => CpuSample | undefined;
  readonly tickMs: number;
  readonly graceMs: number;
  readonly parallelism: () => number;
  readonly signals: { on(s: NodeJS.Signals, f: (s: NodeJS.Signals) => void): unknown; off(s: NodeJS.Signals, f: (s: NodeJS.Signals) => void): unknown };
  /** Stops the process groups of the commands still running (BR-2304); `hurried` turns true on a second signal. */
  readonly stop: (groups: readonly number[], hurried: () => boolean) => Promise<string | undefined>;
  readonly exit: (code: number) => void;
}

export const machineDeps: WorkTestDeps = {
  readCpu,
  tickMs: 2000,
  graceMs: 500,
  parallelism: availableParallelism,
  signals: process,
  stop: (groups, hurried) => stopGroups(groups, hurried),
  exit: (code) => process.exit(code),
};

const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * `canon work test` end to end: select, explain, type-check (BR-2226), run, canon check (BR-2227), summarize.
 * The type check runs first and the corpus check last, even when nothing is selected or an earlier step failed,
 * so one run reports every problem the floor or the landing check would refuse.
 */
export async function workTest(ws: Workspace, all: boolean, say: (line: string) => void, deps: WorkTestDeps = machineDeps): Promise<Result<WorkTestResult>> {
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
    say("Selected: changed test files, test files whose relative imports reach a changed file, test files that spawn the CLI and drive a command whose code changed, test files whose titles name a touched rule, test files always_tests names.");
    const width = Math.max(0, ...selected.map((s) => s.file.length));
    for (const s of selected) say(`  ${s.file.padEnd(width)}  ${s.reasons.join("; ")}`);
    say("Not selected: tests that only read changed files at run time; canon work test --all runs every test file.");
  }
  const subject = claimOfWorktree(ws.db, ws.root)?.subject ?? null;
  const t0 = performance.now();
  const tail = (output: string) => {
    for (const line of output.trimEnd().split("\n").slice(-TAIL_LINES)) say(`    ${line}`);
  };
  const testCommand = ws.config.testCommand;
  const files = selected.map((s) => s.file);
  const cap = jobCap(ws.config.testJobs, deps.parallelism());

  // What a stop signal needs to know (BR-2304): the files with a final result, and the ones running now.
  const finalized = new Map<string, FileResult>();
  let running: () => number = () => 0;
  const groups = new Set<number>();
  let typecheck: number | null = null;
  let jobs = { peak: 0, cpu: "ok" as CpuState, stalledWindows: 0 };
  let signal: NodeJS.Signals | undefined;
  let hurried = false;
  const failedNow = () => [...finalized.values()].filter((r) => r.exitCode !== 0).length;
  let stoppedWith: (r: WorkTestResult) => void = () => {};
  const stoppedP = new Promise<WorkTestResult>((resolve) => {
    stoppedWith = resolve;
  });
  const onSignal = (sig: NodeJS.Signals) => {
    if (signal !== undefined) {
      hurried = true; // a second signal ends the wait at once (BR-2304)
      return;
    }
    signal = sig;
    // reason: everything the stop reports is taken here, before any file can end; later ends are not recorded (BR-2304)
    for (const g of [...groups]) if (!groupAlive(g)) groups.delete(g);
    const were = running();
    const result: WorkTestResult = { files: finalized.size, failed: failedNow(), typecheck, check: 0, unmatched: unmatched.length, signal: sig };
    const notStarted = files.length - finalized.size - were;
    const pids = [...groups];
    void (async () => {
      // reason: whatever fails while stopping or reporting, canon still exits with the signal's code (BR-2304)
      try {
        const note = await deps.stop(pids, () => hurried);
        if (note) say(note);
        say(`stopped by ${sig}: ${were} test file(s) were running, ${notStarted} not started`);
        ws.db.event(ws.actor, "work.test", subject, { all, ...result, jobs: cap, ...jobs, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        console.error(`canon work test: stopping after ${sig} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        deps.exit(EXIT_OF_SIGNAL[sig]!);
        stoppedWith(result);
      }
    })();
  };
  for (const s of STOP_SIGNALS) deps.signals.on(s, onSignal);

  const rerunAlone: string[] = [];
  const passedAlone: string[] = [];
  let rerunSkipped = 0;
  const show = (r: Outcome & { file: string }, alone: boolean) => {
    const ok = r.exitCode === 0;
    say(`${ok ? "pass" : "FAIL"}  ${secs(r.ms).padStart(6)}  ${r.file}${alone ? " (alone)" : ""}${ok ? "" : ` (exit ${r.exitCode})`}`);
    if (!ok) tail(r.output);
  };

  const phases = async (): Promise<void> => {
    if (ws.config.typecheckCommand) {
      const r = await runShell(ws.root, ws.config.typecheckCommand, groups);
      // reason: a type check stopped by the signal has no verdict: nothing is recorded or printed, no later step runs (BR-2304)
      if (signal !== undefined) return;
      typecheck = r.exitCode;
      say(`${r.exitCode === 0 ? "pass" : "FAIL"}  ${secs(r.ms).padStart(6)}  typecheck${r.exitCode === 0 ? "" : ` (exit ${r.exitCode})`}`);
      if (r.exitCode !== 0) tail(r.output);
    }
    if (files.length === 0) {
      say("nothing to run");
      return;
    }
    const first = cap > 1 ? deps.readCpu() : undefined;
    const setting = `test_jobs ${ws.config.testJobs}, ${deps.parallelism()} CPUs`;
    if (cap === 1) say(`test files: one at a time (${setting})`);
    else if (!first) say("test files: one at a time (CPU usage cannot be read)");
    else say(`test files: up to ${cap} at once (${setting}), another one only while at least 1 CPU is idle`);

    const pool = startPool({
      files, cap, first, run: (file) => runShell(ws.root, commandFor(testCommand, file), groups), readCpu: deps.readCpu, tickMs: deps.tickMs, graceMs: deps.graceMs, say,
      stopping: () => signal !== undefined,
      onEnd: (r) => {
        show(r, false);
        // a file that failed while others ran waits for its rerun alone before it has a final result (BR-2303)
        if (r.exitCode === 0 || !r.overlapped) finalized.set(r.file, r);
      },
    });
    running = pool.running;
    const done = await pool.done;
    jobs = { peak: done.peak, cpu: done.cpu, stalledWindows: done.stalledWindows };
    running = () => 0;

    const pending = files.filter((f) => done.results.some((r) => r.file === f && !finalized.has(f)));
    if (pending.length > RERUN_MAX) {
      rerunSkipped = pending.length;
      say(`not rerunning alone: ${pending.length} files failed while other files ran (more than ${RERUN_MAX}), so they count as failed`);
      for (const f of pending) finalized.set(f, done.results.find((r) => r.file === f)!);
    } else if (pending.length > 0) {
      say(`rerunning alone ${pending.length} file(s) that failed while other files ran`);
      for (const f of pending) {
        if (signal !== undefined) return;
        let busy = 1;
        running = () => busy;
        const r = await runShell(ws.root, commandFor(testCommand, f), groups);
        busy = 0;
        if (signal !== undefined) return;
        rerunAlone.push(f);
        if (r.exitCode === 0) passedAlone.push(f);
        show({ ...r, file: f }, true);
        finalized.set(f, { ...r, file: f, overlapped: false });
      }
    }
  };
  const stopped = await Promise.race([phases().then(() => undefined), stoppedP]);
  // reason: a stop that began as the phases ended is still being carried out; its result is the run's (BR-2304)
  const result0 = stopped ?? (signal !== undefined ? await stoppedP : undefined);
  for (const s of STOP_SIGNALS) deps.signals.off(s, onSignal);
  if (result0) return ok(result0);
  const failed = files.filter((f) => finalized.get(f)!.exitCode !== 0);

  // The same check as `canon check`, on the worktree's files (BR-2227).
  const read = readCorpus(ws.root, ws.config.types, ws.config);
  const onBranches = changeIdsOnBranches(ws);
  if (!onBranches.ok) return onBranches;
  const onMain = listedBefore(ws);
  if (!onMain.ok) return onMain;
  const testFiles = testFilesFor(ws.root, ws.config);
  const input = { root: ws.root, ...read, testFiles, floorSkipPaths: ws.config.floorSkipPaths, branchChanges: onBranches.value, backlogBase: onMain.value };
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
  const result: WorkTestResult = { files: files.length, failed: failed.length, typecheck, check: findings.length, unmatched: unmatched.length };
  if (files.length) say(`${files.length} file(s): ${files.length - failed.length} passed, ${failed.length} failed, ${secs(ms)}, at most ${jobs.peak} at once`);
  if (passedAlone.length) say(`failed alongside other files, passed alone: ${passedAlone.join(", ")}`);
  if (failed.length) say(`failed: ${failed.join(", ")}`);
  if (typecheck !== null && typecheck !== 0) say(`typecheck failed (exit ${typecheck})`);
  if (findings.length) say(`canon check failed: ${findings.length} finding(s)`);
  // reason: a run that selected nothing is still a run before landing, which D-23 compares with floor refusals (BR-2158)
  ws.db.event(ws.actor, "work.test", subject, {
    all, ...result, ms, jobs: cap, ...jobs, rerun: rerunAlone.length, rerunFiles: rerunAlone, passedAlone: passedAlone.length, passedAloneFiles: passedAlone, rerunSkipped,
  });
  return ok(result);
}
