import type { CoordDb } from "../db.ts";

/** How the landings' rule reviews were done (BR-2397, D-81): in full, as a small review, or not run at all. */
export interface ReviewCounts {
  readonly full: number;
  readonly incremental: number;
  /** Reused because the same prompts passed (BR-2361). */
  readonly samePrompts: number;
  /** Reused because the same changed documents passed and nothing landed since (BR-2396). */
  readonly sameDocs: number;
}

/** The counts over the events after `since` up to `until`. A landing's rule review event carries `hash` or `incremental`; the duplicate review's carries neither. */
export function reviewCounts(db: CoordDb, since: number, until: number): ReviewCounts {
  const n = (sql: string) => db.db.query<{ n: number }, [number, number]>(`SELECT COUNT(*) AS n FROM events WHERE id > ? AND id <= ? AND ${sql}`).get(since, until)!.n;
  const verdict = "kind IN ('review.ok', 'review.block')";
  return {
    full: n(`${verdict} AND json_extract(detail, '$.hash') IS NOT NULL AND json_extract(detail, '$.incremental') IS NULL`),
    incremental: n(`${verdict} AND json_extract(detail, '$.incremental') IS NOT NULL`),
    samePrompts: n("kind = 'review.reused' AND json_extract(detail, '$.review') = 'land' AND json_extract(detail, '$.by') IS NULL"),
    sameDocs: n("kind = 'review.reused' AND json_extract(detail, '$.review') = 'land' AND json_extract(detail, '$.by') = 'docs'"),
  };
}

/** One line, or undefined when no landing reviewed a rule in the window. */
export function renderReviewCounts(c: ReviewCounts): string | undefined {
  if (c.full + c.incremental + c.samePrompts + c.sameDocs === 0) return undefined;
  return `rule reviews at landing: ${c.full} full, ${c.incremental} incremental, ${c.samePrompts + c.sameDocs} reused (${c.samePrompts} same prompts, ${c.sameDocs} same documents)`;
}
