import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
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
  commands.forEach((command, i) => ctx.db.event(ctx.actor, "hook.run", ctx.change, { event: ctx.event, command, exit: null, background: true, log: logPath, index: i + 1 }));
  return logPath;
}

interface BackgroundRun {
  readonly subject: string | null;
  readonly event: string;
  readonly command: string;
  readonly log: string;
  readonly index: number;
}

export interface BackgroundBatch {
  readonly change: string | null;
  readonly log: string;
  /** False when the log file is gone, so the exit codes cannot be known. */
  readonly logFound: boolean;
  readonly failed: readonly { readonly command: string; readonly exit: number }[];
}

const EXIT_LINE = /^\[hook (\d+)\/\d+ exited (\d+)\]$/gm;

/**
 * Reads the exit codes of the latest background batch from its log and records each finished command once as a
 * `hook.exit` event (BR-2137). Returns the batch, or undefined when no background run recorded a log path.
 */
export function settleBackgroundHooks(db: CoordDb, actor: string): BackgroundBatch | undefined {
  const latest = db.db
    .query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'hook.run' AND json_extract(detail, '$.log') IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get();
  if (!latest) return undefined;
  const log = (JSON.parse(latest.detail) as { log: string }).log;
  const runs = db.db
    .query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = 'hook.run' AND json_extract(detail, '$.log') = ? ORDER BY id")
    .all(log)
    .map((e): BackgroundRun => ({ subject: e.subject, ...(JSON.parse(e.detail) as Omit<BackgroundRun, "subject">) }));
  const change = runs[0]?.subject ?? null;
  if (!existsSync(log)) return { change, log, logFound: false, failed: [] };
  const exits = new Map<number, number>();
  for (const m of readFileSync(log, "utf8").matchAll(EXIT_LINE)) exits.set(Number(m[1]), Number(m[2]));
  // reason: several sessions may run canon brief at once; check-then-insert inside one write transaction records each command once (BR-2137)
  db.db
    .transaction(() => {
      const recorded = new Set(
        db.db
          .query<{ index: number }, [string]>("SELECT json_extract(detail, '$.index') AS \"index\" FROM events WHERE kind = 'hook.exit' AND json_extract(detail, '$.log') = ?")
          .all(log)
          .map((r) => r.index),
      );
      for (const r of runs) {
        const exit = exits.get(r.index);
        if (exit === undefined || recorded.has(r.index)) continue;
        db.event(actor, "hook.exit", r.subject, { event: r.event, command: r.command, exit, background: true, log, index: r.index });
      }
    })
    .immediate();
  const failed = runs.flatMap((r) => {
    const exit = exits.get(r.index);
    return exit !== undefined && exit !== 0 ? [{ command: r.command, exit }] : [];
  });
  return { change, log, logFound: true, failed };
}

/** The `canon brief` line about the latest background batch (BR-2138), or undefined when there is nothing to say. */
export function backgroundNotice(batch: BackgroundBatch | undefined): string | undefined {
  if (!batch) return undefined;
  const after = batch.change ? ` after ${batch.change}` : "";
  if (!batch.logFound) return `after_land${after}: the log ${batch.log} is missing, so whether the background commands succeeded is unknown`;
  if (batch.failed.length === 0) return undefined;
  const what = batch.failed.map((f) => `\`${f.command}\` exited ${f.exit}`).join(", ");
  return `after_land${after} failed in the background: ${what} (log: ${batch.log})`;
}

export const logFile = (db: CoordDb, name: string) => join(dirname(db.db.filename), "logs", name);
