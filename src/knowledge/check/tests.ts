import type { Config } from "../../invocation/config.ts";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * Test files: the ones the configured `tests` globs match (BR-2046). Without `tests` canon does not guess which files
 * are tests, whatever their language (D-64): it is a usage error that says how to write it.
 */
export function testFilesFor(root: string, config: Config): Result<string[]> {
  if (!config.tests) {
    return err("invalid", "canon/config.yaml has no `tests`: list the globs of the project's test files, e.g. tests: [\"src/**/*.test.ts\"]; canon does not guess which files are tests (BR-2046, D-64)");
  }
  const out = new Set<string>();
  for (const pattern of config.tests) {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      if (!f.split("/").includes("node_modules")) out.add(f);
    }
  }
  return ok([...out].sort());
}
