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
  /** For a relayed answer: whether the words matched the session's latest question-tool record (BR-2276); null before it was checked. */
  readonly witness: Witness | null;
  readonly asked_at: string;
}

export function ask(db: CoordDb, actor: string, subject: string | null, question: string, options: readonly string[]): number {
  const r = db.db.query("INSERT INTO questions(subject, asked_by, question, options, asked_at) VALUES (?, ?, ?, ?, ?)").run(subject, actor, question, JSON.stringify(options), iso(now()));
  db.event(actor, "human.ask", subject, { question });
  return Number(r.lastInsertRowid);
}

export function questions(db: CoordDb, which: "pending" | "all"): Question[] {
  const rows = db.db
    .query<Omit<Question, "options"> & { options: string }, []>(`SELECT id, subject, asked_by, question, options, answer, answered_by, relayed, witness, asked_at FROM questions ${which === "pending" ? "WHERE answer IS NULL" : ""} ORDER BY id`)
    .all();
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options) as string[] }));
}

/**
 * Records the answer to a question reserved for a human (BR-2021, D-6). A `human:` actor answers directly, at a
 * terminal. An agent may record an answer only as a relay of what the human said in its session, with the human's
 * own words: canon cannot tell a relay from an invention (an agent can also fake its identity through the
 * environment), so it does not pretend to prevent one; it records which kind of answer this is, so the record
 * never says "the human answered" when an agent wrote it.
 *
 * Every refusal is decided here and written as a `human.answer.refuse` event with its own reason (BR-2026): the
 * command passes whether stdin is a terminal instead of refusing before this runs (issue #57). `relayed` is
 * undefined only when `--relayed` was not given: an empty `--relayed ""` from a human is still a relay flag, not a
 * direct answer (issue #56).
 *
 * The write is atomic: two answers racing for one question cannot both succeed (BR-2040).
 */
export function answer(db: CoordDb, id: number, text: string, by: string, relayed: string | undefined, tty: boolean): Result<void> {
  const quote = relayed?.trim();
  const refuse = (reason: string, code: "invalid" | "not_found" | "conflict", message: string): Result<void> => {
    db.event(by, "human.answer.refuse", String(id), { reason });
    return err(code, message);
  };
  if (by.startsWith("human:")) {
    if (relayed !== undefined) return refuse("human-relayed", "invalid", "--relayed is for an agent passing on a human's answer; a human answers directly, at a terminal");
    if (!tty) return refuse("no-tty", "invalid", 'answer at a terminal, or as an agent relay the human\'s words with --relayed "<what they said>"');
  } else if (!quote) {
    return refuse("not-human-no-relay", "invalid", `${by} is not a human; an agent records a human's answer only with --relayed "<the human's own words>" (BR-2021)`);
  }
  const tx = db.db.transaction((): Result<void> => {
    const q = db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(id);
    if (!q) return err("not_found", `no question #${id}`);
    const witness = quote ? witnessFor(db, by, quote) : null;
    const r = db.db.query("UPDATE questions SET answer = ?, answered_by = ?, relayed = ?, witness = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(text, by, quote || null, witness, iso(now()), id);
    if (r.changes === 0) return err("conflict", `question #${id} is already answered`);
    db.event(by, "human.answer", String(id), { answer: text, ...(quote ? { relayed: quote, witness } : {}) });
    return ok(undefined);
  });
  const done = tx.immediate();
  if (!done.ok) return refuse(done.error.code === "not_found" ? "not-found" : "answered", done.error.code === "not_found" ? "not_found" : "conflict", done.error.message);
  return done;
}

/** Who answered, in words: the human, or an agent relaying the human's own words. */
export function answeredBy(q: Pick<Question, "answered_by" | "relayed">): string {
  return q.relayed ? `${q.answered_by} relaying the human: "${q.relayed}"` : (q.answered_by ?? "");
}

// ---- what Claude Code's question tool recorded (BR-2275, BR-2276, D-45) ----

/** match: the relayed words are one of the answers in the session's latest record; none: no record, or none of its answers. */
export type Witness = "match" | "none";

/** The mark `canon human pending --all` prints after a relayed answer; nothing for an answer recorded before the check existed. */
export function witnessMark(q: Pick<Question, "witness">): string {
  return q.witness === "match" ? " [matches Claude Code's record]" : q.witness === "none" ? " [no matching Claude Code record]" : "";
}

/** One answer from the question tool: the question's text and what the human chose or wrote for it. */
export interface Asked {
  readonly question: string;
  readonly answer: string;
}

/** What `human.asked` keeps from one AskUserQuestion call: the answers, the human's freeform reply and notes. */
export interface AskedRecord {
  readonly session: string;
  readonly tool_use_id: string | null;
  readonly answers: readonly Asked[];
  readonly response: string | null;
  readonly notes: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads Claude Code's PostToolUse data for AskUserQuestion (BR-2275). The fields are those of the tool's output type:
 * `answers` maps each question's text to the chosen label (labels joined by commas for multi-select), `response` is a
 * freeform reply and `annotations[q].notes` a note. Anything else is invalid: nothing is recorded from a guess.
 */
export function parseAsked(input: string): Result<{ actor: string; record: AskedRecord }> {
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch (e) {
    return err("invalid", `canon human record reads Claude Code's PostToolUse data as JSON on stdin; got invalid JSON (${(e as Error).message})`);
  }
  if (!isObject(data)) return err("invalid", "canon human record: the PostToolUse data must be a JSON object");
  if (data["tool_name"] !== "AskUserQuestion") return err("invalid", `canon human record records only AskUserQuestion; got tool_name ${JSON.stringify(data["tool_name"])}`);
  const session = typeof data["session_id"] === "string" ? data["session_id"].trim() : "";
  if (!session) return err("invalid", "canon human record: the PostToolUse data has no session_id");
  const out = data["tool_response"];
  if (!isObject(out) || !isObject(out["answers"])) return err("invalid", "canon human record: tool_response.answers is missing; nothing to record");
  const answers: Asked[] = [];
  for (const [question, answer] of Object.entries(out["answers"])) {
    if (typeof answer !== "string") return err("invalid", `canon human record: the answer to ${JSON.stringify(question)} is not a string`);
    answers.push({ question, answer });
  }
  const response = typeof out["response"] === "string" ? out["response"] : null;
  const notes = isObject(out["annotations"])
    ? Object.values(out["annotations"]).flatMap((a) => (isObject(a) && typeof a["notes"] === "string" ? [a["notes"]] : []))
    : [];
  const tool_use_id = typeof data["tool_use_id"] === "string" ? data["tool_use_id"] : null;
  // reason: the same form currentActor gives a Claude Code session, so the relay from that session finds this record (BR-2023, D-18)
  return ok({ actor: `agent:${session.slice(0, 8)}`, record: { session, tool_use_id, answers, response, notes } });
}

/** Writes one `human.asked` event: what the human answered in Claude Code's question tool (BR-2275). */
export function recordAsked(db: CoordDb, actor: string, record: AskedRecord): void {
  db.event(actor, "human.asked", null, { ...record });
}

/**
 * Whether `quote` is, after trimming, exactly one of the answers, the freeform reply or a note in the latest
 * `human.asked` of `actor` (BR-2276). Only the latest: looking further back makes a chance match likelier.
 */
function witnessFor(db: CoordDb, actor: string, quote: string): Witness {
  const row = db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'human.asked' AND actor = ? ORDER BY id DESC LIMIT 1").get(actor);
  if (!row) return "none";
  const r = JSON.parse(row.detail) as Partial<AskedRecord>;
  const said = [...(r.answers ?? []).map((a) => a.answer), ...(r.response ? [r.response] : []), ...(r.notes ?? [])].map((s) => s.trim());
  return said.includes(quote) ? "match" : "none";
}
