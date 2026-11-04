import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { git } from "./git.ts";
import { ok, type Result } from "./result.ts";

/** True when the repository's shared info/exclude has no line `line` yet. */
export function excludeMissing(root: string, line: string): Result<boolean> {
  const file = excludeFile(root);
  if (!file.ok) return file;
  const text = existsSync(file.value) ? readFileSync(file.value, "utf8") : "";
  return ok(!hasLine(text, line));
}

/**
 * Makes sure the info/exclude of the repository `root` belongs to (the git common directory, so a linked worktree
 * reaches the same file) has the line `line`, appending it when it is missing; returns whether it appended. Only
 * appends, never rewrites (BR-2176, BR-2305), and creates the file and its info/ directory when they are absent.
 */
export function ensureExcluded(root: string, line: string): Result<boolean> {
  const file = excludeFile(root);
  if (!file.ok) return file;
  const text = existsSync(file.value) ? readFileSync(file.value, "utf8") : "";
  if (hasLine(text, line)) return ok(false);
  mkdirSync(join(file.value, ".."), { recursive: true });
  // reason: every worktree's git reads this file; appending never empties it and never drops a line someone else
  // added since the read. Two sessions racing may both append, and a repeated line is harmless (issue #44, BR-2176).
  appendFileSync(file.value, `${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
  return ok(true);
}

const hasLine = (text: string, line: string) => text.split("\n").some((l) => l.trim() === line);

function excludeFile(root: string): Result<string> {
  const common = git(root, "rev-parse", "--git-common-dir");
  if (!common.ok) return common;
  const dir = isAbsolute(common.value) ? common.value : join(root, common.value);
  return ok(join(dir, "info", "exclude"));
}
