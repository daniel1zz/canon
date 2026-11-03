import type { CoordDb } from "../../work/db.ts";

/**
 * Rule-review notes: what a review said without blocking. They are not work of their own (D-21); a note stays
 * open on a rule or decision until a later landing reviews that document again, and is shown to whoever is
 * about to change it (BR-2145). Stored only in the `land.ok` event of the landing that got them, so nothing grows
 * but the event table.
 */
export interface OpenNote {
  readonly doc: string;
  readonly note: string;
  /** The change whose landing got the note, when the landing had one. */
  readonly change: string | null;
  readonly ts: string;
}

/** Whether `text` names `id` as a whole id: BR-20 is not named by "BR-201". */
export function names(text: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9-])${esc}(?![0-9])`).test(text);
}

/**
 * The notes of one landing, by document: a note goes to each reviewed document it names; a note that names none
 * of them goes to every reviewed document, so no note is lost.
 */
export function notesByDoc(reviewed: readonly string[], notes: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(reviewed.map((id) => [id, []]));
  for (const n of notes) {
    const named = reviewed.filter((id) => names(n, id));
    for (const id of named.length > 0 ? named : reviewed) out.get(id)!.push(n);
  }
  return out;
}

/**
 * The open notes on each of `ids`: those from the latest successful landing whose review covered the document.
 * A later review of the same document replaces them, with whatever it said (often nothing).
 */
export function openNotes(db: CoordDb, ids: Iterable<string>): OpenNote[] {
  const want = new Set(ids);
  const out: OpenNote[] = [];
  if (want.size === 0) return out;
  const rows = db.db
    .query<{ ts: string; subject: string | null; detail: string }, []>("SELECT ts, subject, detail FROM events WHERE kind = 'land.ok' AND detail LIKE '%\"reviewed\"%' ORDER BY id DESC")
    .all();
  for (const r of rows) {
    if (want.size === 0) break;
    let d: { reviewed?: unknown; notes?: unknown };
    try {
      d = JSON.parse(r.detail) as typeof d;
    } catch {
      continue;
    }
    if (!Array.isArray(d.reviewed)) continue;
    const reviewed = d.reviewed.map(String);
    const by = notesByDoc(reviewed, Array.isArray(d.notes) ? d.notes.map(String) : []);
    for (const id of reviewed) {
      if (!want.has(id)) continue;
      want.delete(id);
      for (const note of by.get(id) ?? []) out.push({ doc: id, note, change: r.subject, ts: r.ts });
    }
  }
  return out;
}

/** One line per open note, as `canon context` and `canon brief` print them. */
export function renderNote(n: OpenNote): string {
  return `${n.doc}: ${n.note} (${n.change ? `${n.change}, ` : ""}${n.ts.slice(0, 10)})`;
}
