import { isOwnersAnswer } from "../../knowledge/releases/gate.ts";
import type { CoordDb } from "../db.ts";
import { isWorker } from "../delegation/worker.ts";

/**
 * Whether the owner approved a change that carries `owner_gate` (BR-2616, D-158): the most recently answered question
 * `approve C-n: <owner_gate>?` with the change's current gate text decides, like the ship gate (BR-2331); a later no
 * revokes an earlier yes, and an answer about another gate text (the text changed since) does not count (#296).
 */

/** The text a question must contain to be about approving `id`: `approve C-9`, whole (C-9 does not match C-90). */
export const approveQuestion = (id: string): RegExp => new RegExp(`\\bapprove ${id}(?![0-9])`, "i");

/** The gate text an approve question for `id` asks about: what follows `approve C-n:` without the closing question mark. */
export function askedGate(id: string, question: string): string | undefined {
  const m = new RegExp(`\\bapprove ${id}(?![0-9])\\s*[:：]\\s*([\\s\\S]*?)\\s*[?？]?\\s*$`, "i").exec(question);
  return m?.[1];
}

/** The words that approve, once surrounding blanks and closing punctuation are gone (BR-2616). */
const APPROVE = /^(批准|同意|可以|是|yes)$/i;
const said = (text: string): string => text.trim().replace(/[。.!！,，;；]+$/u, "").trim();

interface Row { readonly id: number; readonly answer: string | null; readonly answered_by: string | null; readonly relayed: string | null; readonly witness: string | null }

export interface Approval {
  readonly approved: boolean;
  /** The latest answered approve question about the current text, if any. */
  readonly latest?: { readonly id: number; readonly answer: string; readonly owners: boolean };
  /** An approve question about the current gate text still waiting for its answer, if any. */
  readonly pending?: number;
  /** With no answered question about the current text: the latest answered one about another text (the gate changed), and whether it is the owner's approval. */
  readonly stale?: { readonly id: number; readonly gate: string; readonly approved: boolean };
  /** Approved by the main session keeping an earlier approval for the current text (BR-2626). */
  readonly kept?: { readonly question: number; readonly from: string; readonly reason: string };
}

type QRow = Row & { question: string };
const approveRows = (db: CoordDb, id: string): QRow[] =>
  db.db.query<QRow, []>("SELECT id, question, answer, answered_by, relayed, witness FROM questions ORDER BY answered_at DESC, id DESC").all().filter((r) => approveQuestion(id).test(r.question));
const isYes = (r: Row): boolean => APPROVE.test(said(r.answer!)) && (r.relayed === null || APPROVE.test(said(r.relayed)));

/** Only the questions about `gate` decide: the latest answered one, and an unanswered one if any. */
function direct(rows: readonly QRow[], id: string, gate: string): { latest?: QRow; pending?: number } {
  // reason: an approval is of the text the owner was shown; once owner_gate changes, the old answers no longer apply (BR-2616, #296)
  const own = rows.filter((r) => askedGate(id, r.question) === gate.trim());
  const pending = own.filter((r) => r.answer === null).map((r) => r.id).sort((a, b) => b - a)[0];
  const latest = own.find((r) => r.answer !== null);
  return { ...(latest ? { latest } : {}), ...(pending !== undefined ? { pending } : {}) };
}

/** Whether the owner's latest answer about exactly `gate` approves it. */
const approvesText = (rows: readonly QRow[], id: string, gate: string): boolean => {
  const l = direct(rows, id, gate).latest;
  return l !== undefined && isYes(l) && isOwnersAnswer(l);
};

/** The latest keep the main session recorded for `id` and the text `gate` (BR-2626). */
function keptFor(db: CoordDb, id: string, gate: string): { question: number; from: string; reason: string } | undefined {
  const rows = db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'owner-gate.keep' AND subject = ? ORDER BY id DESC").all(id);
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { question: number; from: string; gate: string; reason: string };
    if (d.gate === gate.trim()) return { question: d.question, from: d.from, reason: d.reason };
  }
  return undefined;
}

export function approvalOf(db: CoordDb, id: string, gate: string): Approval {
  const all = approveRows(db, id);
  const { latest, pending } = direct(all, id, gate);
  const waiting = pending !== undefined ? { pending } : {};
  if (latest) {
    const owners = isOwnersAnswer(latest);
    return { approved: isYes(latest) && owners, latest: { id: latest.id, answer: latest.answer!, owners }, ...waiting };
  }
  // reason: with no answer about this text, the main session may have judged that an earlier approval covers it; it holds
  // only while the owner's answer about that earlier text is still a yes (BR-2626)
  const kept = keptFor(db, id, gate);
  if (kept && approvesText(all, id, kept.from)) return { approved: true, kept, ...waiting };
  const old = all.find((r) => r.answer !== null);
  const oldGate = old ? askedGate(id, old.question) ?? old.question : undefined;
  const stale = old && oldGate !== undefined ? { id: old.id, gate: oldGate, approved: approvesText(all, id, oldGate) } : undefined;
  return { approved: false, ...waiting, ...(stale ? { stale } : {}) };
}

/** The command that keeps an earlier approval for the current text (BR-2626). */
export const keepLine = (id: string, question: number): string => `canon work keep-approval ${id} --question ${question} --reason "<why the new text asks nothing the owner did not approve>"`;

export type Keep = { ok: true; from: string } | { ok: false; code: "invalid" | "refused" | "not_found"; message: string };

/**
 * BR-2626: the main session or a person judges that `gate`, the change's current text, asks nothing the owner did not
 * approve in `question` (a wording fix), and keeps that approval; recorded with the reason for the owner to spot-check.
 */
export function keepApproval(db: CoordDb, actor: string, id: string, gate: string, question: number, reason: string): Keep {
  const why = reason.trim();
  if (why === "") return { ok: false, code: "invalid", message: "--reason is required: say why the new owner_gate text asks nothing the owner did not approve" };
  if (isWorker(actor)) return { ok: false, code: "refused", message: `${actor} is a worker: only the main session or a person keeps an owner approval for a changed owner_gate (BR-2626)` };
  const row = approveRows(db, id).find((r) => r.id === question);
  if (!row) return { ok: false, code: "not_found", message: `question #${question} is not an approve ${id} question` };
  const from = askedGate(id, row.question);
  if (from === undefined) return { ok: false, code: "refused", message: `question #${question} does not say which owner_gate text it asks about (approve ${id}: <text>?)` };
  if (from === gate.trim()) return { ok: false, code: "refused", message: `question #${question} already asks about ${id}'s current owner_gate text; nothing to keep` };
  if (!approvesText(approveRows(db, id), id, from)) return { ok: false, code: "refused", message: `the owner's latest answer about ${JSON.stringify(from)} is not an approval: question #${question} cannot be kept; ask the owner about the new text` };
  db.event(actor, "owner-gate.keep", id, { question, from, gate: gate.trim(), reason: why });
  return { ok: true, from };
}

/** How to ask (BR-2616, BR-2617). */
export const askLine = (id: string, gate: string): string => `canon human ask "approve ${id}: ${gate}?" --option 批准,不批准 --change ${id}`;

/** The refusal of `land --finish` for a change not approved yet (BR-2616); `worker` adds that it hands back. */
export function gateRefusal(id: string, gate: string, a: Approval, worker: boolean): string {
  const now = a.latest ? `question #${a.latest.id} was answered ${JSON.stringify(a.latest.answer)}${a.latest.owners ? "" : ", which is not the owner's own answer (a human at a terminal, or a relay matching the question tool's record, BR-2331)"}`
    : a.stale ? `the owner has not been asked about this text yet: question #${a.stale.id} was about ${JSON.stringify(a.stale.gate)}, and owner_gate has changed since, so its answer does not count${a.stale.approved && !worker ? `; if the new text asks nothing the owner did not approve (a wording fix), keep that approval instead of asking: ${keepLine(id, a.stale.id)}` : ""}`
    : "the owner has not been asked yet";
  const how = worker
    ? "a worker cannot ask the owner: land without --finish or hand it back (canon work stop --reason owner), and the main session asks"
    : `ask the owner in the conversation with the question tool, word for word: ${askLine(id, gate)}; then canon human answer <n> <answer> --relayed "<their words>"`;
  return `${id} needs the owner's approval of "${gate}" before it finishes (owner_gate, BR-2616): ${now}; ${how}`;
}
