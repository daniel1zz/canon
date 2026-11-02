import type { Config } from "../repo/config.ts";
import { findTestFiles } from "./check.ts";

/** Test files scanned for rule ids: the configured globs, or every *.test.* / *.spec.* file. */
export function testFilesFor(root: string, config: Config): string[] {
  if (!config.tests) return findTestFiles(root);
  const out = new Set<string>();
  for (const pattern of config.tests) {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      if (!f.split("/").includes("node_modules")) out.add(f);
    }
  }
  return [...out].sort();
}
