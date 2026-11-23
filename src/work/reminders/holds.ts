import type { ChangeState } from "../../knowledge/changes/state.ts";
import type { Workspace } from "../workspace.ts";
import type { DueItem } from "./due.ts";

/** The kinds of item keyed `<kind>:<C-n>` whose change, while the item stays open, keeps others from starting (BR-2635). */
const CHANGE_KINDS = new Set(["owner-gate", "land-refused", "stalled", "slow", "interrupt", "awaiting-close", "design", "reverted"]);
/** How many held changes a summary names before `… +k` (BR-2635). */
export const HOLDS_SHOWN = 5;

/**
 * For each change, the open changes that wait on it, directly or through others (BR-2635): reversed from each change's
 * unsatisfied dependencies (BR-2564), nearest first, then by number. Worked out from the states, never stored.
 */
export function heldBy(states: readonly ChangeState[]): Map<string, string[]> {
  const waiters = new Map<string, string[]>();
  for (const s of states) {
    if (s.state === "landed" || s.state === "dropped") continue;
    for (const w of s.waiting) if (/^C-\d+$/.test(w.id)) waiters.set(w.id, [...(waiters.get(w.id) ?? []), s.id]);
  }
  const num = (id: string) => Number(id.slice(2));
  const out = new Map<string, string[]>();
  for (const id of waiters.keys()) {
    const seen = new Set<string>([id]);
    const order: string[] = [];
    let level = [id];
    while (level.length > 0) {
      const next = [...new Set(level.flatMap((x) => waiters.get(x) ?? []))].filter((x) => !seen.has(x)).sort((a, b) => num(a) - num(b));
      for (const x of next) { seen.add(x); order.push(x); }
      level = next;
    }
    if (order.length > 0) out.set(id, order);
  }
  return out;
}

/** The change an item is about, when that change can hold others: `owner-gate:C-5`, or a question asked about C-5. */
function changeOf(item: DueItem, askedAbout: ReadonlyMap<number, string>): string | undefined {
  const at = item.key.indexOf(":");
  const kind = item.key.slice(0, at);
  if (CHANGE_KINDS.has(kind)) return item.key.slice(at + 1);
  if (kind === "question") return askedAbout.get(Number(item.key.slice(at + 1)));
  return undefined;
}

/**
 * The items with what they hold (BR-2635): an item whose change others wait on says which, is never folded with others
 * of its kind, and a judge item of the last tier moves up to the tier of what blocks others. An owner-gate item with
 * no start takes its change's first event as its start.
 */
export function withHolds(ws: Workspace, items: readonly DueItem[], states: readonly ChangeState[]): DueItem[] {
  const held = heldBy(states);
  const askedAbout = new Map<number, string>();
  for (const s of states) for (const q of s.ownerQuestions) askedAbout.set(q, s.id);
  const first = ws.db.db.query<{ ts: string }, [string]>("SELECT MIN(ts) AS ts FROM events WHERE subject = ?");
  return items.map((it) => {
    const change = changeOf(it, askedAbout);
    // reason: an owner-gate item had no start, so one held for days read `-` and sorted last (BR-2635)
    const since = it.since === null && it.kind === "owner-gate" && change !== undefined ? first.get(change)?.ts ?? null : it.since;
    const holds = change === undefined ? undefined : held.get(change);
    if (!holds) return since === it.since ? it : { ...it, since };
    const named = holds.slice(0, HOLDS_SHOWN).join(", ") + (holds.length > HOLDS_SHOWN ? `, … +${holds.length - HOLDS_SHOWN}` : "");
    // reason: said where it applies rather than in the brief every session loads (BR-2635, session_text_budget)
    const owners = it.kind === "owner-gate" || it.kind === "question";
    const next = owners ? `${it.next}; it holds waiting changes, so ask now, or land without --finish so the owner sees the work on main` : it.next;
    return { ...it, since, holds, next, tier: it.group === "judge" && it.tier === 2 ? 1 : it.tier, summary: `${it.summary}; holds ${holds.length} waiting change(s): ${named}` };
  });
}
