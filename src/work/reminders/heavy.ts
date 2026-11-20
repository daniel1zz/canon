import { ok, type Result } from "../../kernel/result.ts";
import { fullRunsNow, machineSlots, type SlotDeps } from "../verify/slot.ts";

/**
 * The full test runs running and waiting on this machine (BR-2582, D-151): read from the machine-wide queue of full runs
 * (BR-2576, BR-2577), which covers every repository on the machine and leaves out runs whose process is gone. The side
 * that queues them also writes `test.full.*` events for the history; this side only reads the queue.
 */
export interface FullRun {
  /** The change or chore it tests; `main` for main's background floor. */
  readonly subject: string;
  /** When it took its slot, ISO 8601. */
  readonly since: string;
}

export interface HeavyRuns {
  readonly running: readonly FullRun[];
  readonly waiting: number;
}

/** Where the queue is and how a process is told gone; tests pass their own. */
export type Slots = Pick<SlotDeps, "dir" | "gone">;

export function runningFullRuns(slots: Slots = machineSlots): Result<HeavyRuns> {
  const entries = fullRunsNow(slots);
  if (!entries.ok) return entries;
  const running: FullRun[] = [];
  let waiting = 0;
  for (const e of entries.value) {
    if (e.startedAt === undefined) waiting++;
    else running.push({ subject: e.subject ?? "main", since: new Date(e.startedAt).toISOString() });
  }
  return ok({ running, waiting });
}
