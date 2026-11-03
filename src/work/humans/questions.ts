import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../db.ts";

/**
 * Live coordination operations (design §2). Each is one transaction on the shared DB, so two sessions
 * racing for the same claim or queue slot see a consistent answer (P4).
 */

const now = () => new Date();
const iso = (d: Date) => d.toISOString();

// ---- questions reserved for a human (P7) ----

export interface Question {
  readonly id: number;
  readonly subject: string | null;
  readonly asked_by: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string | null;
  readonly answered_by: string | null;
  /** The human's own words when an agent relayed the answer (BR-2021); null for a direct answer. */
  readonly relayed: string | null;
  readonly asked_at: string;
}

export function ask(db: CoordDb, actor: string, subject: string | null, question: string, options: readonly string[]): number {
  const r = db.db.query("INSERT INTO questions(subject, asked_by, question, options, asked_at) VALUES (?, ?, ?, ?, ?)").run(subject, actor, question, JSON.stringify(options), iso(now()));
  db.event(actor, "human.ask", subject, { question });
  return Number(r.lastInsertRowid);
}

export function questions(db: CoordDb, which: "pending" | "all"): Question[] {
  const rows = db.db
    .query<Omit<Question, "options"> & { options: string }, []>(`SELECT id, subject, asked_by, question, options, answer, answered_by, relayed, asked_at FROM questions ${which === "pending" ? "WHERE answer IS NULL" : ""} ORDER BY id`)
    .all();
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options) as string[] }));
}

/**
 * Records the answer to a question reserved for a human (BR-2021, D-6). A `human:` actor answers directly.
 * An agent may record an answer only as a relay of what the human said in its session, with the human's own
 * words: canon cannot tell a relay from an invention (an agent can also fake its identity through the
 * environment), so it does not pretend to prevent one; it records which kind of answer this is, so the record
 * never says "the human answered" when an agent wrote it.
 *
 * The write is atomic: two answers racing for one question cannot both succeed (BR-2040).
 */
export function answer(db: CoordDb, id: number, text: string, by: string, relayed?: string): Result<void> {
  const quote = relayed?.trim();
  if (!by.startsWith("human:") && !quote) {
    db.event(by, "human.answer.refuse", String(id), { reason: "not-human-no-relay" });
    return err("invalid", `${by} is not a human; an agent records a human's answer only with --relayed "<the human's own words>" (BR-2021)`);
  }
  if (by.startsWith("human:") && quote) return err("invalid", "--relayed is for an agent passing on a human's answer; a human answers directly");
  const tx = db.db.transaction((): Result<void> => {
    const q = db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(id);
    if (!q) return err("not_found", `no question #${id}`);
    const r = db.db.query("UPDATE questions SET answer = ?, answered_by = ?, relayed = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(text, by, quote ?? null, iso(now()), id);
    if (r.changes === 0) return err("conflict", `question #${id} is already answered`);
    db.event(by, "human.answer", String(id), { answer: text, ...(quote ? { relayed: quote } : {}) });
    return ok(undefined);
  });
  return tx.immediate();
}

/** Who answered, in words: the human, or an agent relaying the human's own words. */
export function answeredBy(q: Pick<Question, "answered_by" | "relayed">): string {
  return q.relayed ? `${q.answered_by} relaying the human: "${q.relayed}"` : (q.answered_by ?? "");
}
