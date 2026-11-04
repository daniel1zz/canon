import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fencedLines as inFence, type Corpus } from "../documents/model.ts";
import { git } from "../../kernel/git.ts";

/**
 * BR-2171, D-25: a repository path written in backticks in a current document must not name a path the repository
 * moved or deleted. A span is a path when it has no spaces or placeholder marks and either has a `/` and starts
 * with a top-level directory of the repository, or is a bare file name with a known extension. It is reported
 * only when it does not exist now and git history (HEAD) has it: a path that never existed is a hypothetical
 * example or a planned file, not a stale reference.
 */
export interface PathFinding {
  readonly path: string;
  readonly message: string;
}

/** Root files every session reads; checked whole (BR-2171). */
export const ROOT_DOCS = ["CLAUDE.md", "README.md"] as const;

const EXT = /^[A-Za-z0-9_][\w.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|md|yaml|yml|json|sh|toml|lock|txt)$/;
const NOT_A_PATH = /[\s<>*?{}$…|]|\b[A-Z]+-n\b|:\/\//;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".cache"]);

/** The text without its fenced code blocks (BR-2171). */
function prose(text: string): string {
  const lines = text.split("\n");
  const fenced = inFence(lines);
  return lines.filter((_, i) => !fenced[i]).join("\n");
}

/** The body without the `## ` sections named in `drop`; a `## ` line inside a code block is no heading. */
function without(body: string, drop: ReadonlySet<string>): string {
  let skipping = false;
  const kept: string[] = [];
  const lines = body.split("\n");
  const fenced = inFence(lines);
  lines.forEach((line, i) => {
    const h = fenced[i] ? null : line.match(/^##\s+(.+?)\s*$/);
    if (h) skipping = drop.has(h[1]!);
    if (!skipping) kept.push(line);
  });
  return kept.join("\n");
}

const RULE_HISTORY = new Set(["例子"]);
const DECISION_HISTORY = new Set(["背景", "方案"]);

/**
 * The current text of each document in scope (BR-2171): active rules without their examples (fixtures of a
 * hypothetical project), domain READMEs, accepted decisions without 背景 and 方案 (the situation when they were
 * decided), open changes, and the root docs. Done or dropped changes, superseded decisions and notes are history.
 */
function currentTexts(root: string, corpus: Corpus): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const d of corpus.docs) {
    if (d.kind === "rule" && d.status === "active") out.push({ path: d.path, text: without(d.body, RULE_HISTORY) });
    else if (d.kind === "decision" && d.status === "accepted") out.push({ path: d.path, text: without(d.body, DECISION_HISTORY) });
    else if (d.kind === "change" && d.status === "open") out.push({ path: d.path, text: d.body });
  }
  for (const dom of corpus.domains) out.push({ path: dom.path, text: dom.body });
  for (const p of ROOT_DOCS) if (existsSync(join(root, p))) out.push({ path: p, text: readFileSync(join(root, p), "utf8") });
  return out;
}

/** A backticked span as a repository path, or undefined when it is not one (BR-2171). */
export function asRepoPath(span: string, topDirs: ReadonlySet<string>): string | undefined {
  const s = span.trim();
  if (s === "" || NOT_A_PATH.test(s)) return undefined;
  const p = s.replace(/:\d+(?:-\d+)?$/, "").replace(/\/+$/, "");
  if (p.includes("/")) return topDirs.has(p.split("/")[0]!) ? p : undefined;
  return EXT.test(p) ? p : undefined;
}

// reason: symbolic links are never followed: a link counts as a file under its own name, so a dangling link or a
// loop cannot crash check (BR-2186)
function topDirs(root: string): Set<string> {
  return new Set(readdirSync(root, { withFileTypes: true }).filter((e) => !SKIP_DIRS.has(e.name) && e.isDirectory()).map((e) => e.name));
}

function fileNames(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else out.add(entry.name);
    }
  };
  walk(root);
  return out;
}

/** The path itself is there, even when it is a symbolic link whose target is not (BR-2186). */
function present(full: string): boolean {
  try {
    lstatSync(full);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    throw e;
  }
}

export function pathFindings(root: string, corpus: Corpus): PathFinding[] {
  const tops = topDirs(root);
  let names: Set<string> | undefined;
  const missing: { doc: string; path: string }[] = [];
  for (const { path, text } of currentTexts(root, corpus)) {
    for (const m of prose(text).matchAll(/`([^`\n]+)`/g)) {
      const p = asRepoPath(m[1]!, tops);
      if (p === undefined) continue;
      const gone = p.includes("/") ? !present(join(root, p)) : !(names ??= fileNames(root)).has(p);
      if (gone && !missing.some((x) => x.doc === path && x.path === p)) missing.push({ doc: path, path: p });
    }
  }
  if (missing.length === 0) return [];
  const history = historyOf(root, [...new Set(missing.map((m) => m.path))]);
  if (!history.ok) return [{ path: missing[0]!.doc, message: history.message }];
  const had = (p: string) =>
    p.includes("/") ? history.files.some((f) => f === p || f.startsWith(`${p}/`)) : history.files.some((f) => basename(f) === p);
  return missing.filter((m) => had(m.path)).map((m) => ({
    path: m.doc,
    message: `names \`${m.path}\`, which the repository no longer has (git history does); write where it is now, or drop the backticks where the text means the old location`,
  }));
}

/**
 * Every file path HEAD's history touched under the given paths; one git call (BR-2171, BR-2110). `what` names the
 * check in the error message. A path without `/` matches that file name in any directory.
 */
export function historyOf(root: string, paths: readonly string[], what = "backticked paths"): { ok: true; files: string[] } | { ok: false; message: string } {
  // reason: without a commit nothing was ever moved, so no path can be stale; a directory that is not a repository is an error
  const inside = git(root, "rev-parse", "--is-inside-work-tree");
  if (!inside.ok) return { ok: false, message: `cannot read git history to check ${what}: ${inside.error.message}` };
  if (!git(root, "rev-parse", "-q", "--verify", "HEAD").ok) return { ok: true, files: [] };
  const specs = paths.map((p) => (p.includes("/") ? `:(literal)${p}` : `:(glob)**/${p}`));
  const log = git(root, "log", "--no-renames", "--format=", "--name-only", "HEAD", "--", ...specs);
  if (!log.ok) return { ok: false, message: `cannot read git history to check ${what}: ${log.error.message}` };
  return { ok: true, files: log.value.split("\n").filter((l) => l !== "") };
}
