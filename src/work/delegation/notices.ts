import type { Change, Corpus, Doc } from "../../knowledge/documents/model.ts";
import { changeStates, isClosed, type ChangeState } from "../../knowledge/changes/state.ts";
import { liveClaims } from "../claims/claims.ts";
import type { CoordDb } from "../db.ts";
import type { Workspace } from "../workspace.ts";
import { mainCorpus } from "../session/session.ts";
import { approvalOf } from "../land/owner-gate.ts";

/**
 * The reminders canon prints when a change is started or delegated (D-156), and the facts the agenda lists under a change
 * that can start (BR-2607, BR-2606): what the main agent weighs when it chooses who does a change, never a refusal. They
 * change no exit code, claim or delegation.
 */

type DocOf = (id: string) => Doc | undefined;

/** What the facts are read from: main's documents, the change states (BR-2571) and who holds a live claim on what. */
export interface NoticeContext {
  readonly docOf: DocOf;
  readonly states: readonly ChangeState[];
  /** Change → the actor holding its live claim. */
  readonly holders: ReadonlyMap<string, string>;
  /** The coordination database, for the owner's answers (BR-2618). */
  readonly db?: CoordDb;
}

/** The context from main's corpus and change states already read (the agenda has both). */
export function contextOf(corpus: Corpus, states: readonly ChangeState[], db: CoordDb): NoticeContext {
  const docs = new Map(corpus.docs.map((d) => [d.id, d]));
  return { docOf: (id) => docs.get(id), states, holders: new Map(liveClaims(db).map((c) => [c.subject, c.actor])), db };
}

/** A change's contract rules (BR-2608): the rules its `rules:` lists, plus the `will_amend` targets of those that are planned. */
export function contractRules(docOf: DocOf, change: Pick<Change, "rules">): Set<string> {
  const out = new Set<string>();
  for (const id of change.rules) {
    out.add(id);
    const rule = docOf(id);
    if (rule?.kind === "rule") for (const target of rule.willAmend ?? []) out.add(target);
  }
  return out;
}

/** Whether `text` names `id` as a whole word (BR-12 is not BR-123). */
const names = (text: string, id: string): boolean => new RegExp(`(^|[^A-Za-z0-9-])${id}(?![0-9])`).test(text);

/**
 * BR-2609: each `will_amend` target of a planned rule in `change` whose text on main does not name that planned rule yet:
 * its new text is not written, so the design is not settled.
 */
export function unsettledLines(docOf: DocOf, change: Pick<Change, "rules">): string[] {
  const out: string[] = [];
  for (const id of change.rules) {
    const rule = docOf(id);
    if (rule?.kind !== "rule" || rule.status !== "planned") continue;
    for (const target of rule.willAmend ?? []) {
      const t = docOf(target);
      if (t && names(t.body, id)) continue;
      out.push(`design not settled: ${id} will amend ${target}, whose text does not name ${id} yet; a worker cannot write rule text (D-128) and would hand it back for the design owner to apply (BR-2524), so the main session may do this change itself (D-156)`);
    }
  }
  return out;
}

/**
 * BR-2614: each rule id the change file's text names that is planned on main but not in its `rules:`: a worker could not
 * activate it (BR-2501 takes the contract from `rules:`), so it is said before the worker starts.
 */
export function unlistedPlannedLines(docOf: DocOf, subject: string, change: Pick<Change, "rules" | "body">): string[] {
  const listed = new Set(change.rules);
  const named = [...new Set(change.body.match(/\bBR-\d+\b/g) ?? [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return named
    .filter((id) => { const d = docOf(id); return !listed.has(id) && d?.kind === "rule" && d.status === "planned"; })
    .map((id) => `not in rules: ${id} is planned and named in ${subject}'s text; if ${subject} activates it, add it to rules: and publish that on main, then delegate again, or BR-2501 refuses the worker's activation`);
}

/**
 * BR-2608: for every other change in progress (a live claim or a live delegation, not closed) whose contract rules meet
 * `subject`'s, one line naming the shared rules and who works on it.
 */
export function sharedLines(ctx: NoticeContext, subject: string, own: Pick<Change, "rules">): string[] {
  const mine = contractRules(ctx.docOf, own);
  if (mine.size === 0) return [];
  const out: string[] = [];
  for (const s of ctx.states) {
    if (s.id === subject || !s.change || isClosed(s)) continue;
    const holder = ctx.holders.get(s.id);
    // reason: only work someone is doing now can land first and change the shared text under this one (BR-2608, D-156)
    if (!holder && !s.delegation) continue;
    const shared = [...contractRules(ctx.docOf, s.change)].filter((r) => mine.has(r)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (shared.length === 0) continue;
    const who = holder ? `claimed by ${holder}` : `delegated to ${s.delegation!.worker} by ${s.delegation!.owner}`;
    out.push(`${subject} shares ${shared.join(", ")} with ${s.id} (${who}): whichever lands second may have to redo its work against the first one's text; order them (depends_on) or have one session do both (D-156)`);
  }
  return out;
}

/** The facts for one change: its BR-2608 lines, and its BR-2609 and BR-2614 lines when it is to be delegated. */
export function changeFacts(ctx: NoticeContext, subject: string, own: Pick<Change, "rules" | "body" | "ownerGate">, delegating: boolean): string[] {
  return delegating ? [...sharedLines(ctx, subject, own), ...unsettledLines(ctx.docOf, own), ...unlistedPlannedLines(ctx.docOf, subject, own), ...gateLines(ctx, subject, own)] : sharedLines(ctx, subject, own);
}

/** BR-2618: a change the owner must approve, not approved yet, cannot be finished by the worker it goes to. */
function gateLines(ctx: NoticeContext, subject: string, own: Pick<Change, "ownerGate">): string[] {
  if (own.ownerGate === undefined || !ctx.db || approvalOf(ctx.db, subject).approved) return [];
  return [`owner gate: ${subject} needs the owner's approval of "${own.ownerGate}" before it can finish (BR-2616); the worker cannot ask the owner, so it lands without --finish or hands back, and you ask`];
}

/**
 * The BR-2608 lines, and the BR-2609 lines when `delegating`, that `canon work start` and `canon work delegate` print for
 * `subject`. Rules are read from main; the change files from wherever the change states find them (main or the change's
 * branch). A state that cannot be read is said, not taken for none.
 */
export function startNotices(ws: Workspace, subject: string, delegating: boolean): string[] {
  const main = mainCorpus(ws);
  if (!main.ok) return [`shares: cannot read ${ws.config.main}: ${main.error.message}`];
  const states = changeStates(ws, { corpus: main.value, delegatable: false });
  if (!states.ok) return [`shares: cannot read the change states: ${states.error.message}`];
  const own = states.value.states.find((s) => s.id === subject)?.change;
  if (!own) return [];
  return changeFacts(contextOf(main.value, states.value.states, ws.db), subject, own, delegating);
}
