import { mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readConfig, type Config } from "../../invocation/config.ts";
import { addWorktree, git, pruneWorktrees, removeWorktree } from "../../kernel/git.ts";
import { touchedClasses } from "../../knowledge/check/design-basis/design-basis.ts";
import { floorWithReport } from "../land/checks/floor.ts";
import { REPORT_PLACEHOLDER } from "../verify/report.ts";
import { commandFor } from "../verify/verify.ts";
import { moveMain } from "../land/finish/finish.ts";
import { pushMain } from "../remote/remote.ts";
import type { Say, Workspace } from "../workspace.ts";
import { redMain } from "./redmain.ts";
import { runLogged, shellQuote } from "./run.ts";
import { canonCommand } from "./watch.ts";

/**
 * Auto-revert after a real background failure (D-137): find the first landing between the last green commit and the
 * failing one (BR-2535), revert it when the reverted tree checks out, and send the change back to its branch with its
 * work replayed (BR-2536). Anything that does not hold falls back to the forward fix (BR-2221) with a `revert.skip`.
 */

/** The trailer that marks a revert commit canon made, so a watcher killed after moving main can finish it (BR-2536). */
export const TRAILER = "Canon-Reverts:";

export interface Landing {
  readonly subject: string | null;
  readonly sha: string;
  readonly base: string;
}

/** What one failure needs: the commit, its log and the failing test files (empty when it failed before the tests, or when the floor writes no report). */
export interface Failure {
  readonly sha: string;
  readonly log: string;
  readonly fd: number;
  readonly files: readonly string[];
  /** Whether the floor holds `{report}`: only then does an empty `files` mean it failed outside the test files (BR-2535). */
  readonly reported: boolean;
}

type Outcome = { kind: "reverted"; subject: string; revert: string; branch: string | null } | { kind: "skipped"; reason: string };

const skip = (reason: string): Outcome => ({ kind: "skipped", reason });

/** The landings on main's first-parent chain after `green` up to `tip`, oldest first, that recorded their base (BR-2535). */
export function landingsBetween(ws: Workspace, green: string, tip: string): Landing[] {
  const chain = git(ws.primary, "rev-list", "--first-parent", "--reverse", `${green}..${tip}`);
  if (!chain.ok || chain.value === "") return [];
  const rows = ws.db.db.query<{ subject: string | null; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'land.ok'").all();
  const bySha = new Map<string, Landing>();
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { sha?: unknown; base?: unknown };
    if (typeof d.sha === "string" && typeof d.base === "string") bySha.set(d.sha, { subject: r.subject, sha: d.sha, base: d.base });
  }
  return chain.value.split("\n").flatMap((sha) => bySha.get(sha) ?? []);
}

/** A detached worktree at `sha` for the duration of `use`; removed afterwards. */
async function atCommit<T>(ws: Workspace, sha: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(dirname(ws.db.db.filename), `revert-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  pruneWorktrees(ws.primary);
  const added = addWorktree(ws.primary, "-q", "--detach", dir, sha);
  if (!added.ok) throw new Error(`cannot create a worktree at ${sha.slice(0, 9)}: ${added.error.message}`);
  try {
    return await use(dir);
  } finally {
    removeWorktree(ws.primary, "--force", dir);
  }
}

/** Runs the failing test files with `test_command`, one at a time; a file missing here passes (BR-2535). */
export async function runFiles(config: Config, dir: string, files: readonly string[], fd: number): Promise<boolean> {
  if (!config.testCommand) return false;
  for (const file of files) {
    if (!git(dir, "cat-file", "-e", `HEAD:${file}`).ok) continue;
    const reports = mkdtempSync(join(tmpdir(), "canon-probe-"));
    try {
      const report = config.testCommand.includes(REPORT_PLACEHOLDER) ? join(reports, "report.xml") : undefined;
      if ((await runLogged(commandFor(config.testCommand, file, report), dir, fd)) !== 0) return false;
    } finally {
      rmSync(reports, { recursive: true, force: true });
    }
  }
  return true;
}

/** The whole floor on the tree in `dir`, in a machine slot like every full run (BR-2535, BR-2576); its report goes to a temporary file. */
async function wholeFloor(ws: Workspace, c: Config, dir: string, fd: number): Promise<boolean> {
  if (!c.floor) return false;
  const reports = mkdtempSync(join(tmpdir(), "canon-probe-"));
  try {
    const command = c.floor.replaceAll(REPORT_PLACEHOLDER, shellQuote(join(reports, "report.xml")));
    const say = (line: string) => void writeSync(fd, `${line}\n`);
    return (await floorWithReport(ws.db, c, dir, command, (cmd) => runLogged(cmd, dir, fd), say, undefined, { actor: ws.actor, worktree: dir, say })) === 0;
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
}

/**
 * Setup, then the probe: the failing files; else typecheck_command when the floor's report showed the failure was not in
 * a test file; else the whole floor (BR-2535).
 */
async function probeIn(ws: Workspace, dir: string, f: Failure): Promise<boolean> {
  const config = readConfig(dir);
  if (!config.ok) return false;
  const c = config.value;
  if (c.setup && (await runLogged(c.setup, dir, f.fd)) !== 0) return false;
  if (f.files.length > 0 && c.testCommand) return runFiles(c, dir, f.files, f.fd);
  // reason: without a report canon does not know which test failed; typecheck_command passes on such a commit too and would clear every landing (BR-2535)
  if (f.reported && c.typecheckCommand) return (await runLogged(c.typecheckCommand, dir, f.fd)) === 0;
  return wholeFloor(ws, c, dir, f.fd);
}

async function probe(ws: Workspace, f: Failure, sha: string, what: string): Promise<boolean> {
  writeSync(f.fd, `\ncanon: probing ${what} ${sha.slice(0, 9)}\n`);
  const passed = await atCommit(ws, sha, (dir) => probeIn(ws, dir, f));
  writeSync(f.fd, `canon: ${what} ${sha.slice(0, 9)} ${passed ? "passes" : "fails"}\n`);
  return passed;
}

/** A landing where the probe turns from passing (the one before it, or green) to failing, found by bisection that assumes it keeps failing after; or why there is none (BR-2535). */
export async function locate(ws: Workspace, f: Failure): Promise<Landing | string> {
  const red = redMain(ws.db);
  const green = red?.green ?? null;
  if (!green) return "no commit has passed the background floor (no refs/canon/green)";
  if (red?.change) return `${red.change} is already fixing main`;
  if (revertedSince(ws, red!.since)) return "a landing was already reverted since main began failing";
  const cands = landingsBetween(ws, green, f.sha);
  if (cands.length === 0) return `no landing between ${green.slice(0, 9)} and ${f.sha.slice(0, 9)} recorded its base`;
  if (!(await probe(ws, f, green, "the last green commit"))) return `the probe fails on the last green commit ${green.slice(0, 9)} too, so it cannot tell landings apart`;
  let lo = -1;
  let hi = cands.length - 1;
  if (await probe(ws, f, cands[hi]!.sha, cands[hi]!.subject ?? "landing")) return `the probe passes on the last landing ${cands[hi]!.sha.slice(0, 9)} too, so it does not reproduce the failure and cannot tell landings apart`;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await probe(ws, f, cands[mid]!.sha, cands[mid]!.subject ?? "landing")) lo = mid;
    else hi = mid;
  }
  return cands[hi]!;
}

/**
 * Whether a revert reached main since `since` (one automatic revert per failing-main record, BR-2535). `revert.start` is
 * written before main is moved, so a start whose commit never reached main, because main kept moving, is no revert.
 */
function revertedSince(ws: Workspace, since: string): boolean {
  const rows = ws.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'revert.start' AND ts >= ?").all(since);
  return rows.some((r) => {
    const sha = (JSON.parse(r.detail) as { revert?: unknown }).revert;
    return typeof sha === "string" && git(ws.primary, "merge-base", "--is-ancestor", sha, `refs/heads/${ws.config.main}`).ok;
  });
}

/** The change file's path at `sha`, or undefined. */
function changePath(dir: string, sha: string, subject: string): string | undefined {
  const found = git(dir, "grep", "-l", `^id: ${subject}$`, sha, "--", "canon/changes");
  return found.ok ? found.value.split("\n")[0]?.replace(/^[^:]+:/, "") : undefined;
}

/** Writes the change file as it was at `sha`, status open (BR-2536). */
function reopen(dir: string, sha: string, subject: string): boolean {
  const path = changePath(dir, sha, subject);
  if (!path) return false;
  const text = git(dir, "show", `${sha}:${path}`);
  if (!text.ok) return false;
  // reason: the revert may have removed the directory with the file, when it was the only change file (BR-2536)
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), `${text.value.replace(/^status: .*$/m, "status: open")}\n`);
  return git(dir, "add", "--", path).ok;
}

/** Runs typecheck_command, the failing files (the whole floor when it writes no report) and canon check on the tree in `dir` (BR-2536 step 3); undefined when all pass. */
async function checkTree(ws: Workspace, dir: string, f: Failure): Promise<string | undefined> {
  const { files, fd } = f;
  const config = readConfig(dir);
  if (!config.ok) return `its canon/config.yaml cannot be read: ${config.error.message}`;
  const c = config.value;
  if (c.setup && (await runLogged(c.setup, dir, fd)) !== 0) return "setup fails on the reverted tree";
  if (c.typecheckCommand && (await runLogged(c.typecheckCommand, dir, fd)) !== 0) return "typecheck_command fails on the reverted tree";
  if (files.length > 0 && !(await runFiles(c, dir, files, fd))) return "the failing test files still fail on the reverted tree";
  if (!f.reported && !(await wholeFloor(ws, c, dir, fd))) return "the floor still fails on the reverted tree";
  if ((await runLogged(`${canonCommand().map(shellQuote).join(" ")} check`, dir, fd)) !== 0) return "canon check fails on the reverted tree";
  return undefined;
}

/** Steps 2 to 4 of BR-2536 once, on main as it is now. */
async function revertOnce(ws: Workspace, say: Say, f: Failure, l: Landing & { subject: string }): Promise<{ moved: string } | { again: true } | { reason: string }> {
  const main = ws.config.main;
  const m = git(ws.primary, "rev-parse", "--verify", `refs/heads/${main}^{commit}`);
  if (!m.ok) return { reason: `cannot read ${main}: ${m.error.message}` };
  return atCommit(ws, m.value, async (dir) => {
    const rev = git(dir, "revert", "--no-commit", "--no-edit", `${l.base}..${l.sha}`);
    if (!rev.ok) {
      git(dir, "revert", "--abort");
      return { reason: `reverting ${l.subject} conflicts with later commits on ${main}` };
    }
    if (!reopen(dir, l.sha, l.subject)) return { reason: `cannot find ${l.subject}'s change file at ${l.sha.slice(0, 9)}` };
    const msg = `canon: revert ${l.subject} (the background floor failed on ${f.sha.slice(0, 9)})\n\nFailing: ${f.files.length > 0 ? f.files.join(", ") : "before the tests (setup or typecheck)"}\nLog: ${f.log}\n\n${TRAILER} ${l.subject} ${l.sha}`;
    const committed = git(dir, "-c", "user.name=canon", "-c", "user.email=canon@localhost", "commit", "-q", "--no-verify", "-m", msg);
    if (!committed.ok) return { reason: `cannot commit the revert: ${committed.error.message}` };
    const failed = await checkTree(ws, dir, f);
    if (failed) return { reason: failed };
    const r = git(dir, "rev-parse", "HEAD");
    if (!r.ok) return { reason: r.error.message };
    ws.db.event(ws.actor, "revert.start", l.subject, { landing: l.sha, revert: r.value, failed_on: f.sha, files: f.files, log: f.log });
    const moved = moveMain(ws, m.value, r.value);
    if (moved === "moved") {
      pushMain(ws, say);
      return { moved: r.value };
    }
    return moved.reason === "main-moved" ? { again: true as const } : { reason: moved.message };
  });
}

/** Step 5 of BR-2536: `change/<subject>` on the reverted main with the landing's work replayed; null when the branch already exists. */
async function replayBranch(ws: Workspace, subject: string, revert: string, landing: string, files: readonly string[]): Promise<string | null> {
  const branch = `change/${subject}`;
  if (git(ws.primary, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok) return null;
  return atCommit(ws, revert, async (dir) => {
    const r = git(dir, "revert", "--no-commit", "--no-edit", revert);
    if (!r.ok) throw new Error(`cannot replay ${subject} on its branch: ${r.error.message}`);
    reopen(dir, landing, subject);
    const msg = `canon: replay ${subject} after its revert\n\nThe background floor failed with this work on main and it was reverted. Fix the failure here, then land again.\nFailing: ${files.length > 0 ? files.join(", ") : "before the tests (setup or typecheck)"}`;
    const c = git(dir, "-c", "user.name=canon", "-c", "user.email=canon@localhost", "commit", "-q", "--no-verify", "-m", msg);
    if (!c.ok) throw new Error(`cannot commit the replay of ${subject}: ${c.error.message}`);
    const b = git(dir, "branch", branch, "HEAD");
    if (!b.ok) throw new Error(`cannot create ${branch}: ${b.error.message}`);
    return branch;
  });
}

/** Steps 5 and 6 of BR-2536. */
async function sendBack(ws: Workspace, subject: string, landing: string, revert: string, files: readonly string[], log: string): Promise<string | null> {
  const branch = await replayBranch(ws, subject, revert, landing, files);
  ws.db.event(ws.actor, "land.revert", subject, { landing, revert, branch: branch ?? `change/${subject} already existed; not replaced`, files, log });
  return branch;
}

/** BR-2535 then BR-2536 for a failure already recorded as main failing (BR-2220); an error on the way is a skip with its message. */
export async function revertBad(ws: Workspace, say: Say, f: Failure): Promise<Outcome> {
  try {
    return await locateAndRevert(ws, say, f);
  } catch (e) {
    return skipped(ws, say, f, `the automatic revert stopped: ${(e as Error).message}`);
  }
}

async function locateAndRevert(ws: Workspace, say: Say, f: Failure): Promise<Outcome> {
  const found = await locate(ws, f);
  if (typeof found === "string") return skipped(ws, say, f, found);
  if (!found.subject || found.subject.startsWith("chore-")) return skipped(ws, say, f, `the landing ${found.sha.slice(0, 9)} is a chore, with no change to send back`);
  const diff = git(ws.primary, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", found.base, found.sha);
  const doors = diff.ok ? touchedClasses(diff.value.split("\n").filter((p) => p !== ""), ws.config.designSignals) : new Map();
  if (doors.size > 0) return skipped(ws, say, f, `${found.subject} touched ${[...doors.keys()].join(", ")} (design_signals), which a revert of its code cannot undo`);
  const l = { ...found, subject: found.subject };
  for (let i = 0; i < 3; i++) {
    const r = await revertOnce(ws, say, f, l);
    if ("reason" in r) return skipped(ws, say, f, r.reason);
    if ("moved" in r) {
      const branch = await sendBack(ws, l.subject, l.sha, r.moved, f.files, f.log);
      say(`floor watch: reverted ${l.subject} on ${ws.config.main} (${r.moved.slice(0, 9)}); its work is replayed on ${branch ?? `change/${l.subject} (already there)`}: canon work start ${l.subject}`);
      return { kind: "reverted", subject: l.subject, revert: r.moved, branch };
    }
  }
  return skipped(ws, say, f, `${ws.config.main} kept moving while the revert of ${l.subject} was checked`);
}

function skipped(ws: Workspace, say: Say, f: Failure, reason: string): Outcome {
  writeSync(f.fd, `canon: not reverted: ${reason}\n`);
  ws.db.event(ws.actor, "revert.skip", null, { failed_on: f.sha, reason, log: f.log });
  say(`floor watch: no landing reverted (${reason}); main is left for a fix change (canon work start --fix-main)`);
  return skip(reason);
}

/** Before a test: revert commits on main with the trailer but no `land.revert` get their branch and event (BR-2536). */
export async function finishInterrupted(ws: Workspace, say: Say): Promise<void> {
  const log = git(ws.primary, "log", "--first-parent", "-n", "200", "--format=%H%x00%B%x1e", `refs/heads/${ws.config.main}`);
  if (!log.ok) return;
  for (const entry of log.value.split("\u001e")) {
    const [sha, body] = entry.trim().split("\u0000");
    const m = body ? new RegExp(`^${TRAILER} (\\S+) ([0-9a-f]{40})$`, "m").exec(body) : null;
    if (!sha || !m) continue;
    const done = ws.db.db.query("SELECT 1 FROM events WHERE kind = 'land.revert' AND json_extract(detail, '$.revert') = ? LIMIT 1").get(sha);
    if (done) continue;
    const start = ws.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'revert.start' AND json_extract(detail, '$.revert') = ? ORDER BY id DESC LIMIT 1").get(sha);
    const d = start ? (JSON.parse(start.detail) as { files?: string[]; log?: string }) : {};
    const branch = await sendBack(ws, m[1]!, m[2]!, sha, d.files ?? [], d.log ?? "");
    say(`floor watch: finished the interrupted revert of ${m[1]}: ${branch ?? "its branch was already there"}`);
  }
}

/** The changes reverted and not landed since, for `canon work due` (BR-2536). */
export function revertedChanges(ws: Workspace): { subject: string; since: string; files: string[] }[] {
  const rows = ws.db.db.query<{ id: number; ts: string; subject: string; detail: string }, []>("SELECT id, ts, subject, detail FROM events WHERE kind = 'land.revert' ORDER BY id").all();
  const latest = new Map<string, { id: number; ts: string; files: string[] }>();
  for (const r of rows) latest.set(r.subject, { id: r.id, ts: r.ts, files: (JSON.parse(r.detail) as { files?: string[] }).files ?? [] });
  return [...latest].flatMap(([subject, v]) => {
    const landed = ws.db.db.query("SELECT 1 FROM events WHERE kind = 'land.ok' AND subject = ? AND id > ? LIMIT 1").get(subject, v.id);
    return landed ? [] : [{ subject, since: v.ts, files: v.files }];
  });
}

/** Files that passed on a rerun in the last 7 days, newest event first, for `canon work due` (BR-2534). */
export function flakyFiles(ws: Workspace, now: number): { file: string; since: string }[] {
  const from = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const rows = ws.db.db.query<{ ts: string; detail: string }, [string]>("SELECT ts, detail FROM events WHERE kind = 'floor.flaky' AND ts >= ? ORDER BY id DESC").all(from);
  const seen = new Map<string, string>();
  for (const r of rows) for (const file of (JSON.parse(r.detail) as { files?: string[] }).files ?? []) if (!seen.has(file)) seen.set(file, r.ts);
  return [...seen].map(([file, since]) => ({ file, since }));
}

