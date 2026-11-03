import { existsSync, readFileSync } from "node:fs";
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

/** Changes in the owner's order: the backlog's first, as listed, then the rest by id (BR-2148). */
export function inBacklogOrder<T extends Pick<Change, "id">>(changes: readonly T[], backlog: readonly BacklogEntry[]): T[] {
  const rank = new Map(backlog.map((e, i) => [e.id, i]));
  const num = (id: string) => Number(id.split("-").pop());
  return [...changes].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return num(a.id) - num(b.id);
  });
}
