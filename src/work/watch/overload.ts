import type { CoordDb } from "../db.ts";
import type { Machine } from "../session/load.ts";
import { machineLoad } from "../verify/load-gate.ts";

/**
 * A background floor that fails while the machine is overloaded says nothing about main (BR-2666, D-172): test shards that
 * hit their own timeout under a 5-minute load of 20 to 38 on 8 CPUs failed a main whose tests all passed (#317). Such a
 * failure is recorded as `floor.overload` and main is tested again once the load falls; the OVERLOAD_TRIES-th one in a row
 * counts as a failure, so a floor that fails whatever the load is still reaches a fix change.
 */
export const OVERLOAD_TRIES = 3;

export interface Overload {
  /** The 5-minute load, rounded to one decimal. */
  readonly load: number;
  readonly cpus: number;
  /** heavy_max_load_per_cpu × CPUs (BR-2665). */
  readonly limit: number;
  /** This failure's place among the overload failures in a row, 1 for the first. */
  readonly attempt: number;
}

/** The background floor results that end a run of overload failures, and the overload failures themselves. */
const RESULT_KINDS = "'floor.pass', 'floor.fail', 'floor.skip', 'floor.overload'";

/**
 * The overload a failed background floor ended under: the 5-minute load at or above `perCpu` × CPUs, compared unrounded as
 * the load gate compares it (BR-2630); undefined when the load is under the limit or cannot be read.
 */
export function overloadOf(db: CoordDb, perCpu: number, read: () => Machine | undefined = machineLoad.read): Overload | undefined {
  const m = read();
  if (!m || m.load5 < perCpu * m.cpus) return undefined;
  const kinds = db.db.query<{ kind: string }, [number]>(`SELECT kind FROM events WHERE kind IN (${RESULT_KINDS}) ORDER BY id DESC LIMIT ?`).all(OVERLOAD_TRIES);
  const before = kinds.findIndex((k) => k.kind !== "floor.overload");
  return { load: Math.round(m.load5 * 10) / 10, cpus: m.cpus, limit: perCpu * m.cpus, attempt: (before === -1 ? kinds.length : before) + 1 };
}
