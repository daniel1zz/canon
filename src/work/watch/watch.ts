import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { CoordDb } from "../db.ts";
import type { Say, Workspace } from "../workspace.ts";
import { readConfig } from "../../config/config.ts";
import { logFile, runHooks } from "../../config/hooks.ts";
import { noPort } from "../../config/ports.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { addWorktree, git, pruneWorktrees, removeWorktree } from "../../kernel/git.ts";
import { isGone, selfProcess, type Proc } from "../claims/liveness.ts";
import type { FloorTiming } from "./config-keys.ts";
import { clearRedMain, fixLandedIn, recordFailure } from "./redmain.ts";
import { stopStarted } from "./stop.ts";

/**
 * Merge-then-test (D-31): with `floor_timing: after`, landings move main without the floor and `canon floor watch`
 * tests main's latest commit in the background, one run at a time, in a temporary worktree (BR-2219). A failure is
 * recorded for a fix change (BR-2220); a pass moves refs/canon/green and runs after_green (BR-2222). After an
 * after_green that rebuilt PATH's canon the watcher hands the next test to that canon and ends (BR-2251).
 */

/** The last commit the background floor passed on (BR-2222). */
export const GREEN_REF = "refs/canon/green";

/** floor_timing as committed on main's tip, which decides whether main is watched (BR-2218, BR-2219). */
export function timingOnMain(ws: Workspace): FloorTiming {
  const text = git(ws.primary, "show", `refs/heads/${ws.config.main}:canon/config.yaml`);
  // reason: a main without canon/config.yaml has the default, before; an unreadable one fails every command anyway (BR-2045).
  if (!text.ok) return "before";
  try {
    const raw = parse(text.value) as Record<string, unknown> | null;
    return raw?.["floor_timing"] === "after" ? "after" : "before";
  } catch {
    return "before";
  }
}

/** floor_timing of the tree checked out in `wt`: the landing tree decides, as it decides the floor command (BR-2218). */
export function timingOf(wt: string): FloorTiming {
  const c = readConfig(wt);
  return c.ok ? c.value.floorTiming : "before";
}

/**
 * Whether the canon on PATH, the one sessions run after this landing, can read the config of the tree in `wt`
 * (BR-2224). In after mode PATH's canon is rebuilt only from a passed commit (BR-2222), so a key added and used in
 * one landing would leave every session's canon failing on main's config until the background floor passes.
 */
export function pathCanonReads(wt: string): Result<void> {
  const bin = pathCanon();
  if (!bin) return err("invalid", "canon is not on PATH, so nothing shows that the canon sessions run after this landing can read its canon/config.yaml (floor_timing: after, BR-2224)");
  const r = Bun.spawnSync([bin, "config", "--schema"], { cwd: wt, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  if (r.exitCode === 0) return ok(undefined);
  const said = r.stderr.toString().trim().split("\n").slice(0, 5).map((l) => `  ${l}`).join("\n");
  return err(
    "invalid",
    `the canon on PATH (${bin}) cannot read this landing's canon/config.yaml: \`canon config --schema\` exited ${r.exitCode ?? "on a signal"}${said ? `\n${said}` : ""}\n` +
      "With floor_timing after, PATH's canon is rebuilt only once main passes its background floor (after_green), so land a new config key first, " +
      "and use it in another landing after main has passed (BR-2224).",
  );
}

/** The canon PATH names now, or null when there is none. */
function pathCanon(): string | null {
  // reason: PATH is read at the call, not as it was when the process started, so the canon looked up is the one PATH names now.
  return Bun.which("canon", { PATH: process.env["PATH"] ?? "" });
}

/** Whether the background floor already ran on `sha` (BR-2219): a pass or a failure, either way it is not run again. */
export function tested(db: CoordDb, sha: string): boolean {
  return db.db.query("SELECT 1 FROM events WHERE kind IN ('floor.pass', 'floor.fail') AND json_extract(detail, '$.sha') = ? LIMIT 1").get(sha) !== null;
}

interface WatcherRow {
  readonly pid: number;
  readonly pid_start: string;
  readonly sha: string | null;
}

/** The watcher recorded as running, when its process is not provably gone (an unreadable process table counts as alive, D-11). */
export function liveWatcher(db: CoordDb): WatcherRow | undefined {
  const row = db.db.query<WatcherRow, []>("SELECT pid, pid_start, sha FROM watcher WHERE id = 1").get();
  if (!row) return undefined;
  return isGone({ pid: row.pid, start: row.pid_start }) === true ? undefined : row;
}

/** Becomes the one watcher, taking over from one whose process is gone; false while another is alive (BR-2219). */
function claimWatcher(db: CoordDb, self: Proc): boolean {
  return db.db
    .transaction(() => {
      const row = db.db.query<WatcherRow, []>("SELECT pid, pid_start, sha FROM watcher WHERE id = 1").get();
      if (row && !(row.pid === self.pid && row.pid_start === self.start) && isGone({ pid: row.pid, start: row.pid_start }) !== true) return false;
      db.db.query("INSERT OR REPLACE INTO watcher(id, pid, pid_start, sha, started_at) VALUES (1, ?, ?, NULL, ?)").run(self.pid, self.start, new Date().toISOString());
      return true;
    })
    .immediate();
}

function releaseWatcher(db: CoordDb, self: Proc): void {
  db.db.query("DELETE FROM watcher WHERE id = 1 AND pid = ? AND pid_start = ?").run(self.pid, self.start);
}

/** The temporary worktree the background floor runs in, under the git common dir (BR-2219). */
export const watchDir = (db: CoordDb) => join(dirname(db.db.filename), "watch");

/** What one `canon floor watch` did: each commit it tested and whether its floor passed. */
export interface Watched {
  readonly ran: boolean;
  readonly tested: readonly { readonly sha: string; readonly passed: boolean; readonly log: string }[];
  /** The passed commit after whose rebuild the next test went to PATH's canon (BR-2251). */
  readonly rebuiltAt?: string;
}

type Tested = { readonly sha: string; readonly passed: boolean; readonly log: string };

/** One tested commit, and whether after_green ran and every command of it exited 0 (BR-2251). */
type TestedHere = Tested & { readonly rebuilt?: boolean };

/**
 * `canon floor watch` (BR-2219): unless another watcher is alive, tests main's latest commit, then the latest again
 * while main moved meanwhile, until the latest is tested; commits in between are skipped.
 */
export async function watch(ws: Workspace, say: Say): Promise<Result<Watched>> {
  if (timingOnMain(ws) !== "after") {
    say(`floor_timing on ${ws.config.main} is not \`after\`: main is tested before it moves, so there is nothing to watch`);
    return ok({ ran: false, tested: [] });
  }
  const self = selfProcess();
  if (!self) return err("io", "cannot read this process's start time from ps, so this watcher cannot record itself");
  const dir = watchDir(ws.db);
  const results: Tested[] = [];
  let mine = false;
  let busy = false;
  let stopping = false;
  // reason: a watcher stopped by a signal sends SIGTERM to what it started and gives up its place without waiting;
  // what they do after that is theirs, and after_green must be safe to run again (BR-2285, D-55).
  const onSignal = (signal: NodeJS.Signals) => {
    // reason: SIGTERM to its own group reaches this process too; that second delivery is ignored.
    if (stopping) return;
    stopping = true;
    stopStarted();
    if (existsSync(dir)) removeWorktree(ws.primary, "--force", dir);
    if (mine) releaseWatcher(ws.db, self);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    for (;;) {
      if (!claimWatcher(ws.db, self)) {
        busy = true;
        break;
      }
      mine = true;
      for (;;) {
        const tip = git(ws.primary, "rev-parse", "--verify", `refs/heads/${ws.config.main}`);
        if (!tip.ok) return err("io", tip.error.message);
        if (tested(ws.db, tip.value)) break;
        ws.db.db.query("UPDATE watcher SET sha = ? WHERE id = 1 AND pid = ?").run(tip.value, self.pid);
        const r = await testCommit(ws, say, tip.value);
        if (!r.ok) return r;
        results.push({ sha: r.value.sha, passed: r.value.passed, log: r.value.log });
        if (!r.value.rebuilt) continue;
        const handed = handOff(ws, say, self, tip.value);
        mine = handed !== "handed" && handed.ok && handed.value;
        if (handed === "handed") return ok({ ran: true, tested: results, rebuiltAt: tip.value });
        if (!handed.ok) return handed;
        // reason: another watcher took the place meanwhile; it tests main's latest commit (BR-2219).
        if (!handed.value) return ok({ ran: true, tested: results });
      }
      releaseWatcher(ws.db, self);
      mine = false;
      // reason: a landing that moved main just before the release saw this watcher alive and started none; look once more (BR-2219).
      const tip = git(ws.primary, "rev-parse", "--verify", `refs/heads/${ws.config.main}`);
      if (!tip.ok || tested(ws.db, tip.value)) break;
    }
    if (busy && results.length === 0) say("another canon floor watch is running; it tests main's latest commit");
    else if (results.length === 0) say(`${ws.config.main}'s latest commit is already tested`);
    return ok({ ran: results.length > 0, tested: results });
  } finally {
    if (mine) releaseWatcher(ws.db, self);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/**
 * After after_green rebuilt PATH's canon from `sha` (BR-2251): gives up this watcher's place, starts PATH's
 * `canon floor watch` and records floor.handoff; "handed" then, and this watcher ends. When it cannot hand off (no
 * canon on PATH, or it would not start) it keeps or takes its place back: true when it holds it again, false when
 * another watcher took it meanwhile.
 */
function handOff(ws: Workspace, say: Say, self: Proc, sha: string): "handed" | Result<boolean> {
  const bin = pathCanon();
  if (!bin) {
    say("floor watch: after_green passed but canon is not on PATH, so this watcher goes on testing (BR-2251)");
    return ok(true);
  }
  // reason: the place is given up before PATH's canon starts, or it would find this watcher alive and end (BR-2251).
  releaseWatcher(ws.db, self);
  const started = spawnWatcher(ws, [bin, "floor", "watch"]);
  if (!started.ok) {
    say(`floor watch: ${started.error.message}; this watcher goes on testing (BR-2251)`);
    return ok(claimWatcher(ws.db, self));
  }
  try {
    ws.db.event(ws.actor, "floor.handoff", null, { sha, to: bin, log: started.value });
  } catch (e) {
    return err("io", `${bin} tests ${ws.config.main} from now on, but the handoff after ${sha.slice(0, 9)} cannot be recorded (${(e as Error).message})`);
  }
  say(`floor watch: after_green rebuilt from ${ws.config.main} ${sha.slice(0, 9)}; ${bin} tests from now on (log: ${started.value})`);
  return "handed";
}

/** Runs `command` in `cwd` with its output appended to the log behind `fd`. */
async function runLogged(command: string, cwd: string, fd: number, env?: Record<string, string>): Promise<number> {
  writeSync(fd, `$ ${command}\n`);
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: fd, stderr: fd, stdin: "ignore", ...(env ? { env: { ...(process.env as Record<string, string>), ...env } } : {}) });
  return await proc.exited;
}

/**
 * Tests one commit (BR-2219): a fresh detached worktree at it, setup, then the floor, both into `watch-<sha12>.log`;
 * records floor.pass or floor.fail, then the pass (BR-2222) or the failure (BR-2220); removes the worktree last.
 */
async function testCommit(ws: Workspace, say: Say, sha: string): Promise<Result<TestedHere>> {
  const dir = watchDir(ws.db);
  const log = logFile(ws.db, `watch-${sha.slice(0, 12)}.log`);
  rmSync(dir, { recursive: true, force: true });
  pruneWorktrees(ws.primary);
  const added = addWorktree(ws.primary, "-q", "--detach", dir, sha);
  if (!added.ok) return err("io", `cannot create the worktree to test ${sha.slice(0, 9)} in: ${added.error.message}`);
  try {
    say(`floor watch: testing ${ws.config.main} ${sha.slice(0, 9)} (log: ${log})`);
    mkdirSync(dirname(log), { recursive: true });
    const fd = openSync(log, "w");
    let code: number;
    let why: string;
    // reason: the tested commit's own config names its setup, floor and after_green, as a landing reads the landing tree's (BR-2218).
    const config = readConfig(dir);
    try {
      if (!config.ok) {
        writeSync(fd, `${config.error.message}\n`);
        code = 2;
        why = "its canon/config.yaml cannot be read";
      } else if (!config.value.floor) {
        writeSync(fd, "canon/config.yaml has no `floor` command\n");
        code = 2;
        why = "it has no floor";
      } else {
        const setup = config.value.setup ? await runLogged(config.value.setup, dir, fd) : 0;
        if (setup !== 0) {
          code = setup;
          why = `setup exited ${setup}`;
        } else {
          code = await runLogged(config.value.floor, dir, fd);
          why = `floor exited ${code}`;
        }
      }
    } finally {
      closeSync(fd);
    }
    const passed = code === 0;
    // reason: the result event is what marks a commit tested (tested()), so it is written in one transaction with the
    // failing-main record it implies; a watcher killed before that commit leaves neither, and the commit is tested again (#86).
    const record = (write: () => void): Result<void> => {
      try {
        ws.db.db.transaction(() => {
          ws.db.event(ws.actor, passed ? "floor.pass" : "floor.fail", null, { sha, log, exit: code, ...(passed ? {} : { why }) });
          write();
        }).immediate();
        return ok(undefined);
      } catch (e) {
        return err("io", `cannot record the background floor's result for ${sha.slice(0, 9)} (${(e as Error).message}); it is tested again next time`);
      }
    };
    if (!passed) {
      const green = git(ws.primary, "rev-parse", "--verify", "--quiet", GREEN_REF);
      const tail = readFileSync(log, "utf8").split("\n").slice(-40).join("\n");
      const recorded = record(() => recordFailure(ws.db, { sha, log, tail, green: green.ok && green.value !== "" ? green.value : null, fixLanded: fixLandedIn(ws, sha) }));
      if (!recorded.ok) return recorded;
      say(`floor watch: ${ws.config.main} ${sha.slice(0, 9)} failed (${why}); recorded for a fix change (canon work start --fix-main)`);
      return ok({ sha, passed, log });
    }
    say(`floor watch: ${ws.config.main} ${sha.slice(0, 9)} passed`);
    // reason: the ref moves before the pass is recorded, so a watcher killed in between only makes the commit be tested again (#86).
    markGreen(ws, sha, say);
    const recorded = record(() => clearRedMain(ws.db));
    if (!recorded.ok) return recorded;
    if (config.ok && config.value.floorTiming === "after" && config.value.hooks.after_green.length > 0) {
      const env = { CANON_GREEN: sha, CANON_PRIMARY: ws.primary };
      const failed = await runHooks({ db: ws.db, actor: ws.actor, event: "after_green", change: null, cwd: dir, env, port: noPort }, config.value.hooks.after_green, say, false);
      // reason: every command exiting 0 counts as PATH's canon rebuilt from this commit (BR-2251).
      return ok({ sha, passed, log, rebuilt: failed === undefined });
    }
    return ok({ sha, passed, log });
  } finally {
    removeWorktree(ws.primary, "--force", dir);
  }
}

/** Moves refs/canon/green to `sha` by a compare-and-swap from the value it had (BR-2222). */
function markGreen(ws: Workspace, sha: string, say: Say): void {
  const old = git(ws.primary, "rev-parse", "--verify", "--quiet", GREEN_REF);
  // reason: an empty old value makes git require that the ref does not exist yet, so the swap is a compare-and-swap either way.
  const cas = git(ws.primary, "update-ref", "-m", "canon: floor passed", GREEN_REF, sha, old.ok ? old.value : "");
  if (!cas.ok) say(`floor watch: ${GREEN_REF} moved meanwhile and was left as it is (${cas.error.message})`);
}

/** The command that runs this canon: the compiled binary itself, or bun with the CLI's source file. */
function canonCommand(): string[] {
  const source = join(import.meta.dir, "..", "..", "cli", "main.ts");
  // reason: a compiled canon embeds its sources under /$bunfs and is started as itself (BR-2219).
  return import.meta.dir.startsWith("/$bunfs") || !existsSync(source) ? [process.execPath] : [process.execPath, source];
}

/**
 * Starts `canon floor watch` in the background when main is watched (floor_timing after), its latest commit is not
 * tested and no watcher is alive (BR-2219). Never waits for it; returns the log of the started watcher, if any.
 */
export function ensureWatcher(ws: Workspace, say: Say): string | undefined {
  if (timingOnMain(ws) !== "after") return undefined;
  const tip = git(ws.primary, "rev-parse", "--verify", `refs/heads/${ws.config.main}`);
  if (!tip.ok || liveWatcher(ws.db) || tested(ws.db, tip.value)) return undefined;
  const started = spawnWatcher(ws, [...canonCommand(), "floor", "watch"]);
  // reason: a watcher that cannot be started fails the command that starts it.
  if (!started.ok) throw new Error(started.error.message);
  say(`floor watch: testing ${ws.config.main} ${tip.value.slice(0, 9)} in the background (log: ${started.value})`);
  return started.value;
}

/**
 * Starts `command` (a `canon floor watch`) detached in the primary checkout with its output in watch.log; returns the
 * log (BR-2251).
 */
function spawnWatcher(ws: Workspace, command: string[]): Result<string> {
  const log = logFile(ws.db, "watch.log");
  try {
    mkdirSync(dirname(log), { recursive: true });
    const fd = openSync(log, "a");
    try {
      // reason: its own process group, so a signal to the command that started it (a tool timeout, Ctrl-C) does not stop it (BR-2219).
      const p = Bun.spawn(command, { cwd: ws.primary, stdout: fd, stderr: fd, stdin: "ignore", detached: true, env: { ...(process.env as Record<string, string>) } });
      p.unref();
    } finally {
      closeSync(fd);
    }
    return ok(log);
  } catch (e) {
    return err("io", `cannot start \`${command.join(" ")}\` in the background: ${(e as Error).message}`);
  }
}
