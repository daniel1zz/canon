import { isGone } from "../claims/liveness.ts";
import type { Workspace } from "../workspace.ts";

/**
 * The full test runs running and waiting on this machine (BR-2582, D-151), read only from the event table: the side that
 * queues them (`canon work test --all`, the background floor) writes `test.full.wait`, `test.full.start` and
 * `test.full.end`, each naming its process by pid and start time; this side never writes them.
 */
export interface FullRun {
  /** The change or chore it tests; null for main's background floor. */
  readonly subject: string | null;
  /** When it started, ISO 8601. */
  readonly since: string;
}

export interface HeavyRuns {
  readonly running: readonly FullRun[];
  readonly waiting: number;
}

/** How a process is told alive; tests pass their own. Unreadable process tables count as alive: a run is not dropped on a guess. */
export type Alive = (pid: number, start: string) => boolean;
const alive: Alive = (pid, start) => isGone({ pid, start }) !== true;

/** The running and waiting full test runs: the latest event of each live process decides (BR-2582). */
export function runningFullRuns(ws: Workspace, isAlive: Alive = alive): HeavyRuns {
  const rows = ws.db.db
    .query<{ ts: string; kind: string; detail: string }, []>("SELECT ts, kind, detail FROM events WHERE kind IN ('test.full.wait', 'test.full.start', 'test.full.end') ORDER BY id")
    .all();
  const last = new Map<string, { ts: string; kind: string; subject: string | null; pid: number; start: string }>();
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { subject?: unknown; pid?: unknown; pid_start?: unknown };
    if (typeof d.pid !== "number" || typeof d.pid_start !== "string") continue;
    const key = `${d.pid} ${d.pid_start}`;
    // reason: a run's start time is its first start event, even if a wait was written again before its end (BR-2582)
    const prev = last.get(key);
    if (prev?.kind === "test.full.start" && r.kind === "test.full.start") continue;
    last.set(key, { ts: r.ts, kind: r.kind, subject: typeof d.subject === "string" ? d.subject : null, pid: d.pid, start: d.pid_start });
  }
  const running: FullRun[] = [];
  let waiting = 0;
  for (const p of last.values()) {
    if (p.kind === "test.full.end" || !isAlive(p.pid, p.start)) continue;
    if (p.kind === "test.full.start") running.push({ subject: p.subject, since: p.ts });
    else waiting++;
  }
  return { running, waiting };
}
