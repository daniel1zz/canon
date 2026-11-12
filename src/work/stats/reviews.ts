import type { CoordDb } from "../db.ts";
import { DUPLICATE_CRITERIA, RULE_CRITERIA } from "../../knowledge/review/review.ts";
import { findingOf } from "../../knowledge/review/findings/findings.ts";

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
  return `rule reviews after landing: ${c.full} full, ${c.incremental} incremental, ${c.samePrompts + c.sameDocs} reused (${c.samePrompts} same prompts, ${c.sameDocs} same documents)`;
}

/** Below this many verified plus rejected findings of one criterion no rejected share is given (BR-2451, the bar of BR-2255). */
export const MIN_VERIFIED = 10;

/** What the verifier said about the blocking findings of one criterion (BR-2451, BR-2442). */
export interface CriterionCounts {
  readonly criterion: string;
  readonly verified: number;
  readonly rejected: number;
  readonly unverified: number;
}

/**
 * Per criterion, the blocking findings of the reviews after landing in the window that the verifier found to hold, rejected,
 * or did not verify (BR-2451): read from each review event's `verified` (BR-2442). Criteria in the order the prompts list them,
 * any other after them by name.
 */
export function verifiedByCriterion(db: CoordDb, since: number, until: number): CriterionCounts[] {
  const rows = db.db.query<{ detail: string }, [number, number]>("SELECT detail FROM events WHERE id > ? AND id <= ? AND kind IN ('review.ok', 'review.block') AND json_extract(detail, '$.verified') IS NOT NULL ORDER BY id").all(since, until);
  const counts = new Map<string, { verified: number; rejected: number; unverified: number }>();
  for (const r of rows) {
    const verified = (JSON.parse(r.detail) as { verified?: unknown }).verified;
    if (!Array.isArray(verified)) continue;
    for (const v of verified as { finding?: unknown; holds?: unknown }[]) {
      const criterion = findingOf(String(v.finding ?? "")).criterion;
      const c = counts.get(criterion) ?? { verified: 0, rejected: 0, unverified: 0 };
      if (v.holds === true) c.verified++;
      else if (v.holds === false) c.rejected++;
      else c.unverified++;
      counts.set(criterion, c);
    }
  }
  const known: readonly string[] = [...RULE_CRITERIA, ...DUPLICATE_CRITERIA];
  const rank = (c: string) => (known.includes(c) ? known.indexOf(c) : known.length);
  return [...counts].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([criterion, c]) => ({ criterion, ...c }));
}

/** The section, or undefined when no review after landing in the window had a blocking finding. */
export function renderVerifiedByCriterion(cs: readonly CriterionCounts[]): string | undefined {
  if (cs.length === 0) return undefined;
  const lines = ["review findings after landing by criterion:"];
  for (const c of cs) {
    const decided = c.verified + c.rejected;
    const tail = decided >= MIN_VERIFIED ? `, rejected share ${((100 * c.rejected) / decided).toFixed(1)}%` : `; fewer than ${MIN_VERIFIED} verified or rejected, no share`;
    lines.push(`  ${c.criterion}: ${c.verified} verified, ${c.rejected} rejected, ${c.unverified} not verified${tail}`);
  }
  return lines.join("\n");
}
