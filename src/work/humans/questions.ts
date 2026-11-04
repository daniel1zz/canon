import { currentActor } from "../workspace.ts";
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
  /** For a relayed answer: how the words compare with the session's question-tool records of this question (BR-2276); null when not checked. */
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
 * The write is atomic: two answers racing for one question cannot both succeed (BR-2040). A relay is compared with the
 * question tool's records of the relaying session (`ctx`, BR-2276); the comparison never refuses.
 */
export function answer(db: CoordDb, id: number, text: string, by: string, relayed: string | undefined, tty: boolean, ctx: WitnessContext): Result<void> {
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
    const q = db.db.query<{ answer: string | null; question: string }, [number]>("SELECT answer, question FROM questions WHERE id = ?").get(id);
    if (!q) return err("not_found", `no question #${id}`);
    const witness = quote ? witnessFor(db, q.question, quote, ctx) : null;
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

// ---- what Claude Code's question tool recorded (BR-2275, BR-2276, BR-2289, D-45, D-47) ----

/**
 * How a relayed answer compares with the question tool's records of the relaying session (BR-2276, D-47), in the
 * order it is decided. `none` is the single mark D-45 stored before the marks were split; it is only ever read back.
 */
export type Witness = "match" | "differs" | "record-failed" | "unasked" | "no-hook" | "no-record" | "no-session" | "none";

const MARKS: Record<Witness, string> = {
  match: " [the human's words match Claude Code's record]",
  differs: " [the human's words differ from Claude Code's record of this question]",
  "record-failed": " [Claude Code's record failed in this session]",
  unasked: " [this question is not in Claude Code's records of this session]",
  "no-hook": " [no Claude Code record: the record hook is not installed]",
  "no-record": " [no Claude Code record in this session]",
  "no-session": " [no Claude Code session to check against]",
  none: " [no matching Claude Code record]",
};

/** The mark `canon human pending --all` prints after a relayed answer (BR-2289); nothing for an answer that was not checked. */
export function witnessMark(q: Pick<Question, "witness">): string {
  return q.witness ? (MARKS[q.witness] ?? "") : "";
}

/** One question of a question-tool call: its text, what the human chose or wrote for it, and the note on it. */
export interface AskedQuestion {
  readonly question: string;
  readonly answer: string | null;
  readonly note: string | null;
}

/** What `human.asked` keeps from one AskUserQuestion call (BR-2275). */
export interface AskedRecord {
  readonly session: string;
  readonly tool_use_id: string | null;
  readonly transcript_path: string | null;
  readonly questions: readonly AskedQuestion[];
  readonly response: string | null;
  readonly afk_timeout_ms: number | null;
}

/** Why `canon human record` recorded nothing (BR-2275), written as `human.asked.refuse` with the session when it is known. */
export type RecordRefusal = "invalid-json" | "not-object" | "not-question-tool" | "no-session" | "malformed";

export interface RecordFailure {
  readonly reason: RecordRefusal;
  readonly session: string | null;
  readonly message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (v: unknown): v is string | undefined | null => v === undefined || v === null || typeof v === "string";

/**
 * Reads Claude Code's PostToolUse data for AskUserQuestion (BR-2275). The fields are those of AskUserQuestionOutput:
 * `questions` lists the questions, `answers` maps a question's text to the chosen label (labels joined by commas for
 * multi-select), `response` is a freeform reply and `annotations[q].notes` a note. Anything else is invalid: nothing is
 * recorded from a guess. On failure the session is returned when the data names one, so the refusal can be tied to it.
 */
export function parseAsked(input: string): { ok: true; record: AskedRecord } | { ok: false; failure: RecordFailure } {
  const fail = (reason: RecordRefusal, session: string | null, message: string) => ({ ok: false as const, failure: { reason, session, message } });
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch (e) {
    return fail("invalid-json", null, `canon human record reads Claude Code's PostToolUse data as JSON on stdin; got invalid JSON (${(e as Error).message})`);
  }
  if (!isObject(data)) return fail("not-object", null, "canon human record: the PostToolUse data must be a JSON object");
  const session = typeof data["session_id"] === "string" && data["session_id"].trim() ? data["session_id"].trim() : null;
  if (data["tool_name"] !== "AskUserQuestion") return fail("not-question-tool", session, `canon human record records only AskUserQuestion; got tool_name ${JSON.stringify(data["tool_name"])}`);
  if (!session) return fail("no-session", null, "canon human record: the PostToolUse data has no session_id");
  const bad = (what: string) => fail("malformed", session, `canon human record: ${what}; nothing recorded`);
  const out = data["tool_response"];
  if (!isObject(out) || !isObject(out["answers"])) return bad("tool_response.answers is missing");
  const asked = out["questions"];
  if (!Array.isArray(asked) || !asked.every((q) => isObject(q) && typeof q["question"] === "string")) return bad("tool_response.questions is not a list of questions with their text");
  const answers = new Map<string, string>();
  for (const [question, answer] of Object.entries(out["answers"])) {
    // reason: an Agent SDK app may hand multi-select labels back as an array; the tool joins them with ", " (BR-2275, D-47)
    if (Array.isArray(answer) && answer.every((a) => typeof a === "string")) answers.set(question, answer.join(", "));
    else if (typeof answer === "string") answers.set(question, answer);
    else return bad(`the answer to ${JSON.stringify(question)} is not a string`);
  }
  const notes = new Map<string, string>();
  const annotations = isObject(out["annotations"]) ? out["annotations"] : {};
  for (const [question, a] of Object.entries(annotations)) {
    if (!isObject(a) || a["notes"] === undefined) continue;
    if (typeof a["notes"] !== "string") return bad("a note in tool_response.annotations is not a string");
    notes.set(question, a["notes"]);
  }
  const toolUse = data["tool_use_id"];
  if (!optString(toolUse)) return bad("tool_use_id is not a string");
  const transcript = data["transcript_path"];
  if (!optString(transcript)) return bad("transcript_path is not a string");
  const response = out["response"];
  if (!optString(response)) return bad("tool_response.response is not a string");
  const afk = out["afkTimeoutMs"];
  if (afk !== undefined && afk !== null && typeof afk !== "number") return bad("tool_response.afkTimeoutMs is not a number");
  const texts = [...asked.map((q) => (q as { question: string }).question)];
  for (const q of answers.keys()) if (!texts.includes(q)) texts.push(q);
  const questions = texts.map((question) => ({ question, answer: answers.get(question) ?? null, note: notes.get(question) ?? null }));
  return {
    ok: true,
    record: { session, tool_use_id: toolUse ?? null, transcript_path: transcript ?? null, questions, response: response ?? null, afk_timeout_ms: afk ?? null },
  };
}

/**
 * Who `canon human record` writes as (BR-2275): BR-2023's order with the session id taken from the data, so the hook's
 * record carries the same actor as the session's own commands; without a session in the data, BR-2023 as it stands.
 */
export function recordActor(session: string | null, env: Record<string, string | undefined> = process.env): Result<string> {
  // reason: CLAUDECODE is not consulted when the data names a session: it comes from Claude Code's hook, so an agent wrote it (BR-2275)
  if (env["CANON_ACTOR"]?.trim() || !session) return currentActor(env);
  return ok(`agent:${session.slice(0, 8)}`);
}

/** Writes one `human.asked` event: what the human answered in Claude Code's question tool (BR-2275). */
export function recordAsked(db: CoordDb, actor: string, record: AskedRecord): void {
  db.event(actor, "human.asked", null, { ...record });
}

/** Writes why a question-tool record was not kept, tied to its session when the data named one (BR-2275, BR-2026). */
export function refuseRecord(db: CoordDb, actor: string, failure: RecordFailure): void {
  db.event(actor, "human.asked.refuse", null, { reason: failure.reason, session: failure.session });
}

/** A record as stored: D-47's `questions`, or D-45's `answers` whose unattributed notes are left out (BR-2276). */
function storedQuestions(detail: string): { questions: AskedQuestion[]; response: string | null } {
  const r = JSON.parse(detail) as { questions?: AskedQuestion[]; answers?: { question: string; answer: string }[]; response?: string | null };
  const questions = r.questions ?? (r.answers ?? []).map((a) => ({ question: a.question, answer: a.answer, note: null }));
  return { questions, response: r.response ?? null };
}

/** What the relay needs to know beyond the question tool's records: the relaying session and whether the record hook is installed. */
export interface WitnessContext {
  readonly session: string | null;
  readonly hookInstalled: () => boolean;
}

/**
 * How `quote`, relayed as the answer to question `text`, compares with the records of the relaying session (BR-2276,
 * D-47): the first mark in BR-2276's order that holds. A record counts only for the same question, so a short option
 * label answered to some other question never makes a match.
 */
export function witnessFor(db: CoordDb, text: string, quote: string, ctx: WitnessContext): Witness {
  if (!ctx.session) return "no-session";
  const rows = db.db
    .query<{ kind: string; detail: string }, [string]>("SELECT kind, detail FROM events WHERE kind IN ('human.asked', 'human.asked.refuse') AND json_extract(detail, '$.session') = ? ORDER BY id DESC")
    .all(ctx.session);
  const asked = text.trim();
  for (const row of rows) {
    if (row.kind !== "human.asked") continue;
    const r = storedQuestions(row.detail);
    const q = r.questions.find((x) => x.question.trim() === asked);
    if (!q) continue;
    // reason: the freeform reply answers the whole call, not one question, so it counts only when the call asked just this one (BR-2276, D-47)
    const said = [q.answer, q.note, r.questions.length === 1 ? r.response : null].filter((s): s is string => typeof s === "string").map((s) => s.trim());
    return said.includes(quote) ? "match" : "differs";
  }
  if (rows.some((r) => r.kind === "human.asked.refuse")) return "record-failed";
  if (rows.length > 0) return "unasked";
  return ctx.hookInstalled() ? "no-record" : "no-hook";
}
