import { ok, type Result } from "../../kernel/result.ts";
import { loadWaitsNow, machineLoad, type LoadDeps, type StepKind } from "../verify/load-gate.ts";
import { fullRunsNow, machineLane, machineSlots, type SlotDeps } from "../verify/slot.ts";

/**
 * The full test runs running and waiting on this machine, and the heavy steps waiting for the load (BR-2582, D-151,
 * BR-2630): read from the machine-wide queues (BR-2576, BR-2577, BR-2630), which cover every repository on the machine and
 * leave out processes that are gone. The side that queues them also writes events for the history; this side only reads.
 */
export interface FullRun {
  /** The change or chore it tests; `main` for main's background floor. */
  readonly subject: string;
  /** When it began running, ISO 8601: for a run that waited for the load, when it passed the load gate (BR-2582). */
  readonly since: string;
}

/** A heavy step in the load queue (BR-2630): how the agenda names it and how long it has waited. */
export interface LoadWait {
  /** `C-9`, or `C-9（<worktree>）` for a step of another repository (BR-2630). */
  readonly subject: string;
  readonly kind: StepKind;
  /** When it joined the queue, ISO 8601. */
  readonly since: string;
}

export interface HeavyRuns {
  readonly running: readonly FullRun[];
  /** Full runs that wait for a slot. */
  readonly waiting: number;
  /** Heavy steps waiting for the load, in queue order. */
  readonly loadWaiting: readonly LoadWait[];
  /** The critical-path lane (BR-2643): the run in it, and how many wait behind it. */
  readonly lane?: { readonly running: readonly FullRun[]; readonly waiting: number };
}

/** Where the queues are and how a process is told gone; tests pass their own. */
export type Slots = Pick<SlotDeps, "dir" | "gone">;
export type Loads = Pick<LoadDeps, "dir" | "gone">;

/**
 * `here` is the repository the agenda is for: its own worktrees are named by their change alone, those of another repository
 * with their worktree path (BR-2630). A full run that holds a slot but is still in the load queue is waiting for the load,
 * not running (BR-2582).
 */
export function runningFullRuns(slots: Slots = machineSlots, load: Loads = machineLoad, here?: { readonly primary: string }, laneSlots: Slots = machineLane): Result<HeavyRuns> {
  const entries = fullRunsNow(slots);
  if (!entries.ok) return entries;
  // reason: the critical-path lane is listed apart from the full runs and the load queue (BR-2643)
  const inLane = fullRunsNow(laneSlots);
  if (!inLane.ok) return inLane;
  const lane = { running: inLane.value.filter((e) => e.startedAt !== undefined).map((e) => ({ subject: e.subject ?? "main", since: new Date(e.startedAt!).toISOString() })), waiting: inLane.value.filter((e) => e.startedAt === undefined).length };
  const waits = loadWaitsNow(load);
  if (!waits.ok) return waits;
  const gated = new Set(waits.value.map((w) => w.pid));
  const running: FullRun[] = [];
  let waiting = 0;
  for (const e of entries.value) {
    if (e.startedAt === undefined) waiting++;
    else if (!gated.has(e.pid)) running.push({ subject: e.subject ?? "main", since: new Date(e.startedAt).toISOString() });
  }
  const own = (worktree: string) => here === undefined || worktree === here.primary || worktree.startsWith(`${here.primary}.worktrees/`);
  const loadWaiting = waits.value.map((w) => ({ subject: own(w.worktree) ? w.subject : `${w.subject}（${w.worktree}）`, kind: w.kind, since: new Date(w.queuedAt).toISOString() }));
  return ok({ running, waiting, loadWaiting, lane });
}
