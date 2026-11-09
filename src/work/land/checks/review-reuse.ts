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

/** What the changed documents of a landing are, for the documents key (BR-2396): every text the review judges, by path. */
export interface ReviewedTexts {
  /** Changed or added documents and changed domain READMEs: path and full text. */
  readonly live: readonly { readonly path: string; readonly text: string }[];
  /** Deleted documents and READMEs: path and the text they had on main. */
  readonly deleted: readonly { readonly path: string; readonly text: string }[];
  /** The diff this landing makes to the architecture overview, empty when none. */
  readonly architectureDiff: string;
}

/**
 * The key of the changed documents (BR-2396, D-81): SHA-256 over the review command and every reviewed text with its
 * path, sorted by path. Unlike the prompt key it does not change when other documents land on main.
 */
export function docsKey(command: string, t: ReviewedTexts): string {
  const h = createHash("sha256");
  const parts = [command, ...[...t.live].sort((a, b) => a.path.localeCompare(b.path)).flatMap((d) => ["live", d.path, d.text]), ...[...t.deleted].sort((a, b) => a.path.localeCompare(b.path)).flatMap((d) => ["deleted", d.path, d.text]), "architecture", t.architectureDiff];
  // reason: length-prefixed parts, like the prompt key (BR-2361)
  for (const part of parts) h.update(`${Buffer.byteLength(part)}:`).update(part).update("\n");
  return h.digest("hex");
}

/** A passed landing review of the same changed documents, with the main it was made against (BR-2396). */
export interface PassedDocs extends PassedReview {
  readonly base: string;
}

/**
 * The newest landing rule review of `subject` whose documents key is `key`, when it passed and recorded its main: the
 * newest of `review.ok` and `review.block`, so a later block wins (BR-2396, like BR-2361).
 */
export function passedDocs(db: CoordDb, subject: string | null, key: string): PassedDocs | undefined {
  if (subject === null) return undefined;
  const row = db.db
    .query<{ id: number; kind: string; detail: string }, [string, string]>("SELECT id, kind, detail FROM events WHERE kind IN ('review.ok', 'review.block') AND subject = ? AND json_extract(detail, '$.docs_hash') = ? ORDER BY id DESC LIMIT 1")
    .get(subject, key);
  if (!row || row.kind !== "review.ok") return undefined;
  const d = JSON.parse(row.detail) as { findings?: unknown; wording?: unknown; base?: unknown };
  if (typeof d.base !== "string" || d.base === "") return undefined;
  const wording = d.wording !== null && typeof d.wording === "object" && !Array.isArray(d.wording) ? (d.wording as Record<string, string>) : undefined;
  return { event: row.id, findings: Array.isArray(d.findings) ? d.findings.map(String) : [], wording, base: d.base };
}
