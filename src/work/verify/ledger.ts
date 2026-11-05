import type { CoordDb } from "../db.ts";
import type { TestCase } from "./report.ts";

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
