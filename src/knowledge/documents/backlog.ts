import { existsSync, readFileSync } from "node:fs";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { join } from "node:path";
import { CANON_DIR } from "./read.ts";
import type { Change } from "./model.ts";
import { LIST_MARKER } from "./templates.ts";
import { BUILTIN_TYPES, type DocType } from "./types.ts";

/**
 * The owner's order of work (D-20): `canon/backlog.md` lists change ids, one per list item, first = do first.
 * Only the owner edits it; a change it does not list comes after the listed ones, by id, so a new change is at
 * the end without anyone touching the file (two agents appending to one file would conflict on landing).
 */
export const BACKLOG_FILE = `${CANON_DIR}/backlog.md`;

export interface BacklogEntry {
  readonly id: string;
  readonly line: number;
}

/** The change ids the backlog file under `root` lists, in order; empty when there is no backlog file. */
export function readBacklog(root: string, types: readonly DocType[] = BUILTIN_TYPES): BacklogEntry[] {
  const full = join(root, BACKLOG_FILE);
  return existsSync(full) ? parseBacklog(readFileSync(full, "utf8"), types) : [];
}

/** The backlog as committed at `ref` (main: where the owner's order lives, D-20); empty when that commit has none. */
export function backlogAt(cwd: string, ref: string, types: readonly DocType[] = BUILTIN_TYPES): Result<BacklogEntry[]> {
  const at = `${ref}:${BACKLOG_FILE}`;
  if (!git(cwd, "cat-file", "-e", at).ok) return ok([]);
  const text = git(cwd, "show", at);
  if (!text.ok) return err("io", `cannot read ${at}: ${text.error.message}`);
  return ok(parseBacklog(text.value, types));
}

/** The change ids a backlog text lists, one per list item (a leading checkbox or backticks allowed), first mention only. */
export function parseBacklog(text: string, types: readonly DocType[] = BUILTIN_TYPES): BacklogEntry[] {
  const prefix = types.find((t) => t.name === "change")!.prefix; // reason: change is a built-in type, never removed
  const item = new RegExp(`^\\s*${LIST_MARKER.source.slice(1)}(?:\\[[ xX]\\]\\s+)?\`?(${prefix}-\\d+)(?![0-9])`);
  const seen = new Set<string>();
  const out: BacklogEntry[] = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(item);
    if (!m || seen.has(m[1]!)) return;
    seen.add(m[1]!);
    out.push({ id: m[1]!, line: i + 1 });
  });
  return out;
}

/**
 * Changes in the owner's order: the backlog's first, as listed; then the unlisted ones already `started` (a handoff
 * or a change branch: work someone began and may have left), then the rest, each by id (BR-2148, BR-2291, D-50).
 */
export function inBacklogOrder<T extends Pick<Change, "id">>(changes: readonly T[], backlog: readonly BacklogEntry[], started: ReadonlySet<string> = new Set()): T[] {
  const rank = new Map(backlog.map((e, i) => [e.id, i]));
  const num = (id: string) => Number(id.split("-").pop());
  return [...changes].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    const sa = started.has(a.id);
    if (sa !== started.has(b.id)) return sa ? -1 : 1;
    return num(a.id) - num(b.id);
  });
}

/** The heading in canon/backlog.md whose list items the owner wants landed ahead of the queue (BR-2232, D-34). */
export const URGENT_HEADING = "优先合入";

/**
 * The change ids listed under the `优先合入` heading of a backlog text, up to the next heading of the same or a
 * higher level; empty when there is no such heading (BR-2232).
 */
export function parseUrgent(text: string, types: readonly DocType[] = BUILTIN_TYPES): Set<string> {
  const lines = text.split("\n");
  const out = new Set<string>();
  let level = 0;
  const section: string[] = [];
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      if (level > 0 && h[1]!.length <= level) break;
      if (level === 0 && h[2] === URGENT_HEADING) level = h[1]!.length;
      continue;
    }
    if (level > 0) section.push(line);
  }
  for (const e of parseBacklog(section.join("\n"), types)) out.add(e.id);
  return out;
}
