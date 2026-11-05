import { dirname } from "node:path";
import { pathsBuiltFromDir } from "./cli-tests.ts";

/**
 * Source files that read data files at run time by a path they spell from their own location (D-60, issue #117):
 * `join(import.meta.dir, "..", ".claude", "skills")`. Nothing imports such a file, so the import reading of
 * `canon work test` (BR-2157) cannot see that a change to it reaches the module.
 */

const CODE = /\.[cm]?[jt]sx?$/;

/** What a module reads: the repo path it spells, and the changed non-code files under it. */
export interface DataRead {
  readonly path: string;
  readonly changed: readonly string[];
}

/**
 * The non-code paths `file` builds from `import.meta.dir` and string literals. A path to a code file is the import
 * reading's business, and the repo root or a directory holding the file itself is too broad to mean one data source.
 */
export function dataPathsRead(file: string, text: string): string[] {
  const here = dirname(file);
  return pathsBuiltFromDir(file, text).filter((p) => p !== "." && !CODE.test(p) && here !== p && !here.startsWith(`${p}/`));
}

/** The changed non-code files that are `path` or lie under it. */
export function changedUnder(path: string, changed: readonly string[]): string[] {
  return changed.filter((c) => !CODE.test(c) && (c === path || c.startsWith(`${path}/`)));
}

/** The modules among `texts` (repo path → source text) that read a path a changed non-code file lies under. */
export function readersOfChanged(texts: ReadonlyMap<string, string>, changed: readonly string[]): Map<string, DataRead> {
  const out = new Map<string, DataRead>();
  for (const [file, text] of texts) {
    for (const path of dataPathsRead(file, text)) {
      const hit = changedUnder(path, changed);
      if (hit.length) out.set(file, { path, changed: hit });
    }
  }
  return out;
}
