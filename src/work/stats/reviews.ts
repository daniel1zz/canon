import type { CoordDb } from "../db.ts";
import { DUPLICATE_CRITERIA, RULE_CRITERIA } from "../../knowledge/review/review.ts";

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

/** Below this many fixed plus spurious findings of one criterion no spurious share is given (BR-2451, the bar of BR-2255). */
export const MIN_SETTLED = 10;

/** How the open findings of one criterion recorded by the reviews after landing ended (BR-2451, BR-2453). */
export interface CriterionCounts {
  readonly criterion: string;
  readonly open: number;
  readonly fixed: number;
  readonly spurious: number;
  readonly retired: number;
  /** Closed any other way: the re-asking of earlier canon builds. */
  readonly otherwise: number;
}

/**
 * Per criterion, the open findings whose recording event is in the window, by how they ended (BR-2451): still open, fixed,
 * spurious, retired with a document, or otherwise. Criteria in the order the prompts list them, any other after them by name.
 */
export function findingsByCriterion(db: CoordDb, since: number, until: number): CriterionCounts[] {
  const rows = db.db.query<{ criterion: string; closed_how: string | null }, [number, number]>("SELECT criterion, closed_how FROM review_findings WHERE event > ? AND event <= ? ORDER BY id").all(since, until);
  const counts = new Map<string, { open: number; fixed: number; spurious: number; retired: number; otherwise: number }>();
  for (const r of rows) {
    const c = counts.get(r.criterion) ?? { open: 0, fixed: 0, spurious: 0, retired: 0, otherwise: 0 };
    if (r.closed_how === null) c.open++;
    else if (r.closed_how === "fixed" || r.closed_how === "spurious" || r.closed_how === "retired") c[r.closed_how]++;
    else c.otherwise++;
    counts.set(r.criterion, c);
  }
  const known: readonly string[] = [...RULE_CRITERIA, ...DUPLICATE_CRITERIA];
  const rank = (c: string) => (known.includes(c) ? known.indexOf(c) : known.length);
  return [...counts].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([criterion, c]) => ({ criterion, ...c }));
}

/** The section, or undefined when the window recorded no open finding. */
export function renderFindingsByCriterion(cs: readonly CriterionCounts[]): string | undefined {
  if (cs.length === 0) return undefined;
  const lines = ["review findings after landing by criterion:"];
  for (const c of cs) {
    const settled = c.fixed + c.spurious;
    const other = c.otherwise > 0 ? `, ${c.otherwise} closed otherwise` : "";
    const tail = settled >= MIN_SETTLED ? `, spurious share ${((100 * c.spurious) / settled).toFixed(1)}%` : `; fewer than ${MIN_SETTLED} fixed or spurious, no share`;
    lines.push(`  ${c.criterion}: ${c.open} open, ${c.fixed} fixed, ${c.spurious} spurious, ${c.retired} retired${other}${tail}`);
  }
  return lines.join("\n");
}
