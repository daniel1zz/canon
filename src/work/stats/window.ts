import type { CoordDb } from "../db.ts";

/**
 * A window of the event table after one event id (C-118). Agents' own numbers about a concurrent run are not
 * reliable, so the run is checked from the events it left: what landed, what was refused and why, how long
 * landings queued, who took part (BR-2154, BR-2155).
 */
export interface EventRow {
  readonly id: number;
  readonly ts: string;
  readonly actor: string;
  readonly worktree: string | null;
  readonly kind: string;
  readonly subject: string | null;
  readonly detail: Record<string, unknown>;
}

export interface EventFilter {
  /** Only events with an id above this one. */
  readonly since: number;
  /** Only events up to this id; no upper bound when absent. */
  readonly until?: number;
  /** Only these kinds; empty for every kind. */
  readonly kinds: readonly string[];
  /** Only events about this subject, e.g. a change id. */
  readonly subject?: string;
}

/** Parses `--since`: a non-negative whole event id, or undefined when it is not one. */
export function parseSince(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return undefined;
  return Number(v);
}

/** The highest event id so far, 0 for an empty table: the upper bound that keeps several reads on the same events (issue #37). */
export function lastEventId(db: CoordDb): number {
  return db.db.query<{ n: number | null }, []>("SELECT MAX(id) AS n FROM events").get()?.n ?? 0;
}

/** The events after `since` that match the filter, oldest first (BR-2156). */
export function eventsSince(db: CoordDb, f: EventFilter): EventRow[] {
  const where = ["id > ?"];
  const params: (string | number)[] = [f.since];
  if (f.until !== undefined) {
    where.push("id <= ?");
    params.push(f.until);
  }
  if (f.kinds.length > 0) {
    where.push(`kind IN (${f.kinds.map(() => "?").join(",")})`);
    params.push(...f.kinds);
  }
  if (f.subject !== undefined) {
    where.push("subject = ?");
    params.push(f.subject);
  }
  return db.db
    .query<{ id: number; ts: string; actor: string; worktree: string | null; kind: string; subject: string | null; detail: string }, (string | number)[]>(
      `SELECT id, ts, actor, worktree, kind, subject, detail FROM events WHERE ${where.join(" AND ")} ORDER BY id`,
    )
    .all(...params)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

export function renderEvents(rows: readonly EventRow[]): string {
  if (rows.length === 0) return "(no events)";
  return rows.map((r) => `#${r.id} ${r.ts} ${r.actor} ${r.worktree ?? "-"} ${r.kind} ${r.subject ?? "-"} ${JSON.stringify(r.detail)}`).join("\n");
}

export interface WindowSummary {
  readonly since: number;
  /** The last event id the summary covers. */
  readonly until: number;
  readonly events: number;
  readonly first: string | null;
  readonly last: string | null;
  readonly landings: {
    readonly ok: number;
    /** Refusals by reason, most frequent first. */
    readonly refused: Readonly<Record<string, number>>;
    readonly lost: number;
    readonly killed: number;
  };
  /** Queue waits from `land.turn`, in milliseconds; median and max are null when no landing got its turn. */
  readonly waits: { readonly count: number; readonly medianMs: number | null; readonly maxMs: number | null };
  /** Refusals with reason `conflict`; `early` of them were predicted before the turn. */
  readonly conflicts: { readonly total: number; readonly early: number };
  readonly overlapNotices: number;
  readonly claimRefusals: number;
  readonly actors: readonly string[];
  readonly worktrees: readonly string[];
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** The concurrency summary of the events after `since`, up to `until` (BR-2155). */
export function windowSummary(db: CoordDb, since: number, until = lastEventId(db)): WindowSummary {
  const rows = eventsSince(db, { since, until, kinds: [] });
  const of = (kind: string) => rows.filter((r) => r.kind === kind);
  const refusals = of("land.refuse");
  const refused: Record<string, number> = {};
  for (const r of refusals) {
    const reason = typeof r.detail["reason"] === "string" ? r.detail["reason"] : "unrecorded";
    refused[reason] = (refused[reason] ?? 0) + 1;
  }
  const sortedRefused = Object.fromEntries(Object.entries(refused).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const waits = of("land.turn").flatMap((r) => (typeof r.detail["waited_ms"] === "number" ? [r.detail["waited_ms"]] : []));
  const conflicts = refusals.filter((r) => r.detail["reason"] === "conflict");
  return {
    since,
    until,
    events: rows.length,
    first: rows[0]?.ts ?? null,
    last: rows.at(-1)?.ts ?? null,
    landings: { ok: of("land.ok").length, refused: sortedRefused, lost: of("land.lost").length, killed: of("land.killed").length },
    waits: { count: waits.length, medianMs: median(waits), maxMs: waits.length ? Math.max(...waits) : null },
    conflicts: { total: conflicts.length, early: conflicts.filter((r) => r.detail["early"] === true).length },
    overlapNotices: of("overlap.notice").length,
    claimRefusals: of("claim.refuse").length,
    actors: [...new Set(rows.map((r) => r.actor))].sort(),
    worktrees: [...new Set(rows.flatMap((r) => (r.worktree ? [r.worktree] : [])))].sort(),
  };
}

const secs = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`);

export function renderWindow(w: WindowSummary): string {
  const refused = Object.entries(w.landings.refused);
  const total = refused.reduce((n, [, c]) => n + c, 0);
  return [
    `window: events after #${w.since} up to #${w.until}: ${w.events} event(s)${w.first ? `, ${w.first} to ${w.last}` : ""}`,
    `  landings: ${w.landings.ok} ok, ${total} refused${total ? ` (${refused.map(([r, c]) => `${r} ${c}`).join(", ")})` : ""}, ${w.landings.lost} lost, ${w.landings.killed} killed`,
    `  queue waits: ${w.waits.count} turn(s), median ${secs(w.waits.medianMs)}, max ${secs(w.waits.maxMs)}`,
    `  conflicts: ${w.conflicts.total} (${w.conflicts.early} predicted before the turn)`,
    `  overlap notices: ${w.overlapNotices}; claim refusals: ${w.claimRefusals}`,
    `  actors (${w.actors.length}): ${w.actors.join(", ") || "-"}`,
    `  worktrees (${w.worktrees.length}): ${w.worktrees.join(", ") || "-"}`,
  ].join("\n");
}
