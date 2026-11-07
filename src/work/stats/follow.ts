import type { CoordDb } from "../db.ts";
import { eventsSince, lastEventId, type EventFilter, type EventRow } from "./window.ts";

export const FOLLOW_INTERVAL_MS = 1000;
/** How often following judges the claims: each judgement runs `ps` once per claim (BR-2357). */
export const CLAIM_JUDGE_INTERVAL_MS = 5000;

/** SQLite reported the database busy or locked: another process holds the write lock longer than the busy timeout. */
const isBusy = (e: unknown): boolean => /SQLITE_(BUSY|LOCKED)|database is locked/.test(String((e as { code?: string })?.code ?? "") + " " + String((e as Error)?.message ?? ""));

/**
 * `canon events --follow` (BR-2357): emits the events after `since` (default: the latest event) that match the
 * filter, then polls the event table by id every `intervalMs` until `stopped()` is true. Read only apart from what `beforePoll` writes.
 * reason: polling by id, not watching the WAL file: file watchers differ by platform and miss coalesced writes (BR-2357).
 */
export async function followEvents(
  db: CoordDb,
  filter: Omit<EventFilter, "since" | "until">,
  since: number | undefined,
  emit: (row: EventRow) => void,
  stopped: () => boolean,
  beforePoll: () => void = () => {},
  intervalMs = FOLLOW_INTERVAL_MS,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  clock: () => number = Date.now,
): Promise<void> {
  let cursor = since ?? lastEventId(db);
  let judgedAt = -Infinity;
  while (!stopped()) {
    try {
      // reason: claim lapses are events only once some command has judged the claim, so following judges them, every 5 s rather than every round because each judgement runs ps per claim (BR-2357, BR-2360, D-66).
      if (clock() - judgedAt >= CLAIM_JUDGE_INTERVAL_MS) {
        judgedAt = clock();
        beforePoll();
      }
      // The upper bound is read first, so an event written between the two queries is picked up next round.
      const until = lastEventId(db);
      if (until > cursor) {
        for (const row of eventsSince(db, { ...filter, since: cursor, until })) emit(row);
        cursor = until;
      }
    } catch (e) {
      // reason: a landing can hold the write lock past the busy timeout; following skips the round instead of ending (BR-2357).
      if (!isBusy(e)) throw e;
    }
    if (stopped()) return;
    await sleep(intervalMs);
  }
}
