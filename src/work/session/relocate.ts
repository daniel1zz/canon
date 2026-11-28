import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git } from "../../kernel/git.ts";
import type { Workspace } from "../workspace.ts";
import { worktreesDirOf } from "./config-keys.ts";

/**
 * After the repository was moved (another machine, another directory), the coordination database still names the old
 * absolute paths: claims, the landing queue, handoffs, events and review logs (BR-2649). `canon brief` finds the old
 * location from a recorded path that is gone while the same name exists at the new one, rewrites every path column
 * in one transaction, forgets the session processes recorded there, and repairs git's worktree links.
 */

export interface Relocation {
  readonly fromPrimary: string | undefined;
  readonly fromWorktrees: string | undefined;
  readonly rows: number;
  readonly repaired: number;
}

const WORKTREES_SUFFIX = ".worktrees";
const LOGS = "/.git/canon/logs/";
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** The old worktrees directory: a recorded worktree that is gone while a directory of its name is in `newDir`. */
function oldWorktreesDir(ws: Workspace, newDir: string): string | undefined {
  const rows = ws.db.db
    .query<{ path: string }, []>("SELECT worktree AS path FROM claims WHERE worktree IS NOT NULL UNION SELECT worktree FROM handoffs WHERE worktree IS NOT NULL UNION SELECT worktree FROM queue WHERE worktree IS NOT NULL")
    .all();
  for (const { path } of rows) {
    if (!path.startsWith("/") || path.startsWith(`${newDir}/`) || path === ws.primary || existsSync(path)) continue;
    if (isDir(join(newDir, basename(path)))) return dirname(path);
  }
  return undefined;
}

/** The old primary checkout: a recorded log under `<primary>/.git/canon/logs/` that is gone while the file of its name is in this database's logs. */
function oldPrimaryOfLogs(ws: Workspace): string | undefined {
  const logs = join(dirname(ws.db.db.filename), "logs");
  const rows = ws.db.db
    .query<{ path: string | null }, []>("SELECT log AS path FROM landed_reviews UNION SELECT json_extract(detail, '$.log') FROM events WHERE kind = 'hook.run' AND id > (SELECT coalesce(max(id), 0) - 2000 FROM events)")
    .all();
  for (const { path } of rows) {
    if (!path || !path.includes(LOGS) || path.startsWith(`${ws.primary}/`) || existsSync(path)) continue;
    if (existsSync(join(logs, basename(path)))) return path.slice(0, path.indexOf(LOGS));
  }
  return undefined;
}

/** Rewrites `old` (the path itself or anything under it) to `now` in one column; the number of rows changed. */
function rewrite(ws: Workspace, table: string, column: string, old: string, now: string, extra = ""): number {
  // reason: substr, not LIKE, so a `_` or `%` in a path is no wildcard
  const r = ws.db.db
    .query(`UPDATE ${table} SET ${column} = ?1 || substr(${column}, length(?2) + 1)${extra} WHERE substr(${column}, 1, length(?2)) = ?2 AND (length(${column}) = length(?2) OR substr(${column}, length(?2) + 1, 1) = '/')`)
    .run(now, old);
  return r.changes;
}

/** Rewrites the old path inside event details (log paths, worktrees) where it stands as a whole path. */
function rewriteDetails(ws: Workspace, old: string, now: string): number {
  return ws.db.db
    .query("UPDATE events SET detail = replace(replace(detail, ?1 || '/', ?2 || '/'), '\"' || ?1 || '\"', '\"' || ?2 || '\"') WHERE instr(detail, ?1 || '/') > 0 OR instr(detail, '\"' || ?1 || '\"') > 0")
    .run(old, now).changes;
}

/** Finds and repairs a moved repository; undefined when nothing names an old location (the common case: three small queries). */
export function relocate(ws: Workspace): Relocation | undefined {
  const newDir = worktreesDirOf(ws.config, ws.primary);
  const defaultDir = !ws.config.worktrees;
  let fromWorktrees = oldWorktreesDir(ws, newDir);
  let fromPrimary = oldPrimaryOfLogs(ws);
  // reason: with the default layout the two old locations name each other (BR-2047); a configured one names only itself
  if (defaultDir && fromPrimary && !fromWorktrees) fromWorktrees = `${fromPrimary}${WORKTREES_SUFFIX}`;
  if (defaultDir && fromWorktrees && !fromPrimary && fromWorktrees.endsWith(WORKTREES_SUFFIX)) fromPrimary = fromWorktrees.slice(0, -WORKTREES_SUFFIX.length);
  if (fromPrimary === ws.primary) fromPrimary = undefined;
  if (fromWorktrees === newDir) fromWorktrees = undefined;
  if (!fromPrimary && !fromWorktrees) return undefined;
  const pairs: [string, string][] = [...(fromWorktrees ? [[fromWorktrees, newDir] as [string, string]] : []), ...(fromPrimary ? [[fromPrimary, ws.primary] as [string, string]] : [])];
  const rows = ws.db.db.transaction((): number => {
    let n = 0;
    for (const [old, now] of pairs) {
      // reason: a session process recorded at the old location ran there, maybe on another machine; its pid means nothing here (BR-2649, D-165)
      n += rewrite(ws, "claims", "worktree", old, now, ", pid = NULL, pid_start = NULL");
      n += rewrite(ws, "queue", "worktree", old, now);
      n += rewrite(ws, "handoffs", "worktree", old, now);
      n += rewrite(ws, "events", "worktree", old, now);
      n += rewrite(ws, "landed_reviews", "log", old, now);
      n += rewriteDetails(ws, old, now);
    }
    return n;
  }).immediate();
  // reason: git's own links from .git/worktrees still point at the old directories until repaired
  const dirs = isDir(newDir) ? readdirSync(newDir).map((d) => join(newDir, d)).filter((d) => existsSync(join(d, ".git"))) : [];
  const repaired = dirs.length > 0 && git(ws.primary, "worktree", "repair", ...dirs).ok ? dirs.length : 0;
  ws.db.event(ws.actor, "state.relocate", null, { from_primary: fromPrimary ?? null, to_primary: ws.primary, from_worktrees: fromWorktrees ?? null, to_worktrees: newDir, rows, repaired });
  return { fromPrimary, fromWorktrees, rows, repaired };
}

/** The brief's line about a relocation (BR-2649). */
export function relocationLine(r: Relocation, ws: Workspace): string {
  const from = r.fromPrimary ?? r.fromWorktrees;
  return `canon: this repository moved from ${from} to ${r.fromPrimary ? ws.primary : worktreesDirOf(ws.config, ws.primary)}; rewrote ${r.rows} path(s) in the coordination database and repaired ${r.repaired} worktree link(s) (BR-2649)`;
}
