import type { CoordDb } from "../db.ts";

/**
 * A subagent's change refused three times in a row stops and goes to the main agent (BR-2454, D-99); the main session or a
 * person lets it land again with `canon work unstall` (BR-2455).
 */

/** How many refusals in a row stop a subagent's change (D-99: the owner's “三次没有合并成功再给主Agent”). */
export const STALL_LIMIT = 3;

// reason: races, the machine and setup mistakes are not the subagent's to fix nor the dispatcher's to avoid, so they do not count (BR-2454)
const NOT_COUNTED: readonly string[] = ["claimed", "environment", "timeout", "main-dirty", "main-moved", "moved-during-land", "lost-turn", "no-floor", "no-claim", "on-main", "stalled"];

/** Whether `actor` is a subagent: `agent:<session>:<name>`, as BR-2023 builds it for `--as`. */
export function isSubagent(actor: string): boolean {
  return /^agent:[^:]+:.+$/.test(actor);
}

export interface Refusal {
  readonly ts: string;
  readonly reason: string;
}

/** The counted refusals of `change` since its latest `land.ok` or `land.unstall`, oldest first (BR-2454). */
export function refusalsInARow(db: CoordDb, change: string): Refusal[] {
  const reset = db.db.query<{ id: number | null }, [string]>("SELECT MAX(id) AS id FROM events WHERE subject = ? AND kind IN ('land.ok', 'land.unstall')").get(change)?.id ?? 0;
  return db.db
    .query<{ ts: string; detail: string }, [string, number]>("SELECT ts, detail FROM events WHERE subject = ? AND kind = 'land.refuse' AND id > ? ORDER BY id")
    .all(change, reset)
    .map((r) => ({ ts: r.ts, reason: String((JSON.parse(r.detail) as { reason?: unknown }).reason ?? "") }))
    .filter((r) => !NOT_COUNTED.includes(r.reason));
}

/** Whether a refusal with this reason counts (BR-2454). */
export const counted = (reason: string): boolean => !NOT_COUNTED.includes(reason);

/** What to do now: the line a stopped change's landing and its third refusal end with (BR-2454). */
export function stallAdvice(change: string): string {
  return `${change} has been refused ${STALL_LIMIT} times in a row: stop and report to the main agent; it settles the change (tells you what to change, takes it over with canon work take, or drops it) and runs canon work unstall ${change} --reason "<why>" to let it land again`;
}

/** The refusal of a stopped change's landing, before it queues (BR-2454); undefined when it may queue. */
export function stalled(db: CoordDb, actor: string, change: string | null): { message: string; refusals: number } | undefined {
  if (change === null || !isSubagent(actor)) return undefined;
  const rs = refusalsInARow(db, change);
  if (rs.length < STALL_LIMIT) return undefined;
  const list = rs.map((r) => `  ${r.ts} ${r.reason}`).join("\n");
  return { message: `${change} was refused ${rs.length} times in a row, so it does not queue:\n${list}\n${stallAdvice(change)}`, refusals: rs.length };
}

export type Unstall = { ok: true; refusals: number } | { ok: false; code: "invalid" | "refused" | "not_found"; message: string };

/** `canon work unstall` (BR-2455): the checks in the rule's order, then the `land.unstall` event that resets the count. */
export function unstall(db: CoordDb, actor: string, change: string, reason: string): Unstall {
  if (!/^C-\d+$/.test(change)) return { ok: false, code: "invalid", message: `the change must be C-<number>, got ${JSON.stringify(change)}` };
  const why = reason.trim();
  if (why === "") return { ok: false, code: "invalid", message: "--reason is required: say what the main agent did about the refusals" };
  if (isSubagent(actor)) return { ok: false, code: "refused", message: `${actor} is a subagent: only the main session or a person lets a stopped change land again (BR-2455)` };
  const any = db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE subject = ? AND kind LIKE 'land.%'").get(change)?.n ?? 0;
  if (any === 0) return { ok: false, code: "not_found", message: `${change} has no landing events` };
  const n = refusalsInARow(db, change).length;
  if (n < STALL_LIMIT) return { ok: false, code: "refused", message: `${change} has ${n} refusal(s) in a row and is not stopped: nothing to let go` };
  db.event(actor, "land.unstall", change, { reason: why, refusals: n });
  return { ok: true, refusals: n };
}
