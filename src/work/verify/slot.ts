import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { isGone, processOf, type Proc } from "../claims/liveness.ts";

/**
 * The machine-wide queue of full test runs (BR-2576 to BR-2580, D-151): `canon work test` with no file list and the
 * background floor run take a slot before any test runs, so the machine's CPUs go to one full run at a time, not to
 * several that all hit test_timeout_minutes (F-4/S2).
 *
 * One file per run in a directory under the user's state directory, named by a sequence number; a mutex directory
 * serialises the few milliseconds in which the queue is read and changed. A run may go when its place in the live
 * queue is within the limit; an entry whose process is gone is dropped by whoever reads the queue next (BR-2577).
 */

/** The state directory canon keeps machine-wide: `CANON_MACHINE_DIR`, else `$XDG_STATE_HOME/canon`, else `~/.local/state/canon`. */
export function machineDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const set = env["CANON_MACHINE_DIR"];
  if (set) return set;
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg ? xdg : join(home, ".local", "state"), "canon");
}

export interface SlotDeps {
  /** The directory the queue lives in (created when missing). */
  readonly dir: string;
  readonly pollMs: number;
  readonly now: () => number;
  /** This process; undefined when the process table cannot be read, which fails the run loudly. */
  readonly self: () => Proc | undefined;
  /** True only when the process is provably gone (BR-2577); undefined when that cannot be told. */
  readonly gone: (p: Proc) => boolean | undefined;
  readonly sleep: (ms: number) => Promise<void>;
}

export const machineSlots: SlotDeps = {
  dir: join(machineDir(), "full-runs"),
  pollMs: 2000,
  now: Date.now,
  self: () => processOf(process.pid),
  gone: (p) => isGone(p),
  sleep: (ms) => Bun.sleep(ms),
};

/** The machine-wide critical-path lane: named-file runs of changes others wait on, one at a time, not waiting for the load (BR-2643). */
export const machineLane: SlotDeps = { ...machineSlots, dir: join(machineDir(), "critical-lane") };

/** What a queue file says about a run. */
export interface Entry {
  readonly seq: number;
  readonly pid: number;
  readonly pidStart: string;
  /** The change or chore the run is for; null for the background floor of main. */
  readonly subject: string | null;
  readonly worktree: string;
  readonly kind: "work-test" | "floor";
  readonly queuedAt: number;
  /** When it took its slot; absent while it waits. */
  readonly startedAt?: number;
}

export type Outcome = "passed" | "failed" | "stopped";

export interface SlotRequest {
  readonly subject: string | null;
  readonly worktree: string;
  readonly kind: Entry["kind"];
  /** `full_test_slots`: the most full runs at once, by this run's own project. */
  readonly max: number;
  readonly say: (line: string) => void;
  /** Turns true when the run is stopped while it waits. */
  readonly aborted: () => boolean;
  /** Writes a coordination event: kind `test.full.wait`, `test.full.start` or `test.full.end` (BR-2576). */
  readonly record: (kind: "test.full.wait" | "test.full.start" | "test.full.end", detail: Record<string, unknown>) => void;
}

export interface Slot {
  /** Gives the slot back and records `test.full.end`; once. */
  readonly release: (outcome: Outcome) => void;
  /**
   * The run passed the load gate (BR-2630) and starts now: its start time becomes this moment, so the agenda counts it as
   * running from here and not while it waited for the load (BR-2582).
   */
  readonly began: () => void;
}

const MUTEX = ".mutex";
/** A mutex directory with no owner written for this long was left by a process that died between mkdir and writing it. */
const MUTEX_ORPHAN_MS = 5000;

const fileOf = (dir: string, e: { seq: number; pid: number }) => join(dir, `${String(e.seq).padStart(12, "0")}-${e.pid}.json`);

function readEntries(dir: string): Entry[] {
  const out: Entry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      out.push(JSON.parse(readFileSync(path, "utf8")) as Entry);
    } catch (e) {
      // reason: a queue file that cannot be read cannot be told from a live run, so the run stops instead of jumping the queue
      throw new Error(`the full-run queue file ${path} cannot be read: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function writeEntry(dir: string, e: Entry): void {
  const path = fileOf(dir, e);
  // reason: written then renamed, so a reader never sees half a file
  writeFileSync(`${path}.tmp`, JSON.stringify(e));
  renameSync(`${path}.tmp`, path);
}

/** Takes the mutex, runs `fn`, gives it back; waits while another process holds it, and clears one whose holder is gone. */
export async function withMutex<T>(d: Pick<SlotDeps, "dir" | "now" | "self" | "gone" | "sleep">, fn: () => T): Promise<T> {
  const mutex = join(d.dir, MUTEX);
  for (;;) {
    try {
      mkdirSync(mutex);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const owner = join(mutex, "owner");
    let held: Proc | undefined;
    try {
      held = JSON.parse(readFileSync(owner, "utf8")) as Proc;
    } catch {
      held = undefined;
    }
    let stale = false;
    if (held) stale = d.gone(held) === true;
    else {
      try {
        stale = d.now() - statSync(mutex).mtimeMs > MUTEX_ORPHAN_MS;
      } catch {
        stale = false; // it went while we looked: try the mkdir again
      }
    }
    if (stale) rmSync(mutex, { recursive: true, force: true });
    else await d.sleep(20);
  }
  try {
    const me = d.self();
    if (me) writeFileSync(join(mutex, "owner"), JSON.stringify(me));
    return fn();
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
}

/** The live entries in order; entries of processes that are gone are deleted and returned in `dropped`. */
function liveEntries(d: SlotDeps): { live: Entry[]; dropped: Entry[] } {
  const live: Entry[] = [];
  const dropped: Entry[] = [];
  for (const e of readEntries(d.dir)) {
    if (d.gone({ pid: e.pid, start: e.pidStart }) === true) {
      rmSync(fileOf(d.dir, e), { force: true });
      dropped.push(e);
    } else live.push(e);
  }
  return { live, dropped };
}

const mins = (ms: number) => Math.max(0, Math.floor(ms / 60000));

/** How a run ahead is named in the waiting line: its change (or `main floor`) and worktree, and how long it has run. */
export function describe(e: Entry, now: number): string {
  const name = e.subject ?? (e.kind === "floor" ? "main floor" : basename(e.worktree));
  return `${name} (${e.worktree}, ${e.startedAt === undefined ? "waiting" : `running ${mins(now - e.startedAt)} min`})`;
}

/** The waiting line (BR-2576). */
export function waitingLine(ahead: readonly Entry[], now: number): string {
  return `canon: waiting for a full test run slot: ${ahead.length} full run(s) ahead on this machine: ${ahead.map((e) => describe(e, now)).join(", ")}; the wait does not count toward test_timeout_minutes`;
}

/** Every live full run on the machine, in queue order, for the agenda and for tests (BR-2576). Drops the entries of processes that are gone. */
export async function fullRuns(d: SlotDeps = machineSlots): Promise<Result<readonly Entry[]>> {
  try {
    mkdirSync(d.dir, { recursive: true });
    return ok(await withMutex(d, () => liveEntries(d).live));
  } catch (e) {
    return err("io", `full-run queue ${d.dir}: ${(e as Error).message}`);
  }
}

/**
 * The live full runs on the machine in queue order, read without the mutex and without deleting anything, for readers
 * that only look (the agenda, BR-2582): queue files are written whole by a rename, and one removed while it is read is a
 * run that just ended. Entries whose process is gone are left out, not deleted.
 */
export function fullRunsNow(d: Pick<SlotDeps, "dir" | "gone"> = machineSlots): Result<readonly Entry[]> {
  let names: string[];
  try {
    names = readdirSync(d.dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err("io", `full-run queue ${d.dir}: ${(e as Error).message}`);
  }
  const out: Entry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let e: Entry;
    try {
      e = JSON.parse(readFileSync(join(d.dir, name), "utf8")) as Entry;
    } catch (x) {
      // reason: a run that ended between the listing and the read is simply not running (BR-2582)
      if ((x as NodeJS.ErrnoException).code === "ENOENT") continue;
      return err("io", `the full-run queue file ${join(d.dir, name)} cannot be read: ${(x as Error).message}`);
    }
    if (d.gone({ pid: e.pid, start: e.pidStart }) !== true) out.push(e);
  }
  return ok(out.sort((a, b) => a.seq - b.seq));
}

/**
 * Takes a slot: queues behind the full runs already there, says how many are ahead and which when it has to wait, and
 * returns once its place is within `max` (BR-2576, BR-2577). "aborted" when `aborted()` turned true while waiting, after
 * leaving the queue.
 */
export async function acquireSlot(d: SlotDeps, req: SlotRequest): Promise<Result<Slot | "aborted">> {
  try {
    mkdirSync(d.dir, { recursive: true });
    const me = d.self();
    if (!me) return err("io", "the process table cannot be read, so this run cannot take its place in the full-run queue");
    const pid = { pid: me.pid, pid_start: me.start };
    const base = { subject: req.subject, ...pid };
    let entry: Entry | undefined;
    let shown = "";
    for (;;) {
      const step = await withMutex(d, () => {
        const { live } = liveEntries(d);
        if (!entry) {
          entry = { seq: Math.max(0, ...live.map((e) => e.seq)) + 1, pid: me.pid, pidStart: me.start, subject: req.subject, worktree: req.worktree, kind: req.kind, queuedAt: d.now() };
          writeEntry(d.dir, entry);
          live.push(entry);
        }
        const index = live.findIndex((e) => e.seq === entry!.seq && e.pid === me.pid);
        if (index < 0) throw new Error("this run's queue file was removed by another process");
        if (index < req.max) {
          entry = { ...entry, startedAt: d.now() };
          writeEntry(d.dir, entry);
          return { go: true as const, ahead: index };
        }
        return { go: false as const, ahead: live.slice(0, index) };
      });
      if (step.go) {
        let started = entry!.startedAt!;
        req.record("test.full.start", base);
        let released = false;
        let mine = entry!;
        return ok({
          began: () => {
            if (released) return;
            started = d.now();
            mine = { ...mine, startedAt: started };
            writeEntry(d.dir, mine);
          },
          release: (outcome) => {
            if (released) return;
            released = true;
            rmSync(fileOf(d.dir, mine), { force: true });
            req.record("test.full.end", { ...base, duration_ms: d.now() - started, outcome });
          },
        });
      }
      const sig = step.ahead.map((e) => `${e.seq}:${e.startedAt === undefined ? "w" : "r"}`).join(",");
      if (sig !== shown) {
        if (shown === "") req.record("test.full.wait", { ...base, ahead: step.ahead.length });
        req.say(waitingLine(step.ahead, d.now()));
        shown = sig;
      }
      if (req.aborted()) {
        rmSync(fileOf(d.dir, entry!), { force: true });
        return ok("aborted");
      }
      await d.sleep(d.pollMs);
      if (req.aborted()) {
        rmSync(fileOf(d.dir, entry!), { force: true });
        return ok("aborted");
      }
    }
  } catch (e) {
    return err("io", `full-run queue ${d.dir}: ${(e as Error).message}`);
  }
}
