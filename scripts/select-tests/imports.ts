import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * The relative-import reading `select.ts` selects tests with: which repo paths a JS/TS file imports. Moved here from
 * canon's own code (D-64): canon knows no language, this project's test_select_command does.
 */

const SPECIFIERS = [
  /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])import\s*["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function isFile(full: string): boolean {
  return existsSync(full) && statSync(full).isFile();
}

/**
 * Repo paths of the relative imports in a file, read at run time so nothing has to be declared or kept up to
 * date (D-15). A specifier resolves the way bundlers do: as written, with a source extension, or as a
 * directory's index; one that resolves to nothing is kept as written, since matching is by directory anyway.
 * `exists` says which repo paths count as files; the selection also counts the files the change deleted (BR-2347).
 */
export function importedPaths(root: string, file: string, exists: (path: string) => boolean = (p) => isFile(join(root, p))): string[] {
  const text = readFileSync(join(root, file), "utf8");
  const out = new Set<string>();
  for (const re of SPECIFIERS) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const base = posix.normalize(posix.join(posix.dirname(file), spec));
      if (base.startsWith("../") || base === "..") continue;
      const stem = base.replace(/\.[cm]?jsx?$/, "");
      const candidates = [base, ...RESOLVE_EXTS.map((e) => `${stem}${e}`), ...RESOLVE_EXTS.map((e) => `${base}/index${e}`)];
      out.add(candidates.find(exists) ?? base);
    }
  }
  out.delete(file);
  return [...out].sort();
}
