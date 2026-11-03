import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordDb } from "../db.ts";
import type { Say, Workspace } from "../workspace.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { isGone, selfProcess } from "../claims/liveness.ts";
import { start, type Started } from "../session/session.ts";

/**
 * "main is failing" (D-31): one record in the coordination DB from the background floor's failure until a later
 * run passes (BR-2220, BR-2222), and the one change that fixes it (BR-2221).
 */
export interface RedMain {
  /** The latest commit the background floor failed on. */
  readonly sha: string;
  /** The commit main first failed on, while this record stands. */
  readonly first_sha: string;
  readonly log: string;
  /** The last 40 lines of the floor's output. */
  readonly tail: string;
  /** When main first failed. */
  readonly since: string;
  /** refs/canon/green when main first failed; null when no commit had passed. */
  readonly green: string | null;
  /** The fix change opened with `canon work start --fix-main`. */
  readonly change: string | null;
  readonly fix_pid: number | null;
  readonly fix_start: string | null;
}

export function redMain(db: CoordDb): RedMain | undefined {
  return db.db.query<RedMain, []>("SELECT sha, first_sha, log, tail, since, green, change, fix_pid, fix_start FROM red_main WHERE id = 1").get() ?? undefined;
}

/**
 * Records a background failure (BR-2220): a new record when there is none; otherwise only its failing commit, log
 * and output tail change, never when it began, the last passing commit or the fix change.
 */
export function recordFailure(db: CoordDb, f: { sha: string; log: string; tail: string; green: string | null }): void {
  const now = new Date().toISOString();
  db.db
    .query(
      "INSERT INTO red_main(id, sha, first_sha, log, tail, since, green, updated_at) VALUES (1, ?1, ?1, ?2, ?3, ?4, ?5, ?4) ON CONFLICT(id) DO UPDATE SET sha = excluded.sha, log = excluded.log, tail = excluded.tail, updated_at = excluded.updated_at",
    )
    .run(f.sha, f.log, f.tail, now, f.green);
}

/** Main passed: the record goes (BR-2222). */
export function clearRedMain(db: CoordDb): void {
  db.db.query("DELETE FROM red_main WHERE id = 1").run();
}

/** A dropped fix change no longer fixes main, so another session may open one (BR-2221). */
export function clearFixChange(db: CoordDb, change: string): void {
  db.db.query("UPDATE red_main SET change = NULL, fix_pid = NULL, fix_start = NULL WHERE change = ?").run(change);
}

const short = (sha: string) => sha.slice(0, 9);

/**
 * The `canon brief` block about a failing main (BR-2220), first after the guide; empty when main is not failing.
 * `mine` is the change claimed in the worktree brief runs in, if any.
 */
export function redMainNotice(db: CoordDb, mine: string | undefined): string[] {
  const r = redMain(db);
  if (!r) return [];
  const since = r.first_sha === r.sha ? short(r.sha) : `${short(r.first_sha)} (latest failing commit ${short(r.sha)})`;
  const lines = [
    `main is failing floor since ${since}, first failed at ${r.since} (canon floor watch, D-31)`,
    `  log: ${r.log}`,
    "  last lines of its output:",
    ...r.tail.trimEnd().split("\n").slice(-10).map((l) => `    ${l}`),
    `  last passing commit: ${r.green ? short(r.green) : "none recorded"}`,
  ];
  if (r.change) lines.push(`  being fixed in ${r.change}`);
  else if (r.fix_pid !== null) lines.push("  a session is opening the fix change right now (canon work start --fix-main)");
  else lines.push("  nobody is fixing it yet: a session that has no claimed change runs `canon work start --fix-main` to fix it");
  if (mine && mine === r.change) lines.push(`  ${mine} is the change that fixes it.`);
  else if (mine) lines.push(`  These failures are not caused by ${mine}: do not fix them in ${mine}; its own tests may fail for the same reason.`);
  return lines;
}

/** The title of the fix change for a failing commit (BR-2221). */
export const fixTitle = (sha: string) => `修复 main 上没通过的 floor（${short(sha)}）`;

/**
 * `canon work start --fix-main` (BR-2221): opens and claims the one change that fixes the failing main, with the
 * failure written into its `## 为什么`, and records it on the record. Not found (exit 3) without a record; conflict
 * (exit 5) when a fix change exists or another session is opening one. The record is reserved first, in one
 * transaction, so of two sessions running it at once only one opens a change.
 */
export function startFixMain(ws: Workspace, say: Say): Result<Started> {
  const self = selfProcess();
  if (!self) return err("io", "cannot read this process's start time from ps, so the fix change cannot be reserved");
  const reserved = ws.db.db
    .transaction((): Result<RedMain> => {
      const r = redMain(ws.db);
      if (!r) return err("not_found", "main is not failing: there is no failed background floor to fix (canon floor watch records one)");
      if (r.change) return err("conflict", `main is already being fixed in ${r.change}`);
      // reason: a session that died while opening the fix change must not block the next one for ever (D-11).
      if (r.fix_pid !== null && r.fix_start !== null && isGone({ pid: r.fix_pid, start: r.fix_start }) !== true) {
        return err("conflict", `another session (pid ${r.fix_pid}) is opening the fix change for main right now`);
      }
      ws.db.db.query("UPDATE red_main SET fix_pid = ?, fix_start = ? WHERE id = 1").run(self.pid, self.start);
      return ok(r);
    })
    .immediate();
  if (!reserved.ok) {
    ws.db.event(ws.actor, "start.refuse", null, { reason: "fix-main", message: reserved.error.message });
    return reserved;
  }
  const r = reserved.value;
  const release = () => ws.db.db.query("UPDATE red_main SET fix_pid = NULL, fix_start = NULL WHERE fix_pid = ? AND fix_start = ?").run(self.pid, self.start);
  const s = start(ws, { title: fixTitle(r.sha) }, say);
  if (!s.ok) {
    release();
    return s;
  }
  // The change is recorded before its file is filled in, so a failure below still leaves it as the fix change.
  ws.db.db.query("UPDATE red_main SET change = ?, fix_pid = NULL, fix_start = NULL WHERE fix_pid = ? AND fix_start = ?").run(s.value.change, self.pid, self.start);
  if (!redMain(ws.db)) say(`main passed while ${s.value.change} was being opened; check \`canon brief\` before working on it`);
  ws.db.event(ws.actor, "fix-main.start", s.value.change, { sha: r.sha, log: r.log });
  const filled = fillWhy(ws, s.value, r);
  if (!filled.ok) return err(filled.error.code, `${s.value.change} was opened as the fix change, but its 为什么 section could not be written: ${filled.error.message}`);
  return s;
}

/** Writes the failure into the fix change's `## 为什么` and folds it into the change's opening commit. */
function fillWhy(ws: Workspace, s: Started, r: RedMain): Result<void> {
  const doc = findDoc(readCorpus(s.worktree, ws.config.types, ws.config).corpus, s.change);
  if (!doc) return err("not_found", `${s.change} has no file in ${s.worktree}`);
  const file = join(s.worktree, doc.path);
  // reason: a fence inside the output would end the block early and turn the rest into references (BR-2221).
  const tail = r.tail.trimEnd().replaceAll("```", "'''");
  const why = [
    "main 上后台测试的 floor 没通过（`canon floor watch`，D-31），这个变更负责把它修好。",
    "",
    `- 失败的提交：\`${r.sha}\``,
    `- 最近通过的提交：${r.green ? `\`${r.green}\`` : "无"}`,
    `- 日志：\`${r.log}\``,
    "- 输出尾部：",
    "",
    "```",
    tail,
    "```",
    "",
  ].join("\n");
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === "## 为什么");
  let next: string;
  if (at < 0) {
    const end = text.indexOf("\n---\n", 3);
    next = end < 0 ? `## 为什么\n\n${why}\n${text}` : `${text.slice(0, end + 5)}\n## 为什么\n\n${why}${text.slice(end + 5)}`;
  } else {
    const rest = lines.slice(at + 1);
    const stop = rest.findIndex((l) => /^##\s/.test(l));
    const after = stop < 0 ? [] : rest.slice(stop);
    next = [...lines.slice(0, at + 1), "", ...why.split("\n"), ...after].join("\n");
  }
  try {
    writeFileSync(file, next);
  } catch (e) {
    return err("io", (e as Error).message);
  }
  const add = git(s.worktree, "add", doc.path);
  const commit = add.ok ? git(s.worktree, "commit", "-q", "--amend", "--no-edit") : add;
  return commit.ok ? ok(undefined) : err("io", commit.error.message);
}
