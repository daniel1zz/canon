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
import { isWorker } from "../delegation/worker.ts";
import { workerNewWorkError } from "../delegation/access.ts";

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
  /** The test files the latest failure named, sorted by path (BR-2599). */
  readonly files: readonly string[];
  /**
   * Why `files` is empty: the floor writes no report, or it failed before the tests; null when files are named, or on a
   * record written before canon recorded them.
   */
  readonly filesUnknown: FilesUnknown | null;
}

export type FilesUnknown = "no-report" | "before-tests";

type Row = Omit<RedMain, "files" | "filesUnknown"> & { readonly files: string | null; readonly files_unknown: string | null };

export function redMain(db: CoordDb): RedMain | undefined {
  const row = db.db.query<Row, []>("SELECT sha, first_sha, log, tail, since, green, change, fix_pid, fix_start, files, files_unknown FROM red_main WHERE id = 1").get();
  if (!row) return undefined;
  const { files, files_unknown, ...rest } = row;
  const unknown = files_unknown === "no-report" || files_unknown === "before-tests" ? files_unknown : null;
  return { ...rest, files: files ? (JSON.parse(files) as string[]) : [], filesUnknown: unknown };
}

/**
 * Records a background failure (BR-2220): a new record when there is none; otherwise only its failing commit, log,
 * output tail and failing test files change (BR-2599), never when it began, the last passing commit or the fix change.
 * `reported` says whether the floor writes a report: only then does an empty `files` mean it failed before the tests.
 */
export function recordFailure(db: CoordDb, f: { sha: string; log: string; tail: string; green: string | null; fixLanded?: boolean; files: readonly string[]; reported: boolean }): void {
  const now = new Date().toISOString();
  const files = [...new Set(f.files)].sort();
  const unknown: FilesUnknown | null = files.length > 0 ? null : f.reported ? "before-tests" : "no-report";
  // reason: a fix change that has landed and is part of the commit that still fails has done what it could; the record must not keep naming it, or no one can open the next fix (BR-2221).
  if (f.fixLanded) db.db.query("UPDATE red_main SET change = NULL, fix_pid = NULL, fix_start = NULL WHERE id = 1").run();
  db.db
    .query(
      "INSERT INTO red_main(id, sha, first_sha, log, tail, since, green, updated_at, files, files_unknown) VALUES (1, ?1, ?1, ?2, ?3, ?4, ?5, ?4, ?6, ?7) ON CONFLICT(id) DO UPDATE SET sha = excluded.sha, log = excluded.log, tail = excluded.tail, updated_at = excluded.updated_at, files = excluded.files, files_unknown = excluded.files_unknown",
    )
    .run(f.sha, f.log, f.tail, now, f.green, JSON.stringify(files), unknown);
}

/**
 * Whether the automatic revert has its result for this record (BR-2601, BR-2598): since the record began, a
 * `revert.skip`, or a revert (`land.revert`) after which the background floor failed again. Without a live watcher
 * nothing is locating or reverting any more, so that counts as a result too.
 */
export function revertSettled(db: CoordDb, r: RedMain): boolean {
  if (db.db.query("SELECT 1 FROM events WHERE kind = 'revert.skip' AND ts >= ? LIMIT 1").get(r.since)) return true;
  const failedAfterRevert = db.db
    .query("SELECT 1 FROM events f WHERE f.kind = 'floor.fail' AND EXISTS (SELECT 1 FROM events v WHERE v.kind = 'land.revert' AND v.ts >= ? AND v.id < f.id) LIMIT 1")
    .get(r.since);
  if (failedAfterRevert) return true;
  // reason: a watcher that died while locating never records a result; without this the reminder would never come and the hint would keep saying wait (D-155)
  const w = db.db.query<{ pid: number; pid_start: string }, []>("SELECT pid, pid_start FROM watcher WHERE id = 1").get();
  return !w || isGone({ pid: w.pid, start: w.pid_start }) === true;
}

/** Main passed: the record goes (BR-2222). */
export function clearRedMain(db: CoordDb): void {
  db.db.query("DELETE FROM red_main WHERE id = 1").run();
}

/** Whether the fix change on the record has landed and `sha` contains the commit it landed as (BR-2221). */
export function fixLandedIn(ws: Workspace, sha: string): boolean {
  const change = redMain(ws.db)?.change;
  if (!change) return false;
  const rows = ws.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'land.ok' AND subject = ? ORDER BY id").all(change);
  return rows.some((r) => {
    const landed = (JSON.parse(r.detail) as { sha?: string }).sha;
    return landed !== undefined && git(ws.primary, "merge-base", "--is-ancestor", landed, sha).ok;
  });
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
export function redMainNotice(db: CoordDb, mine: string | undefined, actor: string): string[] {
  const r = redMain(db);
  if (!r) return [];
  const lines = [
    redMainHead(r),
    `  log: ${r.log}`,
    "  last lines of its output:",
    ...r.tail.trimEnd().split("\n").slice(-10).map((l) => `    ${l}`),
    `  last passing commit: ${r.green ? short(r.green) : "none recorded"}`,
  ];
  const files = filesLine(r);
  if (files) lines.push(files);
  lines.push(redMainFixer(db, r, actor));
  if (mine && mine === r.change) lines.push(`  ${mine} is the change that fixes it.`);
  else if (mine) lines.push(`  These failures are not caused by ${mine}: do not fix them in ${mine}; its own tests may fail for the same reason.`);
  return lines;
}

const redMainHead = (r: RedMain) => {
  const since = r.first_sha === r.sha ? short(r.sha) : `${short(r.first_sha)} (latest failing commit ${short(r.sha)})`;
  return `main is failing floor since ${since}, first failed at ${r.since} (canon floor watch, D-31)`;
};

/** The most failing test files the brief names (BR-2599). */
const FILES_SHOWN = 10;

/** The brief's line about which test files fail (BR-2599); undefined on a record written before canon recorded them. */
function filesLine(r: RedMain): string | undefined {
  if (r.files.length > 0) {
    const more = r.files.length > FILES_SHOWN ? ` … and ${r.files.length - FILES_SHOWN} more` : "";
    return `  failing test files (${r.files.length}): ${r.files.slice(0, FILES_SHOWN).join(", ")}${more}`;
  }
  if (r.filesUnknown === "no-report") return "  failing test files: not known, the floor writes no report ({report})";
  if (r.filesUnknown === "before-tests") return "  failing test files: none, it failed before the tests (setup or typecheck)";
  return undefined;
}

/** Who fixes a failing main, worded for the caller (BR-2598): a worker tells its main session; a main session opens the fix even with a claimed change. */
function redMainFixer(db: CoordDb, r: RedMain, actor: string): string {
  if (r.change) return `  being fixed in ${r.change}`;
  if (r.fix_pid !== null) return "  a session is opening the fix change right now (canon work start --fix-main)";
  // reason: a fix change stops the automatic revert from locating the landing (BR-2535), so nobody is sent to open one before it has its result (BR-2598)
  if (!revertSettled(db, r)) return "  the automatic revert is still locating or reverting the landing that broke it: do not open a fix change yet (BR-2535)";
  if (isWorker(actor)) return "  nobody is fixing it yet: tell the main session that delegated your change; a worker cannot open the fix change (D-155)";
  return "  nobody is fixing it yet: whichever session sees this opens the fix change with `canon work start --fix-main`, even one holding a claimed change: stop that change first (canon work stop) or delegate it, and come back to it after the fix lands (D-155)";
}

/** The two lines of the brief's block that `canon work land` repeats with its result (BR-2306); empty when main is not failing. */
export function redMainLandingLines(db: CoordDb, actor: string): string[] {
  const r = redMain(db);
  return r ? [redMainHead(r), redMainFixer(db, r, actor)] : [];
}

/**
 * What `canon work test` says before its run and again after it while main is failing (BR-2600): one line naming the
 * fix change when there is one, else the head and BR-2598's hint; empty when main is not failing.
 */
export function redMainTestLines(db: CoordDb, actor: string): string[] {
  const r = redMain(db);
  if (!r) return [];
  if (r.change) return [`${redMainHead(r)}: being fixed in ${r.change}`];
  return [redMainHead(r), redMainFixer(db, r, actor)];
}

/** The failed files of a `canon work test` run that the failing-main record names too (BR-2600); empty with a fix change. */
export function failingOnMainToo(db: CoordDb, failed: readonly string[]): string[] {
  const r = redMain(db);
  if (!r || r.change) return [];
  const onMain = new Set(r.files);
  return failed.filter((f) => onMain.has(f));
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
  if (isWorker(ws.actor)) return workerNewWorkError();
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
  // reason: canon opens this change itself, so it states the fields for the session: fixing main needs no owner approval and advances no success criterion (BR-2623, D-155)
  const s = start(ws, { title: fixTitle(r.sha), fields: { owner_gate: "none: fixing main's failing floor (D-155)", advances: "none: fixing main's failing floor (D-155)" } }, say, { fixMain: true });
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
