import type { Change, Corpus } from "../documents/model.ts";
import type { Finding } from "../check/check.ts";
import type { Criterion, CriterionState } from "../releases/criteria.ts";
import { criteriaByDoc } from "../releases/features.ts";
import { isCriterionRef } from "./links.ts";

/**
 * Dependencies between changes (BR-2564, BR-2565, D-149): when one counts as satisfied, worked out from the changes'
 * states every time and never stored, and the cycles `canon check` refuses.
 */

/** Why a dependency is not satisfied (BR-2564): a change's, or a success criterion's state other than met (BR-2504). */
export type WaitState = "open" | "on-branch" | "dropped" | "not-found" | Exclude<CriterionState, "met">;

export interface Waiting {
  /** The change named in `depends_on`. */
  readonly id: string;
  readonly state: WaitState;
  /** The last change `done_by` led to, when the dependency was dropped and handed on (BR-2564). */
  readonly via?: string;
  /** For a success criterion that exists: its text (BR-2564). */
  readonly text?: string;
}

/** The success criteria of main's releases and features by document id, as dependencies read them (BR-2564). */
export type CriteriaByDoc = ReadonlyMap<string, readonly Criterion[]>;

/**
 * The dependencies of `change` not satisfied, in its order (BR-2564): judged on main's latest commit (`onMain`); a change
 * only in `elsewhere` (a change branch, or this checkout) has not landed, whatever it says.
 */
export function waitingFor(change: Change, onMain: ReadonlyMap<string, Change>, elsewhere: ReadonlySet<string>, criteria: CriteriaByDoc = new Map()): Waiting[] {
  return (change.dependsOn ?? []).flatMap((id) => {
    const w = isCriterionRef(id) ? criterionWait(id, criteria) : unsatisfied(id, onMain, elsewhere);
    return w ? [w] : [];
  });
}

/** A criterion dependency is satisfied only when the criterion is met on main: the owner's ones need the owner's answer (BR-2564, BR-2510). */
function criterionWait(ref: string, criteria: CriteriaByDoc): Waiting | undefined {
  const [doc, sid] = ref.split("/") as [string, string];
  const c = criteria.get(doc)?.find((x) => x.id === sid);
  if (!c) return { id: ref, state: "not-found" };
  return c.state === "met" ? undefined : { id: ref, state: c.state, text: c.text };
}

function unsatisfied(id: string, onMain: ReadonlyMap<string, Change>, elsewhere: ReadonlySet<string>): Waiting | undefined {
  const seen = new Set<string>();
  let at = id;
  let via: string | undefined;
  const wait = (state: WaitState): Waiting => ({ id, state, ...(via !== undefined ? { via } : {}) });
  for (;;) {
    const c = onMain.get(at);
    if (!c) return wait(elsewhere.has(at) ? "on-branch" : "not-found");
    if (c.status === "done") return undefined;
    if (c.status === "open") return wait("open");
    // reason: a dropped change counts as the change that did its work; a chain that comes back on itself never lands (BR-2564)
    if (c.doneBy === undefined || seen.has(c.doneBy) || c.doneBy === id) return wait("dropped");
    seen.add(at);
    at = c.doneBy;
    via = at;
  }
}

/** How a dependency is written in the `waiting for` mark (BR-2564). */
export function waitingText(w: Waiting): string {
  if (w.text !== undefined) return `${w.id}: ${w.text}`;
  if (w.via !== undefined) return `${w.id} (done by ${w.via})`;
  if (w.state === "dropped") return `${w.id} (dropped without done_by)`;
  if (w.state === "not-found") return `${w.id} (not found)`;
  return w.id;
}

/** The `waiting for …` mark, or undefined when nothing is waited for (BR-2564). */
export function waitingMark(ws: readonly Waiting[]): string | undefined {
  return ws.length > 0 ? `waiting for ${ws.map(waitingText).join(", ")}` : undefined;
}

/** The `--json` form of what a change waits for (BR-2564). */
export const waitingJson = (ws: readonly Waiting[]) => ws.map((w) => ({ id: w.id, state: w.state, ...(w.via !== undefined ? { done_by: w.via } : {}), ...(w.text !== undefined ? { text: w.text } : {}) }));

/**
 * The cycle through `start` in the graph `edges` (change id → the ids it depends on), as the path from `start` back to
 * it, or undefined when `start` is on none (BR-2565). The first cycle found in `depends_on` order is the one named.
 */
export function cycleThrough(start: string, edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (at: string): string[] | undefined => {
    if (at === start && path.length > 0) return [...path, start];
    if (done.has(at) || path.includes(at)) return undefined;
    path.push(at);
    for (const next of edges.get(at) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    done.add(at);
    return undefined;
  };
  return visit(start);
}

/** The `depends_on` graph of a set of changes. */
export const dependencyEdges = (changes: readonly Change[]): Map<string, readonly string[]> => new Map(changes.map((c) => [c.id, (c.dependsOn ?? []).filter((d) => !isCriterionRef(d))]));

/**
 * The links checks of `canon check` (BR-2561, BR-2565): a change names a release or a feature, not both; `done_by` is on
 * a dropped change and names another; a named feature exists (a release is checked with the plans, BR-2386); and no
 * change is on a cycle of `depends_on` in this tree.
 */
export function linkFindings(corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change");
  const criteria = criteriaByDoc(corpus);
  for (const c of changes) {
    if (c.release !== undefined && c.feature !== undefined) out.push({ path: c.path, rule: "file-invalid", message: `${c.id} names both \`release: ${c.release}\` and \`feature: ${c.feature}\`: write one; a feature's release is the one whose \`features\` lists it (BR-2561)` });
    if (c.feature !== undefined && !corpus.docs.some((d) => d.id === c.feature)) out.push({ path: c.path, rule: "ref-dangling", message: `${c.id} \`feature\` names ${c.feature}, which does not exist` });
    if (c.doneBy !== undefined && c.status !== "dropped") out.push({ path: c.path, rule: "file-invalid", message: `${c.id} is ${c.status}, but \`done_by\` is only for a dropped change: it names the change that did its work instead (BR-2561)` });
    // reason: like `advances`, only an open change is held to the criteria it names; a closed one is history (BR-2561, BR-2517)
    if (c.status === "open") {
      for (const ref of (c.dependsOn ?? []).filter(isCriterionRef)) {
        const [doc, sid] = ref.split("/") as [string, string];
        const of = criteria.get(doc);
        if (!of) out.push({ path: c.path, rule: "ref-dangling", message: `${c.id} \`depends_on\` names ${ref}, but ${doc} is no release or feature` });
        else if (!of.some((x) => x.id === sid)) out.push({ path: c.path, rule: "ref-dangling", message: `${c.id} \`depends_on\` names ${ref}, but ${doc} has no success criterion ${sid}` });
      }
    }
    if (c.doneBy === c.id) out.push({ path: c.path, rule: "file-invalid", message: `${c.id} \`done_by\` names itself: name the change that did its work instead (BR-2561)` });
  }
  // reason: only this tree's change files are edges; a branch's edge counts once it lands, so a cycle two branches make is refused at the second landing (BR-2565, D-149)
  const edges = dependencyEdges(changes);
  for (const c of changes) {
    const cycle = cycleThrough(c.id, edges);
    if (cycle) out.push({ path: c.path, rule: "depends-cycle", message: `${c.id} depends on itself through ${cycle.join(" → ")}: remove one of these dependencies (BR-2565)` });
  }
  return out;
}
