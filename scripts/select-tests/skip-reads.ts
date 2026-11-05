import { posix } from "node:path";

/**
 * The repository files a JS/TS test reads, found statically (BR-2350; moved from canon's `test-reads-skip-path` check, BR-2181, D-64).
 * A path the test spells from its own location (`import.meta.dir`, `import.meta.dirname`, `__dirname`,
 * `new URL(<literal>, import.meta.url)`), from `process.cwd()` (the floor runs at the repository root), or from a variable
 * assigned one of those in the same file, joined with string literals; a string literal passed straight to a
 * file-reading call (relative to the root); and a `cwd:` set to such a path. Paths built any other way (helpers in
 * other files, computed strings) are not seen.
 */
export interface Read {
  /** 1-based line of the read. */
  readonly line: number;
  /** The repo-relative path read; "" is the repository root. */
  readonly path: string;
  /** True when more path follows that the test computes, so anything under `path` may be read. */
  readonly partial: boolean;
  /** `reads` or `runs a command in`. */
  readonly how: string;
}

const LIT = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`[^\`$\\]*\`)`;
const ANCHOR = String.raw`import\.meta\.dirname|import\.meta\.dir\b|__dirname|process\.cwd\(\)|new\s+URL\(\s*${LIT}\s*,\s*import\.meta\.url\s*\)|import\.meta\.url`;
const READS = String.raw`readFileSync|readFile|existsSync|readdirSync|readdir|statSync|lstatSync|stat|createReadStream|opendirSync|Bun\.file`;

function unquote(lit: string): string {
  return lit.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** Repository-relative, normalised; undefined when it leaves the repository. */
function inRepo(p: string): string | undefined {
  const n = posix.normalize(p);
  if (n === ".." || n.startsWith("../") || posix.isAbsolute(n)) return undefined;
  return n === "." ? "" : n.replace(/\/+$/, "");
}

/** Every repository path the JS/TS test `file` (with source `text`) reads, in line order. */
export function readsOf(file: string, text: string): Read[] {
  const mine: Read[] = [];
  const here = posix.dirname(file.split("\\").join("/"));
  const vars = new Map<string, string>();
  const anchorOf = (a: string): string | undefined => {
    if (a === "process.cwd()") return "";
    const url = a.match(new RegExp(String.raw`^new\s+URL\(\s*(${LIT})`));
    if (url) return inRepo(posix.join(here, unquote(url[1]!)));
    if (a === "import.meta.url") return inRepo(here);
    if (/^(import\.meta\.dirname|import\.meta\.dir|__dirname)$/.test(a)) return inRepo(here);
    return vars.get(a);
  };
  const base = () => String.raw`(${ANCHOR}${vars.size ? `|${[...vars.keys()].map((v) => `(?<![\\w$])${v.replace(/\$/g, "\\$")}(?![\\w$])`).join("|")}` : ""})`;
  // A `join(a, "x", "y")`, `resolve(...)` or `${a}/x` from a known start: the literal part and whether more follows.
  const resolveAt = (expr: string): { path: string; partial: boolean } | undefined => {
    const call = expr.match(new RegExp(String.raw`^(?:path\.|posix\.)?(?:join|resolve)\(\s*${base()}((?:\s*,\s*${LIT})*)\s*(\)|,)`));
    if (call) {
      const start = anchorOf(call[1]!);
      if (start === undefined) return undefined;
      const segs = [...call[2]!.matchAll(new RegExp(LIT, "g"))].map((m) => unquote(m[0]));
      const p = inRepo(posix.join(start || ".", ...segs));
      return p === undefined ? undefined : { path: p, partial: call[3] === "," };
    }
    const tpl = expr.match(new RegExp(String.raw`^\`\$\{\s*${base()}\s*\}([^\`]*)\``));
    if (tpl) {
      const start = anchorOf(tpl[1]!);
      if (start === undefined) return undefined;
      const rest = tpl[2]!;
      const cut = rest.indexOf("${");
      const p = inRepo(posix.join(start || ".", cut < 0 ? rest : rest.slice(0, cut)));
      return p === undefined ? undefined : { path: p, partial: cut >= 0 };
    }
    const bare = expr.match(new RegExp(String.raw`^${base()}`));
    if (bare) {
      const p = anchorOf(bare[1]!);
      return p === undefined ? undefined : { path: p, partial: true };
    }
    return undefined;
  };
  // Variables first, in file order, so a later one may start from an earlier one.
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g)) {
    const r = resolveAt(text.slice(m.index! + m[0].length));
    if (r && (!r.partial || isAnchorOnly(text.slice(m.index! + m[0].length), base()))) vars.set(m[1]!, r.path);
  }
  const line = (i: number) => text.slice(0, i).split("\n").length;
  const seen = new Set<string>();
  const report = (i: number, p: string, partial: boolean, how: string) => {
    const key = `${line(i)}:${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    mine.push({ line: line(i), path: p, partial, how });
  };
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$])(?:(?:path\.|posix\.)?(?:join|resolve)\(|\`\$\{)`, "g"))) {
    const r = resolveAt(text.slice(m.index!));
    if (r) report(m.index!, r.path, r.partial, "reads");
  }
  for (const m of text.matchAll(new RegExp(String.raw`new\s+URL\(\s*(${LIT})\s*,\s*import\.meta\.url\s*\)`, "g"))) {
    const p = inRepo(posix.join(here, unquote(m[1]!)));
    if (p !== undefined) report(m.index!, p, false, "reads");
  }
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:${READS})\(\s*(${LIT})\s*[,)]`, "g"))) {
    const p = inRepo(unquote(m[1]!));
    if (p !== undefined) report(m.index!, p, false, "reads");
  }
  for (const m of text.matchAll(/\bcwd\s*:\s*/g)) {
    const r = resolveAt(text.slice(m.index! + m[0].length));
    if (r) report(m.index!, r.path, true, "runs a command in");
  }
  return mine.sort((x, y) => x.line - y.line);
}

/** The expression is just a known start (a variable holding the root, say), not a call with more arguments. */
function isAnchorOnly(expr: string, base: string): boolean {
  return new RegExp(String.raw`^${base}\s*[;\n]`).test(expr);
}
