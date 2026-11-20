import { err, ok, type Result } from "../../../kernel/result.ts";
import { testFilesFor } from "../../../knowledge/check/tests.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { reportsFor } from "../../verify/changes.ts";
import { runTestFile } from "../../verify/verify.ts";
import { readWorkConfig, type Workspace } from "../../workspace.ts";

/** A test file the landing ran itself, and how that run ended. */
export interface LandingRun {
  readonly file: string;
  readonly exitCode: number;
  readonly output: string;
}

/**
 * Runs `files` one at a time with `test_command` in `wt`, which records each one's report for its content there (BR-2337),
 * and stops at the first that fails. Nothing runs without a `test_command`. `groups` holds the running file's process group,
 * so a lander stopped by a signal can stop it too.
 */
export async function runLandingTests(at: Pick<Workspace, "db">, wt: string, testCommand: string | undefined, files: readonly string[], groups: Set<number> = new Set()): Promise<LandingRun[]> {
  if (!testCommand) return [];
  const runs: LandingRun[] = [];
  for (const file of files) {
    const r = await runTestFile({ root: wt, db: at.db }, testCommand, file, groups);
    runs.push({ file, exitCode: r.exitCode, output: r.output });
    if (r.exitCode !== 0) break;
  }
  return runs;
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
