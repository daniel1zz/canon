import { availableParallelism, loadavg } from "node:os";
import type { CoordDb } from "../db.ts";
import { liveClaims } from "../claims/claims.ts";

/**
 * Whether the machine is already overloaded when a change starts (BR-2400, #155): a hint, never a refusal. Landing turns
 * record the load they ran at, so the hint can say how long turns took when the machine was this busy and when it was not.
 */

/** The machine's 5-minute load average and CPU count. */
export interface Machine {
  readonly load5: number;
  readonly cpus: number;
}

/** The machine now; undefined where the platform reports no load average (all zeros, as on Windows). */
export function machineNow(): Machine | undefined {
  const avg = loadavg();
  // reason: a platform without load averages reports zeros; the hint is then not given, never guessed (BR-2400)
  if (avg.every((x) => x === 0)) return undefined;
  return { load5: avg[1]!, cpus: availableParallelism() };
}

/** What a landing turn records about the machine (BR-2400). */
export function loadDetail(): { load?: number; cpus?: number } {
  const m = machineNow();
  return m ? { load: Math.round(m.load5 * 10) / 10, cpus: m.cpus } : {};
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** The fewest turns a median is given for. */
export const MIN_TURNS = 3;
/** How many recent landing turns are read. */
const RECENT = 200;

/**
 * The hint lines for a change starting on `machine` (BR-2400): none below twice the CPU count; otherwise the load, the
 * CPUs, the live claims, and the median landing turn (land.turn to the change's next land.ok) of recent turns at that
 * load and below it, each when there are at least MIN_TURNS.
 */
export function overloadLines(db: CoordDb, machine: Machine | undefined): string[] {
  if (!machine || machine.load5 < 2 * machine.cpus) return [];
  const claims = liveClaims(db).length;
  const lines = [
    `machine busy: 5-minute load ${machine.load5.toFixed(1)} on ${machine.cpus} CPUs (at or over ${2 * machine.cpus}); ${claims} change(s) claimed. The change starts, but more work at once slows every floor and lengthens the landing queue: wait for the load to fall, or land the changes already open first`,
  ];
  const turns = db.db
    .query<{ id: number; subject: string; detail: string }, [number]>("SELECT id, subject, detail FROM events WHERE kind = 'land.turn' AND subject IS NOT NULL ORDER BY id DESC LIMIT ?")
    .all(RECENT);
  const busy: number[] = [];
  const calm: number[] = [];
  for (const t of turns) {
    const d = JSON.parse(t.detail) as { load?: unknown; cpus?: unknown };
    if (typeof d.load !== "number" || typeof d.cpus !== "number") continue;
    const end = db.db
      .query<{ kind: string; ms: number }, [string, number]>("SELECT kind, (julianday(ts) - julianday((SELECT ts FROM events WHERE id = ?2))) * 86400000 AS ms FROM events WHERE subject = ?1 AND id > ?2 AND kind IN ('land.ok', 'land.refuse', 'land.killed', 'land.lost') ORDER BY id LIMIT 1")
      .get(t.subject, t.id);
    if (end?.kind !== "land.ok") continue;
    (d.load >= 2 * d.cpus ? busy : calm).push(end.ms);
  }
  const min = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
  if (busy.length >= MIN_TURNS && calm.length >= MIN_TURNS) lines.push(`landing turns (land.turn to land.ok) recently: median ${min(median(busy))} at a load this high (${busy.length}), ${min(median(calm))} below it (${calm.length})`);
  return lines;
}

/** The hint `canon work start` gives (BR-2400): only for a new worktree, never for `--fix-main`, whose fix of a red main must not wait. */
export function startHint(db: CoordDb, machine: Machine | undefined, start: { fixMain: boolean; created: boolean }): string[] {
  return start.fixMain || !start.created ? [] : overloadLines(db, machine);
}
