import { createHash } from "node:crypto";
import type { CoordDb } from "../../db.ts";

/**
 * The key of one rule review (BR-2361, D-70): a SHA-256 over the kind of review (the landing's or `canon work review`'s), the review command, the prompt budget in bytes and every prompt
 * the review would send, in order. Anything the model would read, or the way it is asked and split, changes the key.
 */
export type ReviewKind = "land" | "preview";

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
 * The newest passing rule review of this kind with this key, or undefined: for a landing a `review.ok` event, for a preview a
 * `review.preview` event whose rule review passed. A block, the other kind's pass or a `review.reused` event never is (BR-2361).
 */
export function passedReview(db: CoordDb, kind: ReviewKind, hash: string): PassedReview | undefined {
  const where = kind === "land" ? "kind = 'review.ok'" : "kind = 'review.preview' AND json_extract(detail, '$.rule') = 'ok'";
  const row = db.db.query<{ id: number; detail: string }, [string]>(`SELECT id, detail FROM events WHERE ${where} AND json_extract(detail, '$.hash') = ? ORDER BY id DESC LIMIT 1`).get(hash);
  if (!row) return undefined;
  const d = JSON.parse(row.detail) as { findings?: unknown; ruleFindings?: unknown; wording?: unknown };
  const found = kind === "land" ? d.findings : d.ruleFindings;
  const wording = d.wording !== null && typeof d.wording === "object" && !Array.isArray(d.wording) ? (d.wording as Record<string, string>) : undefined;
  return { event: row.id, findings: Array.isArray(found) ? found.map(String) : [], wording };
}
