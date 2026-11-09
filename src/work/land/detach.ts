import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Workspace } from "../workspace.ts";
import { logFile } from "../hooks/hooks.ts";
import { canonCommand } from "../watch/watch.ts";
import { isGone, processOf, type Proc } from "../claims/liveness.ts";
import { attemptIn } from "./queue/interrupted.ts";
import { EXIT } from "../../invocation/command.ts";

/**
 * A landing runs in its own background process; `canon work land` only follows it (D-80, BR-2390..BR-2393). The
 * background landing is `canon work land` itself started with RUN_ENV naming its follower and its run directory, which holds its
 * standard output (`out`), standard error (`err`), its exit code once it ends (`exit`), and `seen` once a follower has
 * printed it to the end.
 */

export const RUN_ENV = "CANON_LAND_RUN";

const POLL_MS = 100;
const GONE_MS = 5_000;

/**
 * This process's run directory when it is the background landing (D-80): RUN_ENV holds `<follower pid>:<dir>`, and only
 * the process whose parent is that follower is the landing.
 */
export function backgroundRun(env: Record<string, string | undefined> = process.env, parent: number = process.ppid): string | undefined {
  const value = env[RUN_ENV];
  // reason: Bun starts a child without an explicit env from the environment this process started with, so removing the
  // variable here does not hide it from the floor or hooks; a `canon work land` they run has another parent and is not the landing (BR-2390)
  delete env[RUN_ENV];
  const m = /^(\d+):(.+)$/.exec(value ?? "");
  return m && Number(m[1]) === parent ? m[2] : undefined;
}

/** Writes this process's exit code into its run directory as it exits, whichever path it exits by (BR-2390). */
export function recordExit(dir: string): void {
  process.on("exit", (code) => {
    // reason: an exit handler that throws would hide the landing's own exit code; a follower that finds no `exit` says so (BR-2390)
    try {
      writeFileSync(join(dir, "exit"), String(code));
    } catch {
      /* the follower reports a landing that ended without a recorded result */
    }
  });
}

/** The arguments the background landing gets: the same options as the command that starts it. */
export function landArgs(a: { finish?: boolean; timeout?: string; as?: string }): string[] {
  return [...(a.finish ? ["--finish"] : []), ...(a.timeout !== undefined ? ["--timeout", a.timeout] : []), ...(a.as !== undefined ? ["--as", a.as] : [])];
}

/** Starts the background landing: its own process group, no standard input, its output in a new run directory (D-80). */
export function startBackground(ws: Workspace, args: readonly string[], dir: string = newRunDir(ws)): { dir: string; proc: Subprocess } {
  mkdirSync(dir, { recursive: true });
  const out = openSync(join(dir, "out"), "a");
  const err = openSync(join(dir, "err"), "a");
  try {
    // reason: its own process group, so the caller's tool timeout, hang-up or Ctrl-C does not reach the landing (D-80)
    const proc = Bun.spawn([...canonCommand(), "work", "land", ...args], { cwd: process.cwd(), stdout: out, stderr: err, stdin: "ignore", detached: true, env: { ...(process.env as Record<string, string>), [RUN_ENV]: `${process.pid}:${dir}` } });
    // reason: until the landing records land.start, this file is how another `canon work land` tells it is alive (BR-2392, #172)
    const me = processOf(proc.pid);
    if (me) writeFileSync(join(dir, "pid"), `${me.pid}\n${me.start}\n`);
    return { dir, proc };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

/** A new run directory under the coordination database's logs (BR-2390). */
export function newRunDir(ws: Workspace): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return logFile(ws.db, `land-run-${stamp}-${process.pid}`);
}

/** The latest landing from this worktree that ran in the background, with its run directory (BR-2392). */
export function lastRun(ws: Workspace): { id: number; ts: string; dir: string } | undefined {
  const r = ws.db.db.query<{ id: number; ts: string; detail: string }, [string]>("SELECT id, ts, detail FROM events WHERE kind = 'land.start' AND worktree = ? ORDER BY id DESC LIMIT 1").get(ws.root);
  if (!r) return undefined;
  const run = (JSON.parse(r.detail) as { run?: unknown }).run;
  return typeof run === "string" && existsSync(run) ? { id: r.id, ts: r.ts, dir: run } : undefined;
}

/** The process a run directory's `pid` file names, once the follower that started it has written it. */
function runProcess(dir: string): Proc | undefined {
  const p = join(dir, "pid");
  if (!existsSync(p)) return undefined;
  const [pid, start] = readFileSync(p, "utf8").split("\n");
  return pid && start ? { pid: Number(pid), start } : undefined;
}

/**
 * A landing another `canon work land` started from this worktree that has not recorded `land.start` yet (BR-2392, #172):
 * the latest `land.spawn` of this worktree with no `land.start` of the same run after it, whose run has no exit code and
 * whose landing process is alive, or, before that process is written down, whose starting `canon work land` is alive.
 */
function startingRun(ws: Workspace): { ts: string; dir: string; ended: boolean } | undefined {
  const r = ws.db.db.query<{ id: number; ts: string; detail: string }, [string]>("SELECT id, ts, detail FROM events WHERE kind = 'land.spawn' AND worktree = ? ORDER BY id DESC LIMIT 1").get(ws.root);
  if (!r) return undefined;
  const run = (JSON.parse(r.detail) as { run?: unknown }).run;
  if (typeof run !== "string") return undefined;
  const started = ws.db.db.query<{ one: number }, [number, string, string]>("SELECT 1 AS one FROM events WHERE id > ? AND kind = 'land.start' AND worktree = ? AND json_extract(detail, '$.run') = ? LIMIT 1").get(r.id, ws.root, run);
  if (started) return undefined;
  // reason: a landing that ended before land.start (e.g. refused as claimed) is reported like any unseen result (BR-2392)
  if (exitOf(run) !== undefined) return existsSync(join(run, "seen")) ? undefined : { ts: r.ts, dir: run, ended: true };
  const proc = runProcess(run);
  if (proc) return isGone(proc) === false ? { ts: r.ts, dir: run, ended: false } : undefined;
  // reason: a starter killed before it started the landing leaves no landing; it is not waited for (BR-2392)
  const d = JSON.parse(r.detail) as { pid?: unknown; pid_start?: unknown };
  const starter = typeof d.pid === "number" && typeof d.pid_start === "string" ? { pid: d.pid, start: d.pid_start } : undefined;
  return starter && isGone(starter) === false ? { ts: r.ts, dir: run, ended: false } : undefined;
}

/** Copies what a stream file gained since `at` to the file descriptor `fd`; returns the new offset. */
function drain(path: string, fd: number, at: number): number {
  if (!existsSync(path)) return at;
  const f = openSync(path, "r");
  try {
    const size = fstatSync(f).size;
    if (size <= at) return at;
    const buf = Buffer.alloc(size - at);
    const n = readSync(f, buf, 0, buf.length, at);
    writeSync(fd, buf.subarray(0, n));
    return at + n;
  } finally {
    closeSync(f);
  }
}

function exitOf(dir: string): number | undefined {
  const p = join(dir, "exit");
  if (!existsSync(p)) return undefined;
  const text = readFileSync(p, "utf8").trim();
  const n = Number(text);
  return text !== "" && Number.isInteger(n) ? n : undefined;
}

/** The background landing's process: the subprocess this follower started, or the process `land.start` recorded. */
export type Lander = { readonly proc: Subprocess } | { readonly recorded: Proc } | { readonly over: true };

const ended = (l: Lander): boolean => ("proc" in l ? l.proc.exitCode !== null || l.proc.signalCode !== null : "recorded" in l ? isGone(l.recorded) === true : true);

/** Waits until the landing process has ended; a recorded process is given at most GONE_MS, as its exit code is already known. */
async function gone(l: Lander): Promise<void> {
  if ("proc" in l) await l.proc.exited;
  else if ("recorded" in l) for (const until = Date.now() + GONE_MS; isGone(l.recorded) === false && Date.now() < until; ) await Bun.sleep(POLL_MS / 4);
}

/**
 * Follows a background landing (BR-2390): prints its standard output and standard error as they grow, from the start,
 * and returns its exit code once it ends, marking it seen. A landing whose process ended without writing its exit
 * code (killed where no handler runs) returns 75 with what to do next. A SIGINT, SIGTERM or SIGHUP to the follower only
 * detaches it (BR-2391).
 */
export async function follow(ws: Workspace, dir: string, lander: Lander, pid: number | null): Promise<number> {
  let out = 0;
  let err = 0;
  const detach = (signal: NodeJS.Signals) => {
    out = drain(join(dir, "out"), 1, out);
    err = drain(join(dir, "err"), 2, err);
    writeSync(2, `canon: detached (${signal}); the landing goes on in the background${pid !== null ? ` (process ${pid})` : ""}. Follow it again: canon work land (in ${ws.root}); stop it: canon work land --stop\n`);
    process.exit(EXIT.timeout);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, detach);
  try {
    for (;;) {
      out = drain(join(dir, "out"), 1, out);
      err = drain(join(dir, "err"), 2, err);
      const code = exitOf(dir);
      if (code !== undefined || ended(lander)) {
        // reason: the exit file is written as the process exits, so it is read once more after the process is seen gone (BR-2390)
        const last = code ?? exitOf(dir);
        out = drain(join(dir, "out"), 1, out);
        err = drain(join(dir, "err"), 2, err);
        writeFileSync(join(dir, "seen"), "");
        // reason: the exit file is written just before the process ends; returning only once it is gone leaves no landing process behind the command (BR-2390)
        await gone(lander);
        if (last !== undefined) return last;
        writeSync(2, `canon: the landing process${pid !== null ? ` ${pid}` : ""} ended without recording a result (killed where no handler runs); run canon work land again: it says what was left and cleans it up\n`);
        return EXIT.timeout;
      }
      await Bun.sleep(POLL_MS);
    }
  } finally {
    for (const s of signals) process.off(s, detach);
  }
}

/**
 * `canon work land` without RUN_ENV (BR-2390, BR-2392): follows this worktree's landing still running in the
 * background, or reports one that ended while no follower printed its end; otherwise starts a new background landing
 * and follows it. Returns the exit code.
 */
export async function landInBackground(ws: Workspace, args: readonly string[]): Promise<number> {
  type Decision =
    | { readonly starting: { ts: string; dir: string } }
    | { readonly running: { ts: string; dir: string }; readonly proc: Proc }
    | { readonly unseen: { ts: string; dir: string } }
    | { readonly spawn: string };
  // reason: deciding that no landing runs and recording the one about to start happen in one write transaction, so two
  // `canon work land` started together cannot both start a landing for this worktree (BR-2392, #172)
  const decided = ws.db.db.transaction((): Decision => {
    const starting = startingRun(ws);
    if (starting) return starting.ended ? { unseen: starting } : { starting };
    const last = lastRun(ws);
    if (last) {
      const a = attemptIn(ws.db, ws.config.main, ws.root);
      if (a && a.id === last.id && a.state === "running" && a.pid !== null && a.pidStart !== null) return { running: last, proc: { pid: a.pid, start: a.pidStart } };
      if (exitOf(last.dir) !== undefined && !existsSync(join(last.dir, "seen"))) return { unseen: last };
    }
    const dir = newRunDir(ws);
    mkdirSync(dir, { recursive: true });
    const me = processOf(process.pid);
    ws.db.event(ws.actor, "land.spawn", null, { run: dir, pid: me?.pid ?? null, pid_start: me?.start ?? null });
    return { spawn: dir };
  }).immediate();
  if ("starting" in decided) {
    writeSync(2, `canon: the landing started ${decided.starting.ts} from this worktree is still starting; following it instead of starting another\n`);
    let proc = runProcess(decided.starting.dir);
    for (let i = 0; !proc && i < 50; i++) {
      await Bun.sleep(POLL_MS);
      proc = runProcess(decided.starting.dir);
    }
    return follow(ws, decided.starting.dir, proc ? { recorded: proc } : { over: true }, proc?.pid ?? null);
  }
  if ("running" in decided) {
    writeSync(2, `canon: the landing started ${decided.running.ts} from this worktree is still running (process ${decided.proc.pid}); following it instead of starting another\n`);
    return follow(ws, decided.running.dir, { recorded: decided.proc }, decided.proc.pid);
  }
  if ("unseen" in decided) {
    writeSync(2, `canon: the landing started ${decided.unseen.ts} from this worktree ended while nothing followed it; its output follows. Run canon work land again to land anew\n`);
    return follow(ws, decided.unseen.dir, { over: true }, null);
  }
  const { dir, proc } = startBackground(ws, args, decided.spawn);
  return follow(ws, dir, { proc }, proc.pid);
}

/**
 * `canon work land --stop` (BR-2393): SIGTERM to this worktree's running landing, which gives its turn up (BR-2099);
 * waits for it to end and prints its output. 0 once stopped; not found when no landing is running here.
 */
export async function stopLanding(ws: Workspace): Promise<{ ok: true; code: number } | { ok: false; code: "not_found" | "io"; message: string }> {
  const a = attemptIn(ws.db, ws.config.main, ws.root);
  if (!a || a.state !== "running" || a.pid === null || a.pidStart === null) return { ok: false, code: "not_found", message: `no landing is running from this worktree (${ws.root})` };
  try {
    process.kill(a.pid, "SIGTERM");
  } catch (e) {
    return { ok: false, code: "io", message: `cannot signal the landing process ${a.pid}: ${(e as Error).message}` };
  }
  const run = lastRun(ws);
  const recorded = { pid: a.pid, start: a.pidStart };
  if (run && run.id === a.id) await follow(ws, run.dir, { recorded }, a.pid);
  else while (isGone(recorded) !== true) await Bun.sleep(POLL_MS);
  writeSync(1, `stopped the landing started ${a.ts} (process ${a.pid})\n`);
  return { ok: true, code: EXIT.ok };
}
