import type { Change, Doc } from "../../knowledge/documents/model.ts";
import { changeStates, isClosed } from "../../knowledge/changes/state.ts";
import { liveClaims } from "../claims/claims.ts";
import type { Workspace } from "../workspace.ts";
import { mainCorpus } from "../session/session.ts";

/**
 * The reminders canon prints when a change is started or delegated (D-156): facts the main agent weighs when it chooses
 * who does a change, never a refusal. They change no exit code, claim or delegation.
 */

type DocOf = (id: string) => Doc | undefined;

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
 * The BR-2608 lines, and the BR-2609 lines when `delegating`, for `subject`: for every other change in progress (a live
 * claim or a live delegation, not closed) whose contract rules meet `subject`'s, one line naming the shared rules and who
 * works on it. Rules are read from main; the change files from wherever the change states find them (main or the change's
 * branch). A state that cannot be read is said, not taken for none.
 */
export function startNotices(ws: Workspace, subject: string, delegating: boolean): string[] {
  const main = mainCorpus(ws);
  if (!main.ok) return [`shares: cannot read ${ws.config.main}: ${main.error.message}`];
  const docs = new Map(main.value.docs.map((d) => [d.id, d]));
  const docOf: DocOf = (id) => docs.get(id);
  const states = changeStates(ws, { corpus: main.value, delegatable: false });
  if (!states.ok) return [`shares: cannot read the change states: ${states.error.message}`];
  const own = states.value.states.find((s) => s.id === subject)?.change;
  if (!own) return [];
  const mine = contractRules(docOf, own);
  const holders = new Map(liveClaims(ws.db).map((c) => [c.subject, c.actor]));
  const out: string[] = [];
  for (const s of mine.size === 0 ? [] : states.value.states) {
    if (s.id === subject || !s.change || isClosed(s)) continue;
    const holder = holders.get(s.id);
    // reason: only work someone is doing now can land first and change the shared text under this one (BR-2608, D-156)
    if (!holder && !s.delegation) continue;
    const shared = [...contractRules(docOf, s.change)].filter((r) => mine.has(r)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (shared.length === 0) continue;
    const who = holder ? `claimed by ${holder}` : `delegated to ${s.delegation!.worker} by ${s.delegation!.owner}`;
    out.push(`${subject} shares ${shared.join(", ")} with ${s.id} (${who}): whichever lands second may have to redo its work against the first one's text; order them (depends_on) or have one session do both (D-156)`);
  }
  return delegating ? [...out, ...unsettledLines(docOf, own)] : out;
}
