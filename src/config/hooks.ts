import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoordDb } from "../work/db.ts";
import type { HookEvent } from "./config-keys.ts";

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
 * The shell line for one foreground command: its stderr goes into the same pipe as its stdout, so the lines keep the
 * order they were written in (BR-2200). sh reads the command after the redirection, so a syntax error in it lands in
 * that pipe too; the process's own stderr is still read and appended, for anything sh says before that.
 */
const merged = (command: string): string[] => ["sh", "-c", `exec 2>&1\n${command}`];

/**
 * Runs the commands in order and waits for each. Returns the first failure, or undefined when all exit 0.
 * `stopOnFailure` is for `before_land`; the `after_*` events run every command whatever the exit codes.
 */
export async function runHooks(ctx: HookContext, commands: readonly string[], say: (line: string) => void, stopOnFailure: boolean): Promise<HookFailure | undefined> {
  let first: HookFailure | undefined;
  for (const command of commands) {
    say(`hook ${ctx.event}: ${command}`);
    const proc = Bun.spawn(merged(command), { cwd: ctx.cwd, env: envFor(ctx), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
    const r = Bun.spawnSync(merged(command), { cwd: ctx.cwd, env: envFor(ctx), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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

/**
 * Starts the commands one after another in the background and returns the log path; exit codes are not awaited.
 * `batch` is the landing's queue entry: turns go in entry order, so it orders batches by landing (BR-2138).
 */
export function runHooksInBackground(ctx: HookContext, commands: readonly string[], logPath: string, batch: number): string {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  // Each command runs in its own subshell; its exit code is written to the log after its output.
  // reason: the exit line must start a line to be read (EXIT_LINE); output that does not end in a newline gets one
  // first, and only then, so a log of newline-ended output stays as it was (BR-2137, issue #61)
  const quoted = `'${logPath.replaceAll("'", `'\\''`)}'`;
  const script = commands
    .map((c, i) => `(\n${c}\n); __canon_exit=$?; [ -n "$(tail -c 1 ${quoted})" ] && echo; echo "[hook ${i + 1}/${commands.length} exited $__canon_exit]"`)
    .join("\n");
  // reason: the whole batch is recorded in one transaction before any command can finish, so a reader never sees
  // part of a batch whose recorded commands have all exited and takes it for finished (BR-2166, issue #38)
  ctx.db.db
    .transaction(() => commands.forEach((command, i) => ctx.db.event(ctx.actor, "hook.run", ctx.change, { event: ctx.event, command, exit: null, background: true, log: logPath, index: i + 1, batch })))
    .immediate();
  const p = Bun.spawn(["sh", "-c", script], { cwd: ctx.cwd, env: envFor(ctx), stdout: fd, stderr: fd, stdin: "ignore" });
  p.unref();
  closeSync(fd);
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
  /** Every command of the batch in order, with its exit code, or null while it has not finished (BR-2166). */
  readonly commands: readonly { readonly index: number; readonly command: string; readonly exit: number | null }[];
  /** The log's lines that start with `code-review:`, as written (BR-2166). */
  readonly review: readonly string[];
}

const EXIT_LINE = /^\[hook (\d+)\/\d+ exited (\d+)\]$/gm;
const REVIEW_LINE = /^code-review:.*$/gm;

/**
 * Reads the exit codes of the latest background batch from its log and records each finished command once as a
 * `hook.exit` event (BR-2137). Returns the batch, or undefined when no background run recorded a log path.
 * With `change`, the batch is that change's latest landing instead of the latest of all (BR-2166); with `log`, it is
 * the batch of that log, which is how a wait keeps reading the batch it started with (BR-2167, issue #39).
 */
export function settleBackgroundHooks(db: CoordDb, actor: string, change?: string, log?: string): BackgroundBatch | undefined {
  // reason: a landing releases its queue turn before it records its batch, so a later landing's rows can be written
  // first; the queue entry, not the event id, says which landing came last (BR-2138, issue #28)
  const latest = db.db
    .query<{ detail: string }, [string | null, string | null]>(
      "SELECT detail FROM events WHERE kind = 'hook.run' AND json_extract(detail, '$.log') IS NOT NULL AND (?1 IS NULL OR subject = ?1) AND (?2 IS NULL OR json_extract(detail, '$.log') = ?2) ORDER BY json_extract(detail, '$.batch') DESC, id DESC LIMIT 1",
    )
    .get(change ?? null, log ?? null);
  if (!latest) return undefined;
  log = (JSON.parse(latest.detail) as { log: string }).log;
  const runs = db.db
    .query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = 'hook.run' AND json_extract(detail, '$.log') = ? ORDER BY id")
    .all(log)
    .map((e): BackgroundRun => ({ subject: e.subject, ...(JSON.parse(e.detail) as Omit<BackgroundRun, "subject">) }));
  const subject = runs[0]?.subject ?? null;
  if (!existsSync(log)) return { change: subject, log, logFound: false, failed: [], commands: runs.map((r) => ({ index: r.index, command: r.command, exit: null })), review: [] };
  const text = readFileSync(log, "utf8");
  const exits = new Map<number, number>();
  for (const m of text.matchAll(EXIT_LINE)) exits.set(Number(m[1]), Number(m[2]));
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
  const commands = runs.map((r) => ({ index: r.index, command: r.command, exit: exits.get(r.index) ?? null }));
  return { change: subject, log, logFound: true, failed, commands, review: [...text.matchAll(REVIEW_LINE)].map((m) => m[0]) };
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

/**
 * Where a background batch stands (BR-2166): `failed` as soon as one finished command exited non-zero, `ok` when
 * every command exited 0, `running` while some have not finished, `unknown` when the log is gone.
 */
export type BatchState = "ok" | "failed" | "running" | "unknown";

export function batchState(b: BackgroundBatch): BatchState {
  if (!b.logFound) return "unknown";
  if (b.failed.length > 0) return "failed";
  return b.commands.every((c) => c.exit !== null) ? "ok" : "running";
}

/** How long `canon work after-land --wait` waits by default (BR-2167). */
export const AFTER_LAND_WAIT_MS = 20 * 60_000;

/**
 * Settles the batch until every command has finished, the log is gone or `timeoutMs` passes (BR-2167).
 * Returns the batch as last read, or undefined when there is none.
 */
export async function waitBackgroundHooks(db: CoordDb, actor: string, change: string | undefined, timeoutMs: number, pollMs = 1000): Promise<BackgroundBatch | undefined> {
  const deadline = Date.now() + timeoutMs;
  let log: string | undefined;
  for (;;) {
    // reason: after the first read the wait stays on that batch; picking the latest again would switch to a landing
    // that finished meanwhile and hide this one's result (issue #39)
    const b = settleBackgroundHooks(db, actor, change, log);
    if (!b) return undefined;
    log = b.log;
    if (!b.logFound || b.commands.every((c) => c.exit !== null) || Date.now() >= deadline) return b;
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** The `canon work after-land` report: one line per command, then the code-review lines (BR-2166). */
export function renderAfterLand(b: BackgroundBatch): string {
  const head = `after_land${b.change ? ` after ${b.change}` : ""} (log: ${b.log})`;
  if (!b.logFound) return `${head}: the log is missing, so whether the background commands succeeded is unknown`;
  const n = b.commands.length;
  const lines = b.commands.map((c) => `  [${c.index}/${n}] ${c.command}: ${c.exit === null ? "still running" : `exited ${c.exit}`}`);
  const st = batchState(b);
  const verdict = st === "ok" ? "all finished, all exited 0" : st === "running" ? "not finished yet" : b.commands.some((c) => c.exit === null) ? "failed; others still running" : "finished; some failed";
  return [`${head}: ${verdict}`, ...lines, ...b.review].join("\n");
}

export const logFile = (db: CoordDb, name: string) => join(dirname(db.db.filename), "logs", name);
