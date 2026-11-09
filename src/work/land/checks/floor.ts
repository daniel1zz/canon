import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import type { CoordDb } from "../../db.ts";
import { readReport, REPORT_PLACEHOLDER, type TestCase } from "../../verify/report.ts";
import { recordReport } from "../../verify/ledger.ts";
import { runSelectCommand } from "../../verify/select-command.ts";
import type { Say, Workspace } from "../../workspace.ts";
import { readConfig, type Config } from "../../../invocation/config.ts";
import { testFilesFor } from "../../../knowledge/check/tests.ts";
import { git } from "../../../kernel/git.ts";
import type { Running } from "../outcome.ts";

/** Runs the floor in `cwd`, its whole output in the log `name`; `running` lets a signal stop it (BR-2014, BR-2099). */
export async function runFloor(ws: Workspace, say: Say, cwd: string, name: string, running: Running, command: string = ws.config.floor!): Promise<{ code: number; log: string; tail: string }> {
  say(`floor: ${command}`);
  const log = join(dirname(ws.db.db.filename), "logs", name);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w");
  const notes: string[] = [];
  const code = await floorWithReport(ws.db, ws.config, cwd, command, async (command) => {
    const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: fd, stderr: fd });
    running.floor = proc;
    const exit = await proc.exited;
    running.floor = undefined;
    return exit;
  }, (line) => notes.push(line));
  closeSync(fd);
  if (notes.length) appendFileSync(log, notes.map((n) => `${n}\n`).join(""));
  return { code, log, tail: code === 0 ? "" : readFileSync(log, "utf8").split("\n").slice(-40).join("\n") };
}

/**
 * The paths `base..head` changes, when every one is under a `floor_skip_paths` entry, none is a test file, and the
 * project's `test_select_command` selects no test file for them (BR-2164); undefined when the floor must run, and then
 * `why` is told when that is the command's doing. Renames count on both sides (`--no-renames`).
 */
export function floorSkip(wt: string, base: string, head: string, why: (line: string) => void = () => {}): { paths: string[]; under: string[] } | undefined {
  // reason: the config of the tree that is landing decides, not the one read when the workspace opened, before
  // the rebase onto a main that may have changed floor_skip_paths or tests (BR-2164, issue #40).
  const read = readConfig(wt);
  if (!read.ok) return undefined;
  const config = read.value;
  if (config.floorSkipPaths.length === 0) return undefined;
  const d = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, head);
  if (!d.ok) return undefined;
  const paths = d.value === "" ? [] : d.value.split("\n");
  const under = new Set<string>();
  for (const p of paths) {
    const entry = config.floorSkipPaths.find((e) => p === e || p.startsWith(`${e}/`));
    if (!entry) return undefined;
    under.add(entry);
  }
  const found = testFilesFor(wt, config);
  if (!found.ok) return undefined;
  const tests = new Set(found.value);
  if (paths.some((p) => tests.has(p) || isTestPath(config, p))) return undefined;
  // reason: whether a test reads these files is the project's to say, and canon asks before it skips (BR-2164, D-64)
  if (config.testSelectCommand === undefined) {
    why("floor not skipped: floor_skip_paths is set without test_select_command, so nothing says no test reads these paths");
    return undefined;
  }
  const asked = runSelectCommand(wt, config.testSelectCommand, paths, tests);
  if (!asked.ok) {
    why(`floor not skipped: ${asked.error.message}`);
    return undefined;
  }
  if (asked.value.chosen.length > 0) {
    const first = asked.value.chosen.slice(0, 5).map((c) => `${c.file}${c.reason === "" ? "" : ` (${c.reason})`}`);
    why(`floor not skipped: test_select_command selects ${asked.value.chosen.length} test file(s) for these paths: ${first.join("; ")}${asked.value.chosen.length > 5 ? "; …" : ""}`);
    return undefined;
  }
  return { paths, under: [...under].sort() };
}

/**
 * The `floor_scopes` entry whose command is this landing's floor (BR-2398, D-82): the first one such that every path
 * `base..head` changes lies under its paths or under `floor_skip_paths`, at least one under its paths, and every test
 * file `test_select_command` selects for them lies under its paths. Undefined when the whole floor runs; `why` is told
 * when the command is the reason.
 */
export function floorScope(wt: string, base: string, head: string, why: (line: string) => void = () => {}): { index: number; paths: string[]; command: string } | undefined {
  // reason: the config of the tree that is landing decides, as for floor_skip_paths (BR-2398, BR-2164)
  const read = readConfig(wt);
  if (!read.ok || read.value.floorScopes.length === 0) return undefined;
  const config = read.value;
  const select = config.testSelectCommand;
  if (select === undefined) return undefined;
  const d = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, head);
  if (!d.ok || d.value === "") return undefined;
  const paths = d.value.split("\n");
  const under = (p: string, list: readonly string[]) => list.some((e) => p === e || p.startsWith(`${e}/`));
  const index = config.floorScopes.findIndex((sc) => paths.every((p) => under(p, sc.paths) || under(p, config.floorSkipPaths)) && paths.some((p) => under(p, sc.paths)));
  if (index < 0) return undefined;
  const scope = config.floorScopes[index]!;
  const found = testFilesFor(wt, config);
  if (!found.ok) return undefined;
  const asked = runSelectCommand(wt, select, paths, new Set(found.value));
  if (!asked.ok) {
    why(`floor scope not used: ${asked.error.message}`);
    return undefined;
  }
  const outside = asked.value.chosen.filter((c) => !under(c.file, scope.paths));
  if (outside.length > 0) {
    why(`floor scope not used: test_select_command selects ${outside.length} test file(s) outside ${scope.paths.join(", ")}: ${outside.slice(0, 5).map((c) => c.file).join("; ")}${outside.length > 5 ? "; …" : ""}`);
    return undefined;
  }
  return { index, paths: [...scope.paths], command: scope.command };
}

/** Whether a path matches a configured `tests` glob, so a deleted test file counts too (BR-2164). */
function isTestPath(config: Config, path: string): boolean {
  return (config.tests ?? []).some((g) => new Bun.Glob(g).match(path));
}

/**
 * Runs the floor `command` through `run`; when it holds `{report}`, that is replaced by a temporary path, and once the
 * command ends the JUnit report written there is recorded for each test file in it, read at the blob `HEAD` of `cwd` has
 * (BR-2339, D-64). A report problem fails a floor that passed; a floor that failed keeps its own exit code.
 */
export async function floorWithReport(
  db: CoordDb,
  config: Config,
  cwd: string,
  command: string,
  run: (command: string) => Promise<number>,
  note: (line: string) => void,
): Promise<number> {
  if (!command.includes(REPORT_PLACEHOLDER)) return run(command);
  const dir = mkdtempSync(join(tmpdir(), "canon-report-"));
  try {
    const report = join(dir, "report.xml");
    const code = await run(command.replaceAll(REPORT_PLACEHOLDER, `'${report.replaceAll("'", `'\\''`)}'`));
    const problem = recordFloorReport(db, config, cwd, report, note);
    return code !== 0 || problem === undefined ? code : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Records the floor's report; returns what is wrong with it, undefined when it is recorded. */
function recordFloorReport(db: CoordDb, config: Config, cwd: string, report: string, note: (line: string) => void): string | undefined {
  const fail = (why: string) => {
    note(`canon: floor report: ${why}`);
    return why;
  };
  const read = readReport(report);
  if (!read.ok) {
    return fail(read.error.code === "not_found" ? `the floor wrote no report to its ${REPORT_PLACEHOLDER}; write JUnit XML there, or take ${REPORT_PLACEHOLDER} out of the floor` : `${read.error.message}`);
  }
  const root = realpathSync(cwd);
  const byFile = new Map<string, TestCase[]>();
  for (const c of read.value) {
    if (c.file === undefined) {
      return fail(`a testcase (${c.classname} ${c.name}) has no file attribute: this framework's report cannot name the test file of each test. Take ${REPORT_PLACEHOLDER} out of the floor and record test files with canon work test --all instead`);
    }
    const rel = isAbsolute(c.file) ? relative(root, c.file) : normalize(c.file);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return fail(`a testcase (${c.classname} ${c.name}) names the file ${c.file}, outside the repository`);
    byFile.set(rel, [...(byFile.get(rel) ?? []), c]);
  }
  const found = testFilesFor(cwd, config);
  if (!found.ok) return fail(found.error.message);
  const tests = new Set(found.value);
  let skipped = 0;
  for (const [file, cases] of byFile) {
    if (!tests.has(file)) {
      skipped++;
      continue;
    }
    const blob = git(cwd, "rev-parse", `HEAD:${file}`);
    if (!blob.ok) return fail(`cannot read the content hash of ${file} in the tested tree: ${blob.error.message}`);
    recordReport(db, file, blob.value, cases, "floor");
  }
  if (skipped) note(`canon: floor report: ${skipped} file(s) in the report match no \`tests\` glob and were not recorded`);
  return undefined;
}
