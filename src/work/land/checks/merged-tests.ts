import { err, ok, type Result } from "../../../kernel/result.ts";
import { testFilesFor } from "../../../knowledge/check/tests.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { reportsFor } from "../../verify/changes.ts";
import { availableParallelism } from "node:os";
import { jobCap, readCpu, startPool, type CpuSample } from "../../verify/pool.ts";
import { RERUN_MAX, runTestFile } from "../../verify/verify.ts";
import { readWorkConfig, type Workspace } from "../../workspace.ts";

/** A test file the landing ran itself, and how that run ended. */
export interface LandingRun {
  readonly file: string;
  readonly exitCode: number;
  readonly output: string;
}

/**
 * Runs `files` with `test_command` in `wt`, which records each one's report for its content there (BR-2337), several at
 * once by the rule `canon work test` uses (BR-2302, `test_jobs`); a file that failed while others ran is run again alone
 * before it counts as failed (BR-2303), as `canon work test` does (D-168). Returns every file's final run, in `files`' order.
 * Nothing runs without a `test_command`. `groups` holds the running files' process groups, so a lander stopped by a signal
 * can stop them too.
 */
export async function runLandingTests(at: Pick<Workspace, "db">, wt: string, testCommand: string | undefined, files: readonly string[], groups: Set<number> = new Set(), jobs: number | "auto" = 1, say: (line: string) => void = () => {}, cpu: () => CpuSample | undefined = readCpu): Promise<LandingRun[]> {
  if (!testCommand || files.length === 0) return [];
  const ws = { root: wt, db: at.db };
  const cap = jobCap(jobs, availableParallelism());
  const final = new Map<string, LandingRun>();
  const again: string[] = [];
  const pool = startPool({
    files, cap, first: cap > 1 ? cpu() : undefined, run: (file) => runTestFile(ws, testCommand, file, groups), readCpu: cpu, tickMs: 2000, graceMs: 500, say,
    // reason: a lander stopped by a signal stops the running groups and exits itself (land.ts onSignal); the pool needs no stop of its own
    stopping: () => false,
    onEnd: (r) => {
      if (r.exitCode === 0 || !r.overlapped) final.set(r.file, { file: r.file, exitCode: r.exitCode, output: r.output });
      else again.push(r.file);
    },
  });
  const done = await pool.done;
  // reason: a file that failed while others ran may have failed because of them; alone it gets its verdict, unless too many did (BR-2303)
  if (again.length > RERUN_MAX) {
    for (const f of again) {
      const r = done.results.find((x) => x.file === f)!;
      final.set(f, { file: f, exitCode: r.exitCode, output: r.output });
    }
  } else {
    for (const f of again) {
      const r = await runTestFile(ws, testCommand, f, groups);
      final.set(f, { file: f, exitCode: r.exitCode, output: r.output });
    }
  }
  return files.filter((f) => final.has(f)).map((f) => final.get(f)!);
}

/**
 * BR-2542: the test files the change in the clean worktree `wt` makes relevant (changed by it, or naming a rule it touched,
 * as BR-2344 counts them) that have no report for their content there, sorted, and the worktree's `test_command`.
 */
export function unreportedRelated(ws: Workspace, wt: string): Result<{ files: string[]; testCommand: string | undefined }> {
  const config = readWorkConfig(wt);
  if (!config.ok) return err("invalid", `canon/config.yaml of the worktree cannot be read: ${config.error.message}`);
  const tests = testFilesFor(wt, config.value);
  if (!tests.ok) return tests;
  const corpus = readCorpus(wt, ws.config.types, ws.config).corpus;
  const reports = reportsFor(ws.db, wt, config.value, corpus, tests.value);
  if (!reports.ok) return reports;
  return ok({ files: [...reports.value.relevant].sort(), testCommand: config.value.testCommand });
}

/** The last lines of a failed run's output, for the refusal message. */
export const tail = (output: string, lines = 20): string => output.trimEnd().split("\n").slice(-lines).join("\n");
