import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { isGone, processOf } from "../claims/liveness.ts";
import { readings } from "../delegation/capacity.ts";
import type { Machine } from "../session/load.ts";
import { machineDir, withMutex, type SlotDeps } from "./slot.ts";

/**
 * The load gate every heavy step passes before its first project command (BR-2630, D-161): while the 5-minute load is at
 * the limit, or other steps already wait, the step queues on the machine, and the queue lets one step go at a time, at
 * least `intervalMs` after the last one that left it. Like the queue of full test runs (BR-2576, BR-2577) it is one file
 * per step in a directory under the user's state directory, with a mutex directory around the few milliseconds in which
 * it is read and changed; the time the last step left is in `released` beside the files.
 */

export type StepKind = "test" | "land" | "floor" | "heavy-run";

export interface LoadDeps extends Pick<SlotDeps, "dir" | "pollMs" | "now" | "self" | "gone" | "sleep"> {
  /** The machine's load and CPUs; undefined when the platform reports none (BR-2630: then the load condition holds). */
  readonly read: () => Machine | undefined;
  /** The least time between two steps leaving the queue (BR-2630: 60 s). */
  readonly intervalMs: number;
  /** The longest a waiting step stays silent when nothing changed (BR-2630: 5 min). */
  readonly quietMs: number;
}

export const machineLoad: LoadDeps = {
  dir: join(machineDir(), "load-waits"),
  pollMs: 2000,
  now: Date.now,
  self: () => processOf(process.pid),
  gone: (p) => isGone(p),
  sleep: (ms) => Bun.sleep(ms),
  read: () => readings().machine,
  intervalMs: 60_000,
  quietMs: 5 * 60_000,
};

/** What a queue file says about a waiting step. */
export interface LoadEntry {
  readonly seq: number;
  readonly pid: number;
  readonly pidStart: string;
  /** The change or chore the step is for, `main` for the background floor, or the executor when none is claimed. */
  readonly subject: string;
  readonly worktree: string;
  readonly kind: StepKind;
  /** The load limit this step was judged against when it queued; null when the load could not be read. */
  readonly limit: number | null;
  readonly queuedAt: number;
}

export interface LoadRequest {
  readonly kind: StepKind;
  readonly subject: string;
  readonly worktree: string;
  /** `heavy_max_load_per_cpu` of the repository that runs the step (BR-2665). */
  readonly perCpu: number;
  readonly say: (line: string) => void;
  /** Turns true when the step is stopped while it waits. */
  readonly aborted: () => boolean;
  /** Writes the coordination event `load.wait` or `load.start` (BR-2630). */
  readonly record: (kind: "load.wait" | "load.start", detail: Record<string, unknown>) => void;
}

const RELEASED = "released";
const fileOf = (dir: string, e: { seq: number; pid: number }) => join(dir, `${String(e.seq).padStart(12, "0")}-${e.pid}.json`);

function readAll(dir: string): LoadEntry[] {
  const out: LoadEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      out.push(JSON.parse(readFileSync(path, "utf8")) as LoadEntry);
    } catch (e) {
      // reason: a queue file that cannot be read cannot be told from a live step, so the step stops instead of jumping the queue (BR-2577, BR-2630)
      throw new Error(`the load queue file ${path} cannot be read: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function writeEntry(dir: string, e: LoadEntry): void {
  const path = fileOf(dir, e);
  // reason: written then renamed, so a reader never sees half a file
  writeFileSync(`${path}.tmp`, JSON.stringify(e));
  renameSync(`${path}.tmp`, path);
}

/** The time the last step left the queue; undefined when none did. A file that cannot be read fails loudly, as a queue file does. */
function lastRelease(dir: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, RELEASED), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`the load queue file ${join(dir, RELEASED)} cannot be read: ${(e as Error).message}`);
  }
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`the load queue file ${join(dir, RELEASED)} does not hold a time`);
  return n;
}

/** The entries of steps whose process is not gone, in order; the others are deleted. */
function live(d: LoadDeps): LoadEntry[] {
  const out: LoadEntry[] = [];
  for (const e of readAll(d.dir)) {
    if (d.gone({ pid: e.pid, start: e.pidStart }) === true) rmSync(fileOf(d.dir, e), { force: true });
    else out.push(e);
  }
  return out;
}

/** How a step is named in the queue and the agenda: `<subject>（<worktree>）`, so the same number in two repositories is told apart (BR-2630). */
export const loadName = (e: Pick<LoadEntry, "subject" | "worktree">): string => `${e.subject}（${e.worktree}）`;

/** The line a step says when it queues and when something changes (BR-2630). */
export function loadLine(machine: Machine | undefined, perCpu: number, ahead: number): string {
  const now = machine ? `5-minute load ${machine.load5.toFixed(1)} on ${machine.cpus} CPUs (limit ${perCpu * machine.cpus})` : "5-minute load unknown";
  return `canon: waiting for the machine load: ${now}; ${ahead} step(s) ahead on this machine; the wait does not count toward test_timeout_minutes`;
}

export type Passed = "go" | "aborted";

/**
 * Passes the gate (BR-2630): goes at once when nobody waits, the load is under the limit and the last step left the queue
 * at least `intervalMs` ago; otherwise queues and goes when it is first, the load is under its limit and `intervalMs` have
 * passed. An unreadable load counts as under the limit. "aborted" when `aborted()` turned true while waiting, after leaving
 * the queue. The step's queue file is also removed when the process exits meanwhile.
 */
export async function passLoadGate(d: LoadDeps, req: LoadRequest): Promise<Result<Passed>> {
  let entry: LoadEntry | undefined;
  const leave = () => {
    if (entry) rmSync(fileOf(d.dir, entry), { force: true });
  };
  try {
    mkdirSync(d.dir, { recursive: true });
    const me = d.self();
    if (!me) return err("io", "the process table cannot be read, so this step cannot take its place in the load queue");
    let said = "";
    let saidAt = 0;
    let armed = false;
    for (;;) {
      const step = await withMutex(d, () => {
        const queue = live(d);
        const machine = d.read();
        const limit = machine ? req.perCpu * machine.cpus : null;
        // reason: compared unrounded, as BR-2526 and BR-2400 do; an unreadable load counts as under the limit (BR-2630)
        const under = machine === undefined || machine.load5 < limit!;
        const last = lastRelease(d.dir);
        const spaced = last === undefined || d.now() - last >= d.intervalMs;
        if (!entry) {
          if (queue.length === 0 && under && spaced) return { go: true as const, waited: undefined, machine };
          entry = { seq: Math.max(0, ...queue.map((e) => e.seq)) + 1, pid: me.pid, pidStart: me.start, subject: req.subject, worktree: req.worktree, kind: req.kind, limit, queuedAt: d.now() };
          writeEntry(d.dir, entry);
          queue.push(entry);
        }
        const index = queue.findIndex((e) => e.seq === entry!.seq && e.pid === me.pid);
        if (index < 0) throw new Error("this step's load queue file was removed by another process");
        if (index === 0 && under && spaced) {
          rmSync(fileOf(d.dir, entry), { force: true });
          writeFileSync(join(d.dir, `${RELEASED}.tmp`), String(d.now()));
          renameSync(join(d.dir, `${RELEASED}.tmp`), join(d.dir, RELEASED));
          return { go: true as const, waited: d.now() - entry.queuedAt, machine };
        }
        return { go: false as const, ahead: index, machine };
      });
      if (step.go) {
        if (step.waited !== undefined) req.record("load.start", { kind: req.kind, waited_ms: step.waited, ...(step.machine ? { load: Math.round(step.machine.load5 * 10) / 10, cpus: step.machine.cpus, limit: req.perCpu * step.machine.cpus } : {}) });
        return ok("go");
      }
      // reason: a step ended by process.exit (a signal handler) must not leave its place in the queue behind (BR-2630)
      if (!armed) {
        process.on("exit", leave);
        armed = true;
      }
      const sig = String(step.ahead);
      if (said === "") req.record("load.wait", { kind: req.kind, ahead: step.ahead, ...(step.machine ? { load: Math.round(step.machine.load5 * 10) / 10, cpus: step.machine.cpus, limit: req.perCpu * step.machine.cpus } : {}) });
      if (sig !== said || d.now() - saidAt >= d.quietMs) {
        req.say(loadLine(step.machine, req.perCpu, step.ahead));
        said = sig;
        saidAt = d.now();
      }
      if (req.aborted()) {
        leave();
        return ok("aborted");
      }
      await d.sleep(d.pollMs);
      if (req.aborted()) {
        leave();
        return ok("aborted");
      }
    }
  } catch (e) {
    leave();
    return err("io", `load queue ${d.dir}: ${(e as Error).message}`);
  } finally {
    process.off("exit", leave);
  }
}

/**
 * The live waiting steps in queue order, read without the mutex and without deleting anything, for the agenda (BR-2582,
 * BR-2630): files are written whole by a rename, and one removed while it is read is a step that just left.
 */
export function loadWaitsNow(d: Pick<LoadDeps, "dir" | "gone"> = machineLoad): Result<readonly LoadEntry[]> {
  let names: string[];
  try {
    names = readdirSync(d.dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err("io", `load queue ${d.dir}: ${(e as Error).message}`);
  }
  const out: LoadEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let e: LoadEntry;
    try {
      e = JSON.parse(readFileSync(join(d.dir, name), "utf8")) as LoadEntry;
    } catch (x) {
      if ((x as NodeJS.ErrnoException).code === "ENOENT") continue;
      return err("io", `the load queue file ${join(d.dir, name)} cannot be read: ${(x as Error).message}`);
    }
    if (d.gone({ pid: e.pid, start: e.pidStart }) !== true) out.push(e);
  }
  return ok(out.sort((a, b) => a.seq - b.seq));
}

/** Why a heavy step started now would not start at once, or undefined when BR-2630 would let it go (BR-2631's hook asks). */
export type WouldWait =
  | { readonly reason: "load"; readonly machine: Machine; readonly limit: number }
  | { readonly reason: "queue"; readonly ahead: number }
  | { readonly reason: "spacing" };

/**
 * What passLoadGate would decide for a step arriving now, read without the mutex and changing nothing: a step is let go
 * only when nobody waits, the load is under the limit and the last release is at least `intervalMs` old (BR-2630). An
 * unreadable load is under the limit. A queue or `released` file that cannot be read fails loudly.
 */
export function wouldWait(d: Pick<LoadDeps, "dir" | "gone" | "now" | "read" | "intervalMs">, perCpu: number): Result<WouldWait | undefined> {
  const machine = d.read();
  const waits = loadWaitsNow(d);
  if (!waits.ok) return waits;
  try {
    if (machine && machine.load5 >= perCpu * machine.cpus) return ok({ reason: "load", machine, limit: perCpu * machine.cpus });
    if (waits.value.length > 0) return ok({ reason: "queue", ahead: waits.value.length });
    const last = lastRelease(d.dir);
    if (last !== undefined && d.now() - last < d.intervalMs) return ok({ reason: "spacing" });
    return ok(undefined);
  } catch (e) {
    return err("io", `load queue ${d.dir}: ${(e as Error).message}`);
  }
}
