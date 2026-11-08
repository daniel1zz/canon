import { git } from "../../../kernel/git.ts";
import { ok, type Result } from "../../../kernel/result.ts";
import { reportFor } from "../../verify/ledger.ts";
import { runTestFile } from "../../verify/verify.ts";
import type { Workspace } from "../../workspace.ts";

/** A test file the landing ran because its rebase merged main's edits into it, and how that run ended. */
export interface MergedRun {
  readonly file: string;
  readonly exitCode: number;
  readonly output: string;
}

/**
 * The test files this landing changed (`base..head` in `wt`) whose content the rebase changed after the change had
 * tested them: a report is recorded for the file as it was on the branch before the rebase (`before`), none for its
 * content now. Each is run once with `test_command` in `wt`, which records its report for the merged content (BR-2381,
 * #152). A file the change never tested is left alone: canon check refuses it as before (BR-2344).
 */
export async function testMergedFiles(at: Pick<Workspace, "db">, wt: string, testCommand: string | undefined, tests: readonly string[], base: string, head: string, before: string): Promise<Result<MergedRun[]>> {
  if (!testCommand || before === head) return ok([]);
  const diff = git(wt, "diff", "--name-only", "--no-renames", base, head);
  if (!diff.ok) return diff;
  const isTest = new Set(tests);
  const runs: MergedRun[] = [];
  for (const file of diff.value.split("\n").filter((f) => f !== "" && isTest.has(f))) {
    const now = git(wt, "rev-parse", `${head}:${file}`);
    const then = git(wt, "rev-parse", `${before}:${file}`);
    // reason: a file the branch did not have, or one deleted by the landing, has no earlier tested content to carry over (BR-2381)
    if (!now.ok || !then.ok || now.value === then.value) continue;
    if (reportFor(at.db, file, now.value) || !reportFor(at.db, file, then.value)) continue;
    const r = await runTestFile({ root: wt, db: at.db }, testCommand, file, new Set());
    runs.push({ file, exitCode: r.exitCode, output: r.output });
    if (r.exitCode !== 0) break;
  }
  return ok(runs);
}
