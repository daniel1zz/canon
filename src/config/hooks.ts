import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoordDb } from "../work/db.ts";
import type { HookEvent } from "./config.ts";

/**
 * Lifecycle hooks (D-2 §3, D-3): commands from `hooks.<event>` in `canon/config.yaml`, run with the event's
 * facts in CANON_* environment variables. Hooks can only inspect outcomes or add information: only
 * `before_land` can refuse, and only on the tree that is about to become main (BR-2057). Every run is
 * recorded as a `hook.run` event (BR-2059) so a hook's value can be measured like any check.
 */
export interface HookContext {
  readonly db: CoordDb;
  readonly actor: string;
  readonly event: HookEvent;
  /** Change id the event is about, when there is one. */
  readonly change: string | null;
  /** Directory the commands run in. */
  readonly cwd: string;
  /** Extra CANON_* variables for this event (CANON_BASE, CANON_HEAD, CANON_NEXT, ...). */
  readonly env: Readonly<Record<string, string>>;
}

export interface HookFailure {
  readonly command: string;
  readonly exit: number;
  readonly output: string;
}

function envFor(ctx: HookContext): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    CANON_EVENT: ctx.event,
    CANON_CHANGE: ctx.change ?? "",
    CANON_ACTOR: ctx.actor,
    CANON_WORKTREE: ctx.cwd,
    ...ctx.env,
  };
}

const tail = (text: string, lines = 40) => text.trimEnd().split("\n").slice(-lines).join("\n");

/**
 * Runs the commands in order and waits for each. Returns the first failure, or undefined when all exit 0.
 * `stopOnFailure` is for `before_land`; the `after_*` events run every command whatever the exit codes.
 */
export async function runHooks(ctx: HookContext, commands: readonly string[], say: (line: string) => void, stopOnFailure: boolean): Promise<HookFailure | undefined> {
  let first: HookFailure | undefined;
  for (const command of commands) {
    say(`hook ${ctx.event}: ${command}`);
    const proc = Bun.spawn(["sh", "-c", command], { cwd: ctx.cwd, env: envFor(ctx), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, errText, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const output = `${out}${errText}`;
    if (output.trim() !== "") for (const line of tail(output).split("\n")) say(`  ${line}`);
    ctx.db.event(ctx.actor, "hook.run", ctx.change, { event: ctx.event, command, exit });
    if (exit !== 0) {
      first ??= { command, exit, output: tail(output) };
      if (stopOnFailure) return first;
      say(`hook ${ctx.event} exited ${exit}; the result is unchanged`);
    }
  }
  return first;
}

/** The synchronous form of `runHooks` for the `after_start` and `after_stop` events, which never refuse. */
export function runHooksSync(ctx: HookContext, commands: readonly string[], say: (line: string) => void): HookFailure | undefined {
  let first: HookFailure | undefined;
  for (const command of commands) {
    say(`hook ${ctx.event}: ${command}`);
    const r = Bun.spawnSync(["sh", "-c", command], { cwd: ctx.cwd, env: envFor(ctx), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const output = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (output.trim() !== "") for (const line of tail(output).split("\n")) say(`  ${line}`);
    const exit = r.exitCode ?? -1;
    ctx.db.event(ctx.actor, "hook.run", ctx.change, { event: ctx.event, command, exit });
    if (exit !== 0) {
      first ??= { command, exit, output: tail(output) };
      say(`hook ${ctx.event} exited ${exit}; the result is unchanged`);
    }
  }
  return first;
}

/** Starts the commands one after another in the background and returns the log path; exit codes are not awaited. */
export function runHooksInBackground(ctx: HookContext, commands: readonly string[], logPath: string): string {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  // Each command runs in its own subshell; its exit code is written to the log after its output.
  const script = commands.map((c, i) => `(\n${c}\n); echo "[hook ${i + 1}/${commands.length} exited $?]"`).join("\n");
  const p = Bun.spawn(["sh", "-c", script], { cwd: ctx.cwd, env: envFor(ctx), stdout: fd, stderr: fd, stdin: "ignore" });
  p.unref();
  closeSync(fd);
  for (const command of commands) ctx.db.event(ctx.actor, "hook.run", ctx.change, { event: ctx.event, command, exit: null, background: true });
  return logPath;
}

export const logFile = (db: CoordDb, name: string) => join(dirname(db.db.filename), "logs", name);
