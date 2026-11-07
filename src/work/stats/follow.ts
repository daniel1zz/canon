import type { CoordDb } from "../db.ts";
import { eventsSince, lastEventId, type EventFilter, type EventRow } from "./window.ts";

export const FOLLOW_INTERVAL_MS = 1000;

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
): Promise<void> {
  let cursor = since ?? lastEventId(db);
  while (!stopped()) {
    // reason: claim lapses are events only once some command has judged the claim, so following judges them each round (BR-2360, D-66).
    beforePoll();
    // The upper bound is read first, so an event written between the two queries is picked up next round.
    const until = lastEventId(db);
    if (until > cursor) {
      for (const row of eventsSince(db, { ...filter, since: cursor, until })) emit(row);
      cursor = until;
    }
    if (stopped()) return;
    await sleep(intervalMs);
  }
}
