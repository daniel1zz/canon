import { createHash } from "node:crypto";
import type { ReviewKind } from "../../../knowledge/review/review.ts";
import type { CoordDb } from "../../db.ts";

/**
 * The key of one rule review (BR-2361, D-70): a SHA-256 over the kind of review (the landing's or `canon work review`'s), the review command, the prompt budget in bytes and every prompt
 * the review would send, in order. Anything the model would read, or the way it is asked and split, changes the key.
 */
export function reviewKey(kind: ReviewKind, command: string, budgetBytes: number, prompts: readonly string[]): string {
  // reason: length-prefixed parts, so no two different (command, budget, prompts) can give the same byte stream (BR-2361)
  const h = createHash("sha256");
  for (const part of [kind, command, String(budgetBytes), ...prompts]) h.update(`${Buffer.byteLength(part)}:`).update(part).update("\n");
  return h.digest("hex");
}

/** What a passed review recorded, for the landing that reuses it. */
export interface PassedReview {
  /** The `review.ok` event it comes from. */
  readonly event: number;
  readonly findings: readonly string[];
  readonly wording: Readonly<Record<string, string>> | undefined;
}

/**
 * The newest rule review of this kind with this key, when it passed: for a landing the newest of the `review.ok` and
 * `review.block` events, for a preview the newest `review.preview` event (its rule review's verdict). A later block of the
 * same prompts wins over an earlier pass, so a block is never stepped around by retrying; the other kind's events and
 * `review.reused` events are never looked at (BR-2361).
 */
export function passedReview(db: CoordDb, kind: ReviewKind, hash: string): PassedReview | undefined {
  const where = kind === "land" ? "kind IN ('review.ok', 'review.block')" : "kind = 'review.preview'";
  const row = db.db.query<{ id: number; kind: string; detail: string }, [string]>(`SELECT id, kind, detail FROM events WHERE ${where} AND json_extract(detail, '$.hash') = ? ORDER BY id DESC LIMIT 1`).get(hash);
  if (!row) return undefined;
  const d = JSON.parse(row.detail) as { findings?: unknown; ruleFindings?: unknown; rule?: unknown; wording?: unknown };
  if (kind === "land" ? row.kind !== "review.ok" : d.rule !== "ok") return undefined;
  const found = kind === "land" ? d.findings : d.ruleFindings;
  const wording = d.wording !== null && typeof d.wording === "object" && !Array.isArray(d.wording) ? (d.wording as Record<string, string>) : undefined;
  return { event: row.id, findings: Array.isArray(found) ? found.map(String) : [], wording };
}
