import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../db.ts";
import { closeSubject } from "./finish/finish.ts";

/**
 * A landing that would be refused again for the same reason, known before it queues (BR-2388, #154): its last landing
 * was refused for a reason only its own content and main decide, and neither has changed since.
 */

/** Refusals decided by the change's content on a given main alone: running them again on the same trees refuses again. */
export const CONTENT_REASONS: readonly string[] = ["check", "source", "release", "review"];

/** What a refusal records to be compared later: the tree of the change's own content and the main it was rebased onto. */
export interface RefusedAt {
  readonly tree: string;
  readonly main: string;
}

/** The tree of the branch's content without its close commit, as `reopen` leaves the branch after a refusal (BR-2018). */
export function contentTree(wt: string, subject: string | null): string | undefined {
  const top = git(wt, "log", "-1", "--format=%s");
  const closing = top.ok && subject !== null && top.value === closeSubject(subject);
  const tree = git(wt, "rev-parse", closing ? "HEAD~1^{tree}" : "HEAD^{tree}");
  return tree.ok ? tree.value : undefined;
}

export interface Repeat {
  readonly event: number;
  readonly at: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * The refusal this landing would repeat, or undefined: the change's latest landing event is a refusal for a content
 * reason that recorded the same content tree and the same main as now. Any later landing event (a landing, a kill,
 * another refusal) or a refusal that recorded no tree means it is not known, and the landing queues.
 */
export function repeatedRefusal(db: CoordDb, subject: string | null, now: RefusedAt): Repeat | undefined {
  if (subject === null) return undefined;
  const last = db.db
    .query<{ id: number; at: string; kind: string; detail: string }, [string]>("SELECT id, ts AS at, kind, detail FROM events WHERE subject = ? AND kind IN ('land.ok', 'land.refuse', 'land.killed', 'land.lost', 'land.interrupt') ORDER BY id DESC LIMIT 1")
    .get(subject);
  if (!last || last.kind !== "land.refuse") return undefined;
  const d = JSON.parse(last.detail) as { reason?: string; message?: string; tree?: string; main?: string; repeat_of?: number };
  if (!d.reason || !CONTENT_REASONS.includes(d.reason)) return undefined;
  if (d.tree !== now.tree || d.main !== now.main) return undefined;
  // reason: a repeat names the refusal it repeats, so a run of repeats all point to the first one (BR-2388)
  if (d.repeat_of !== undefined) {
    const first = db.db.query<{ at: string }, [number]>("SELECT ts AS at FROM events WHERE id = ?").get(d.repeat_of);
    return { event: d.repeat_of, at: first?.at ?? last.at, reason: d.reason, message: d.message ?? "" };
  }
  return { event: last.id, at: last.at, reason: d.reason, message: d.message ?? "" };
}
