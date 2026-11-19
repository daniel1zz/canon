import type { Config } from "../../invocation/config.ts";
import type { CoordDb } from "../../work/db.ts";
import { loadReports } from "../../work/verify/ledger.ts";
import { caseNames } from "../../work/verify/report.ts";
import { testFilesFor } from "../check/tests.ts";
import { idsIn } from "../documents/types.ts";

/**
 * The titles of the running tests that name each of `ruleIds`, read from the test reports canon recorded for the test files
 * in the tree at `root` (BR-2005, D-64): the rule review is shown them, so it does not call a rule untestable that tests
 * already decide (BR-2009, #265). A rule no running test names is absent; no `tests` configured gives an empty map.
 */
export function namedTests(db: CoordDb, root: string, config: Config, ruleIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ruleIds.length === 0) return out;
  const files = testFilesFor(root, config);
  if (!files.ok) return out;
  const wanted = new Set(ruleIds);
  const reports = loadReports(db, root, files.value);
  for (const [file, report] of reports.files) {
    for (const c of report.cases) {
      if (!c.runs) continue;
      for (const id of idsIn(config.types, caseNames(c))) {
        if (!wanted.has(id)) continue;
        const list = out.get(id) ?? [];
        list.push(`${file}: ${c.name}`);
        out.set(id, list);
      }
    }
  }
  return out;
}
