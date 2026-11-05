import type { CoordDb } from "../../work/db.ts";
import { STATE_LABEL, type ExecutionState } from "../../work/execution/state.ts";
import { releaseStatuses } from "./status.ts";

/** The two things a release needs before it ships (D-61): its rules passed, and the owner's recorded yes. Checked by `canon release ship` and again by the landing. */

/** The rules tagged with a release that are not passed, each as a line saying what is wrong (empty when it may ship). */
export function shipBlockers(corpus: Parameters<typeof releaseStatuses>[0], states: ReadonlyMap<string, ExecutionState>, id: string): string[] {
  const status = releaseStatuses(corpus, states).find((s) => s.release.id === id);
  if (!status) return [`${id} is not a release`];
  if (status.rules.length === 0) return [`no rule is tagged ${id}: there is no behaviour to ship (a rule says \`release: ${id}\` in its front matter)`];
  return status.rules.filter((r) => r.state !== "passed").map((r) => `${r.id} ${r.title}: ${STATE_LABEL[r.state]}${r.change ? ` (${r.change})` : ""}`);
}

/** The text a question must contain to be about shipping `id`: `ship R-3`, whole (R-3 does not match R-30). */
export const shipQuestion = (id: string): RegExp => new RegExp(`\\bship ${id}(?![0-9])`, "i");

/** What the owner has answered about shipping a release, or why there is no usable answer. */
export type Confirmation = { readonly ok: true; readonly question: number } | { readonly ok: false; readonly message: string };

// reason: the narrower the list, the fewer words an agent can pass off as the owner's yes (BR-2331, D-61)
export const YES = /^(yes|是)$/i;

interface Row {
  readonly id: number;
  readonly question: string;
  readonly answer: string;
  readonly answered_by: string | null;
  readonly relayed: string | null;
  readonly witness: string | null;
}

/**
 * The most recently answered question that names `ship <id>` decides (BR-2331, D-61): a later `no` revokes an earlier `yes`.
 * It counts when it was answered yes by a human at a terminal, or relayed by an agent whose words match what Claude Code's
 * question tool recorded (witness `match`, BR-2276). Anything else, including no such question, is a refusal that says how to fix it.
 */
export function ownerConfirmation(db: CoordDb, id: string): Confirmation {
  const rows = db.db
    .query<Row, []>("SELECT id, question, answer, answered_by, relayed, witness FROM questions WHERE answer IS NOT NULL ORDER BY answered_at DESC, id DESC")
    .all()
    .filter((r) => shipQuestion(id).test(r.question));
  const how = `ask the owner in the conversation with the question tool, copying the question word for word: canon human ask "ship ${id}: <what ships, the rules and the commit>?" --option yes,no ; then record what they chose: canon human answer <n> yes --relayed "yes"`;
  const latest = rows[0];
  if (!latest) return { ok: false, message: `${id} needs the owner's confirmation: no answered question names \`ship ${id}\`; ${how}` };
  if (!YES.test(latest.answer.trim())) return { ok: false, message: `the owner did not confirm shipping ${id}: question #${latest.id} was answered ${JSON.stringify(latest.answer)}, not yes; ${how}` };
  // reason: the relayed words are what the owner said and `answer` is what the agent typed; both must be yes, or an agent could record yes over the owner's no (BR-2331)
  if (latest.relayed !== null && !YES.test(latest.relayed.trim())) {
    return { ok: false, message: `the owner did not confirm shipping ${id}: question #${latest.id} was answered ${JSON.stringify(latest.answer)}, but the owner's relayed words are ${JSON.stringify(latest.relayed)}, not yes; ${how}` };
  }
  const byHuman = latest.answered_by?.startsWith("human:") === true && latest.relayed === null;
  if (byHuman || (latest.relayed !== null && latest.witness === "match")) return { ok: true, question: latest.id };
  // reason: a relay canon cannot tie to the question tool's record is an agent's word, not the owner's (BR-2276, D-61)
  return { ok: false, message: `question #${latest.id} (ship ${id}) was answered yes, but the answer is not the owner's: ${latest.relayed === null ? `${latest.answered_by} is not a human` : `the relayed words do not match Claude Code's question-tool record (${latest.witness ?? "not checked"}, BR-2276)`}; ${how}` };
}

