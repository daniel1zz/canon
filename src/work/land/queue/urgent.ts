import type { CoordDb } from "../../db.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";

/**
 * The owner's priority for a change, kept in the coordination DB so it takes effect at the next turn instead of
 * waiting in the queue it reorders (BR-2375, D-69). Trust is the same as for any relayed human word (D-6): the words
 * are kept for the record, not checked.
 */
export interface Mark {
  readonly change: string;
  readonly words: string;
  readonly actor: string;
  readonly at: string;
}

export function marks(db: CoordDb): Mark[] {
  return db.db.query<Mark, []>("SELECT change, words, actor, at FROM urgent ORDER BY at, change").all();
}

/** Marks `change` urgent; fails loud without the owner's words. Marking again replaces the words. */
export function mark(db: CoordDb, actor: string, change: string, words: string | undefined): Result<void> {
  if (words === undefined || words.trim() === "") {
    db.event(actor, "urgent.refuse", change, { reason: "no-relayed" });
    return err("invalid", "--relayed \"<the owner's own words>\" is required: use this command only when the owner asked for this priority in the conversation");
  }
  db.db.query("INSERT INTO urgent(change, words, actor, at) VALUES (?, ?, ?, ?) ON CONFLICT(change) DO UPDATE SET words = excluded.words, actor = excluded.actor, at = excluded.at").run(change, words, actor, new Date().toISOString());
  db.event(actor, "urgent.set", change, { relayed: words });
  return ok(undefined);
}

/** Removes the mark; not found when there is none. */
export function clear(db: CoordDb, actor: string, change: string, words: string | undefined): Result<void> {
  if (words === undefined || words.trim() === "") {
    db.event(actor, "urgent.refuse", change, { reason: "no-relayed" });
    return err("invalid", "--relayed \"<the owner's own words>\" is required: use this command only when the owner asked for this in the conversation");
  }
  if (db.db.query("DELETE FROM urgent WHERE change = ?").run(change).changes === 0) {
    db.event(actor, "urgent.refuse", change, { reason: "not-marked" });
    return err("not_found", `${change} is not marked urgent`);
  }
  db.event(actor, "urgent.clear", change, { relayed: words });
  return ok(undefined);
}
