import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CoordDb } from "../db.ts";
import type { Say, Workspace } from "../workspace.ts";
import { logFile } from "../hooks/hooks.ts";
import { canonCommand } from "../watch/watch.ts";
import type { Result } from "../../kernel/result.ts";
import { clean } from "./session.ts";

/**
 * The landed worktree removed after `canon work land --finish` (BR-2486, #228): a background `canon work clean <subject>
 * --after-landing`, started once main holds the work, removes it under the same conditions as `canon work clean` (BR-2019).
 * The landing's own processes, and the shell it was run from, sit inside the worktree until they exit, so it waits for them.
 */

/** Set to 0, `land --finish` does not start the background removal (tests run it themselves). */
export const CLEAN_AFTER_LAND_ENV = "CANON_CLEAN_AFTER_LAND";

/** The last line of a finished removal's log. */
export const CLEAN_DONE = "clean: done";

/** Seconds between the tries while a process is still inside: about two minutes in all (BR-2486). */
export const CLEAN_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000];

export const cleanLog = (db: CoordDb, subject: string): string => logFile(db, `clean-${subject}.log`);

/** Starts the background removal of `subject`'s worktree; never waits for it. One that cannot be started is said, not fatal. */
export function startCleanAfterLanding(ws: Workspace, say: Say, subject: string): void {
  if (process.env[CLEAN_AFTER_LAND_ENV] === "0") return;
  const log = cleanLog(ws.db, subject);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w");
  try {
    // reason: its own process group, from the primary checkout, so it outlives the landing and is never inside the worktree it removes (BR-2486)
    const p = Bun.spawn([...canonCommand(), "work", "clean", subject, "--after-landing"], { cwd: ws.primary, stdout: fd, stderr: fd, stdin: "ignore", detached: true, env: { ...(process.env as Record<string, string>) } });
    p.unref();
  } catch (e) {
    say(`${subject}'s worktree was not removed: \`canon work clean ${subject} --after-landing\` could not be started in the background (${(e as Error).message}); run canon work clean ${subject} once you have left it`);
    return;
  } finally {
    closeSync(fd);
  }
  say(`${subject}'s worktree is removed in the background once nothing runs inside it, when canon work clean would remove it (log: ${log}); canon work after-land --wait ${subject} reports it`);
}

const inUse = (kept: readonly string[]): boolean => kept.some((k) => k.includes(": in use by "));

/**
 * `canon work clean <subject> --after-landing` (BR-2486): `clean` of that one worktree, tried again after each delay while
 * the only reason it stays is a process inside it; any other reason, or the last try, ends it with the reason said.
 */
export async function cleanAfterLanding(ws: Workspace, say: Say, subject: string, delaysMs: readonly number[] = CLEAN_RETRY_DELAYS_MS): Promise<Result<{ removed: string[]; kept: string[] }>> {
  for (let i = 0; ; i++) {
    const r = clean(ws, () => {}, [subject]);
    if (!r.ok || r.value.removed.length > 0 || !inUse(r.value.kept) || i >= delaysMs.length) {
      if (r.ok) {
        for (const p of r.value.removed) say(`removed ${p}`);
        for (const k of r.value.kept) say(`kept ${k}${inUse([k]) ? `; run canon work clean ${subject} once you have left it` : ""}`);
      }
      return r;
    }
    await Bun.sleep(delaysMs[i]!);
  }
}

/** The background removal's log for `subject`, as `canon work after-land` reports it; undefined when none was started. */
export function readCleanAfterLanding(db: CoordDb, subject: string): { readonly log: string; readonly lines: readonly string[]; readonly done: boolean } | undefined {
  const log = cleanLog(db, subject);
  if (!existsSync(log)) return undefined;
  const lines = readFileSync(log, "utf8").trimEnd().split("\n").filter((l) => l !== "");
  return { log, lines, done: lines.includes(CLEAN_DONE) };
}
