import { isOwnersAnswer } from "../../knowledge/releases/gate.ts";
import type { CoordDb } from "../db.ts";

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
  /** The latest answered approve question, if any. */
  readonly latest?: { readonly id: number; readonly answer: string; readonly owners: boolean };
  /** An approve question about the current gate text still waiting for its answer, if any. */
  readonly pending?: number;
  /** With no answered question about the current text: the latest answered one about another text (the gate changed). */
  readonly stale?: { readonly id: number; readonly gate: string };
}

export function approvalOf(db: CoordDb, id: string, gate: string): Approval {
  const all = db.db.query<Row & { question: string }, []>("SELECT id, question, answer, answered_by, relayed, witness FROM questions ORDER BY answered_at DESC, id DESC").all().filter((r) => approveQuestion(id).test(r.question));
  // reason: an approval is of the text the owner was shown; once owner_gate changes, the old answers no longer apply (BR-2616, #296)
  const rows = all.filter((r) => askedGate(id, r.question) === gate.trim());
  const pending = rows.filter((r) => r.answer === null).map((r) => r.id).sort((a, b) => b - a)[0];
  const latest = rows.find((r) => r.answer !== null);
  if (!latest) {
    const old = all.find((r) => r.answer !== null);
    const stale = old ? { id: old.id, gate: askedGate(id, old.question) ?? old.question } : undefined;
    return { approved: false, ...(pending !== undefined ? { pending } : {}), ...(stale ? { stale } : {}) };
  }
  const yes = APPROVE.test(said(latest.answer!)) && (latest.relayed === null || APPROVE.test(said(latest.relayed)));
  const owners = isOwnersAnswer(latest);
  return { approved: yes && owners, latest: { id: latest.id, answer: latest.answer!, owners }, ...(pending !== undefined ? { pending } : {}) };
}

/** How to ask (BR-2616, BR-2617). */
export const askLine = (id: string, gate: string): string => `canon human ask "approve ${id}: ${gate}?" --option 批准,不批准 --change ${id}`;

/** The refusal of `land --finish` for a change not approved yet (BR-2616); `worker` adds that it hands back. */
export function gateRefusal(id: string, gate: string, a: Approval, worker: boolean): string {
  const now = a.latest ? `question #${a.latest.id} was answered ${JSON.stringify(a.latest.answer)}${a.latest.owners ? "" : ", which is not the owner's own answer (a human at a terminal, or a relay matching the question tool's record, BR-2331)"}`
    : a.stale ? `the owner has not been asked about this text yet: question #${a.stale.id} was about ${JSON.stringify(a.stale.gate)}, and owner_gate has changed since, so its answer does not count`
    : "the owner has not been asked yet";
  const how = worker
    ? "a worker cannot ask the owner: land without --finish or hand it back (canon work stop --reason owner), and the main session asks"
    : `ask the owner in the conversation with the question tool, word for word: ${askLine(id, gate)}; then canon human answer <n> <answer> --relayed "<their words>"`;
  return `${id} needs the owner's approval of "${gate}" before it finishes (owner_gate, BR-2616): ${now}; ${how}`;
}
