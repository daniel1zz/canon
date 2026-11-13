/**
 * Process liveness probes (D-11). A process is named by its pid and its start time, so a pid the OS reused for
 * another process never passes for the original. The probes read the process table through `ps`, which macOS and
 * Linux both ship.
 */
import { basename } from "node:path";
import { agentSession } from "../../kernel/agent.ts";

export interface Proc {
  readonly pid: number;
  /** `ps -o lstart` of the process, in the C locale and UTC. */
  readonly start: string;
}

function ps(args: readonly string[], zone: "utc" | "local" = "utc"): { code: number; out: string } | undefined {
  try {
    // reason: lstart is printed in the caller's time zone; fixing locale and zone makes two sessions read one string (BR-2100).
    const env = zone === "utc" ? { ...process.env, LC_ALL: "C", TZ: "UTC" } : { ...process.env, LC_ALL: "C" };
    const r = Bun.spawnSync(["ps", ...args], { stdout: "pipe", stderr: "pipe", env });
    return { code: r.exitCode ?? -1, out: r.stdout.toString() };
  } catch {
    return undefined;
  }
}

/** The start time of a live process; null when no process has this pid; undefined when the table cannot be read. */
export function processStart(pid: number, zone: "utc" | "local" = "utc"): string | null | undefined {
  const r = ps(["-o", "lstart=", "-p", String(pid)], zone);
  if (!r) return undefined;
  const start = r.out.trim().replace(/\s+/g, " ");
  if (start !== "") return start;
  // reason: ps exits 1 with no output when the pid is not in the table; anything else is an unreadable table.
  return r.code === 1 ? null : undefined;
}

export function processOf(pid: number): Proc | undefined {
  const start = processStart(pid);
  return start ? { pid, start } : undefined;
}

/**
 * True only when the process is provably gone: no process has its pid, or the pid now belongs to a process that
 * started at another time. False while it runs; undefined when the table cannot be read, so the caller falls back
 * to the time-based lease instead of guessing.
 */
export function isGone(p: Proc, read: (pid: number, zone: "utc" | "local") => string | null | undefined = processStart): boolean | undefined {
  const start = read(p.pid, "utc");
  if (start === undefined) return undefined;
  if (start === null) return true;
  if (start === p.start) return false;
  // reason: records written before C-74 hold the start in the writer's local zone; read it that way too before calling it gone (BR-2100).
  const local = read(p.pid, "local");
  if (local === undefined) return undefined; // an unreadable table proves nothing (D-11)
  return local !== p.start;
}

/** This canon process. */
export function selfProcess(): Proc | undefined {
  return processOf(process.pid);
}

/**
 * The host process this command runs under: Codex uses its nearest codex ancestor; Claude uses CLAUDE_PID, believed only when it is an
 * ancestor of this process (an inherited, stale value from another session is ignored). Every agent of one Claude
 * Code session, subagents included, runs under the same process, so this names the session, not the agent (D-11).
 */
export function sessionProcess(env: Record<string, string | undefined> = process.env): Proc | undefined {
  if (agentSession(env)?.runtime === "codex") {
    const r = ps(["-axo", "pid=,ppid=,comm="]);
    if (!r || r.code !== 0) return undefined;
    const table = new Map<number, { parent: number; command: string }>();
    for (const line of r.out.split("\n")) {
      const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (row) table.set(Number(row[1]), { parent: Number(row[2]), command: row[3]!.trim() });
    }
    for (let pid = table.get(process.pid)?.parent, i = 0; pid !== undefined && pid > 1 && i < 128; pid = table.get(pid)?.parent, i++) {
      const row = table.get(pid);
      if (row && basename(row.command) === "codex") return processOf(pid);
    }
    return undefined;
  }
  if (env["CLAUDECODE"] !== "1") return undefined;
  const claimed = Number(env["CLAUDE_PID"]);
  if (!Number.isInteger(claimed) || claimed <= 1) return undefined;
  const r = ps(["-axo", "pid=,ppid="]);
  if (!r || r.code !== 0) return undefined;
  const parent = new Map<number, number>();
  for (const line of r.out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && Number.isInteger(pid) && Number.isInteger(ppid)) parent.set(pid, ppid);
  }
  for (let p: number | undefined = process.pid, i = 0; p !== undefined && p > 1 && i < 128; p = parent.get(p), i++) {
    if (p === claimed) return processOf(claimed);
  }
  return undefined;
}
