import { git } from "../../kernel/git.ts";
import { ok, type Result } from "../../kernel/result.ts";
import type { Change } from "../../knowledge/documents/model.ts";
import { mainCorpus } from "../session/session.ts";
import { agenda, summary } from "./agenda.ts";
import { changeStates, isClosed } from "../../knowledge/changes/state.ts";
import type { Workspace } from "../workspace.ts";
import { findingItems, renderDue, type DueItem } from "./due.ts";
import { holds, outcomes } from "./handled.ts";

/**
 * The open findings that concern one piece of work (BR-2530, BR-2584): those naming any of `ids` (its rules, its own id,
 * the documents its commits touched), and how many others are open. Findings waiting on the owner's answer (BR-2461) and
 * those the main agent recorded an outcome for that still holds (BR-2583) are in neither.
 */
export function findingsOn(ws: Workspace, ids: ReadonlySet<string>, now: number = Date.now()): Result<{ related: DueItem[]; others: number }> {
  const done = outcomes(ws);
  const items = findingItems(ws);
  let closed: (id: string) => boolean = () => false;
  if (items.some((f) => done.has(f.item.key))) {
    const all = changeStates(ws, { delegatable: false, now });
    if (!all.ok) return all;
    const states = all.value.states;
    closed = (id) => !states.some((s) => s.id === id && !isClosed(s));
  }
  const open = items.filter((f) => { const o = done.get(f.item.key); return !o || !holds(o, f.item.since, closed, now); });
  const related = open.filter((f) => f.finding.ids.some((id) => ids.has(id)) || f.finding.docs.some((d) => ids.has(d)));
  return ok({ related: related.map((f) => f.item), others: open.length - related.length });
}

/** How many related findings `canon work start` lists (BR-2530). */
export const RELATED_SHOWN = 10;

/** `canon work start`'s lines (BR-2530): the related findings, at most ten, then one line for the rest. */
export function startLines(found: { related: readonly DueItem[]; others: number }, now: number = Date.now()): string[] {
  const out: string[] = [];
  if (found.related.length > 0) {
    out.push("note: review findings on what this change touches (BR-2530):", ...found.related.slice(0, RELATED_SHOWN).map((it) => `  ${renderDue(it, now)}`));
    if (found.related.length > RELATED_SHOWN) out.push(`  … and ${found.related.length - RELATED_SHOWN} more: canon work due`);
  }
  if (found.others > 0) out.push(`note: ${found.others} other open review finding(s): canon work due`);
  return out;
}

/**
 * What a main session's landing prints after it landed (BR-2584): the agenda summary as it is now, then the open findings
 * on what the landing touched (the change's id and rules, and the documents its commit changed), apart. Nothing for an
 * empty agenda with no such finding; a failure is one line, never the landing's failure.
 */
export function afterLandLines(ws: Workspace, landed: { sha: string; change: string | null }, now: number = Date.now()): string[] {
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return [`agenda unavailable: ${corpus.error.message}`];
  const ids = new Set<string>();
  const doc = corpus.value.docs.find((d): d is Change => d.kind === "change" && (d.id === landed.change || d.chore === landed.change));
  if (doc) for (const id of [doc.id, ...doc.rules]) ids.add(id);
  // reason: a chore names no rules, so the documents its commit changed say what it touched (BR-2584)
  const paths = git(ws.primary, "-c", "core.quotePath=false", "diff", "--name-only", `${landed.sha}^`, landed.sha);
  if (paths.ok) {
    const byPath = new Map(corpus.value.docs.map((d) => [d.path, d.id]));
    for (const p of paths.value.split("\n")) { const id = byPath.get(p); if (id) ids.add(id); }
  }
  const a = agenda(ws, { now });
  if (!a.ok) return [`agenda unavailable: ${a.error.message}`];
  const found = findingsOn(ws, ids, now);
  if (!found.ok) return [`agenda unavailable: ${found.error.message}`];
  const out = summary(a.value, now);
  if (found.value.related.length > 0) out.push(`Findings on what ${doc?.id ?? landed.change ?? landed.sha.slice(0, 9)} touched:`, ...found.value.related.map((it) => `  ${renderDue(it, now)}`));
  return out;
}
