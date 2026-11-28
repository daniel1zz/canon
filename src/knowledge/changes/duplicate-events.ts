import { err, ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../../work/workspace.ts";

/** The duplicate reminder's events (BR-2656 to BR-2659, D-171): `duplicate.remind` per reminded pair, `duplicate.answer` per answer. */

export const pairKey = (a: string, b: string) => [a, b].sort().join(" ");

export interface Reminded {
  readonly subject: string;
  readonly with: string;
  readonly stage: string;
}

export function reminders(ws: Workspace): Reminded[] {
  return ws.db.db
    .query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'duplicate.remind' AND subject IS NOT NULL ORDER BY id")
    .all()
    .flatMap((r) => {
      const d = JSON.parse(r.detail) as Record<string, unknown>;
      return typeof d["with"] === "string" && typeof d["stage"] === "string" ? [{ subject: r.subject, with: d["with"], stage: d["stage"] }] : [];
    });
}

export interface Answer {
  readonly same: boolean;
  readonly reason: string | null;
}

/** Each answered pair's latest answer, keyed by the unordered pair (BR-2658). */
export function latestAnswers(ws: Workspace): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (const r of ws.db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'duplicate.answer' AND subject IS NOT NULL ORDER BY id").all()) {
    const d = JSON.parse(r.detail) as Record<string, unknown>;
    if (typeof d["with"] !== "string" || typeof d["same"] !== "boolean") continue;
    out.set(pairKey(r.subject, d["with"]), { same: d["same"], reason: typeof d["reason"] === "string" ? d["reason"] : null });
  }
  return out;
}

/** Every reminded pair, unordered, with the stages it was reminded at (BR-2659). */
export function remindedPairs(ws: Workspace, range: { since?: number; until?: number } = {}): { a: string; b: string; stage: string }[] {
  const rows = ws.db.db
    .query<{ subject: string; detail: string }, [number, number]>("SELECT subject, detail FROM events WHERE kind = 'duplicate.remind' AND subject IS NOT NULL AND id > ? AND id <= ? ORDER BY id")
    .all(range.since ?? 0, range.until ?? Number.MAX_SAFE_INTEGER);
  const seen = new Set<string>();
  const out: { a: string; b: string; stage: string }[] = [];
  for (const r of rows) {
    const d = JSON.parse(r.detail) as Record<string, unknown>;
    if (typeof d["with"] !== "string" || typeof d["stage"] !== "string") continue;
    const [a, b] = [r.subject, d["with"]].sort() as [string, string];
    const key = `${d["stage"]} ${a} ${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, stage: d["stage"] });
  }
  return out;
}

/**
 * The change ids `overlap` holds for (BR-2571, BR-2658): one side of a reminded pair whose other side is unfinished too
 * and which has no answer. `open` says whether a change id is listed and not closed.
 */
export function overlapping(ws: Workspace, open: (id: string) => boolean): Set<string> {
  const answered = latestAnswers(ws);
  const out = new Set<string>();
  for (const r of reminders(ws)) {
    if (answered.has(pairKey(r.subject, r.with)) || !open(r.subject) || !open(r.with)) continue;
    out.add(r.subject);
    out.add(r.with);
  }
  return out;
}

/** Records the session's answer to a reminded pair (BR-2658). */
export function recordAnswer(ws: Workspace, a: string, b: string, answer: Answer): Result<string> {
  if (!reminders(ws).some((r) => pairKey(r.subject, r.with) === pairKey(a, b))) return err("not_found", `${a} and ${b} were never reminded as possible duplicates; nothing was recorded`);
  ws.db.event(ws.actor, "duplicate.answer", a, { with: b, same: answer.same, reason: answer.reason });
  return ok(answer.same ? `${a} and ${b}: recorded "same work"` : `${a} and ${b}: recorded "not the same work: ${answer.reason}"`);
}
