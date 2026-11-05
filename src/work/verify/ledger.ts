import type { CoordDb } from "../db.ts";
import { caseNames, type TestCase } from "./report.ts";

/**
 * The ledger of test reports (BR-2337, D-64): for each (test file path, git blob hash of its content) the testcases a
 * report listed, in the coordination database every worktree of the checkout shares.
 */

/** Rows kept per path; the newest is "the last row" other checks fall back to when the current content has none. */
export const ROWS_PER_PATH = 5;

export type ReportSource = "test_command" | "floor";

export interface LedgerRow {
  readonly path: string;
  readonly blob: string;
  readonly cases: readonly TestCase[];
  readonly source: ReportSource;
  readonly recordedAt: string;
}

/** Records the testcases a report listed for `path` at `blob`; a row for the same path and blob is replaced. */
export function recordReport(db: CoordDb, path: string, blob: string, cases: readonly TestCase[], source: ReportSource): void {
  // reason: `file` is not stored: it only routes a floor report's testcases to their test file (D-64)
  const stored = cases.map(({ suites, classname, name, runs, line }) => ({ suites, classname, name, runs, ...(line !== undefined ? { line } : {}) }));
  db.db
    .transaction(() => {
      db.db
        .query(
          "INSERT INTO test_reports(path, blob, cases, source, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, blob) DO UPDATE SET cases = excluded.cases, source = excluded.source, recorded_at = excluded.recorded_at",
        )
        .run(path, blob, JSON.stringify(stored), source, new Date().toISOString());
      db.db
        .query("DELETE FROM test_reports WHERE path = ? AND id NOT IN (SELECT id FROM test_reports WHERE path = ? ORDER BY recorded_at DESC, id DESC LIMIT ?)")
        .run(path, path, ROWS_PER_PATH);
    })
    .immediate();
}

/** The row for `path` at exactly `blob`, or undefined. */
export function reportFor(db: CoordDb, path: string, blob: string): LedgerRow | undefined {
  const r = db.db.query<Raw, [string, string]>("SELECT path, blob, cases, source, recorded_at FROM test_reports WHERE path = ? AND blob = ?").get(path, blob);
  return r ? row(r) : undefined;
}

/** The newest row for `path`, whatever its content was. */
export function lastReport(db: CoordDb, path: string): LedgerRow | undefined {
  const r = db.db.query<Raw, [string]>("SELECT path, blob, cases, source, recorded_at FROM test_reports WHERE path = ? ORDER BY recorded_at DESC, id DESC LIMIT 1").get(path);
  return r ? row(r) : undefined;
}

interface Raw {
  path: string;
  blob: string;
  cases: string;
  source: ReportSource;
  recorded_at: string;
}

const row = (r: Raw): LedgerRow => ({ path: r.path, blob: r.blob, cases: JSON.parse(r.cases) as TestCase[], source: r.source, recordedAt: r.recorded_at });

/** What the ledger holds for one test file (BR-2005). */
export interface FileReport {
  /** The testcases of the row for the file's current content, or of its newest older row. */
  readonly cases: readonly TestCase[];
  /** True when the row is for the file's current content (its blob hash), false when it is an older row. */
  readonly fresh: boolean;
}

/** What `canon check` and the evidence read about the test files of one tree (BR-2005, BR-2344). */
export interface TestReports {
  /** A file the ledger has no row for at all is absent. */
  readonly files: ReadonlyMap<string, FileReport>;
  /** Test files this change makes relevant and that have no row for their current content (BR-2344). */
  readonly relevant: ReadonlySet<string>;
  /** True when canon/config.yaml sets no `test_command`: nothing can record a report yet, so the finding says how to write one (BR-2344). */
  readonly noTestCommand?: boolean;
}

/** The git blob hash of each file's content in the working tree of `root`; a file git cannot read has none. */
export function blobsOf(root: string, files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (files.length === 0) return out;
  const r = Bun.spawnSync(["git", "hash-object", "--stdin-paths"], { cwd: root, stdin: new TextEncoder().encode(`${files.join("\n")}\n`), stdout: "pipe", stderr: "pipe" });
  const lines = r.exitCode === 0 ? r.stdout.toString().trim().split("\n") : [];
  if (lines.length === files.length) files.forEach((f, i) => out.set(f, lines[i]!));
  return out;
}

/**
 * What the ledger says about each of `files` in the working tree of `root`: the row for the current content, else the
 * newest older row. `touched` makes files relevant (BR-2344): a changed file, or one whose newest row has a running
 * testcase naming a rule the change touched (`namesTouched`); without it no file is relevant.
 */
export function loadReports(
  db: CoordDb,
  root: string,
  files: readonly string[],
  touched?: { readonly changed: ReadonlySet<string>; readonly namesTouched: (names: string) => boolean },
): TestReports {
  const blobs = blobsOf(root, files);
  const out = new Map<string, FileReport>();
  const relevant = new Set<string>();
  for (const file of files) {
    const blob = blobs.get(file);
    const current = blob === undefined ? undefined : reportFor(db, file, blob);
    if (current) {
      out.set(file, { cases: current.cases, fresh: true });
      continue;
    }
    const last = lastReport(db, file);
    if (last) out.set(file, { cases: last.cases, fresh: false });
    if (touched && (touched.changed.has(file) || (last !== undefined && last.cases.some((c) => c.runs && touched.namesTouched(caseNames(c)))))) relevant.add(file);
  }
  return { files: out, relevant };
}

/** The testcases of a report that run: no `skipped` child (BR-2338). */
export const runningCases = (r: FileReport | undefined): readonly TestCase[] => (r ? r.cases.filter((c) => c.runs) : []);
