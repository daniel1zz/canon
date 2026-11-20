import { ok, type Result } from "../../kernel/result.ts";
import type { Change, Corpus, Feature, Release } from "../documents/model.ts";
import { changeStates, hasFile, type ChangeState, type Filed } from "./state.ts";
import type { Workspace } from "../../work/workspace.ts";
import { releaseScope } from "../releases/features.ts";
import { dependencyEdges, waitingJson, waitingMark } from "./deps.ts";

/**
 * The dependency graph of the changes linked to one release or feature (BR-2570, D-151), worked out from the change
 * files every time: each change's state, and an order with dependencies first. Its state counts are the workload
 * `canon release status` and `canon feature status` show (BR-2568).
 */

export type GraphState = "landed" | "in_progress" | "waiting" | "ready";
export const GRAPH_ORDER: readonly GraphState[] = ["landed", "in_progress", "waiting", "ready"];
export const GRAPH_LABEL: Readonly<Record<GraphState, string>> = { landed: "已合入", in_progress: "进行中", waiting: "在等", ready: "可开始" };

/** What the graph reads: every change's state (BR-2571), main's changes and those only on change branches. */
export interface GraphInputs {
  readonly states: readonly Filed[];
}

export interface GraphNode {
  readonly listed: Filed;
  readonly state: GraphState;
}

/** Reads the changes the way `canon overview` does: main's latest commit plus changes only on their branches, each with its state (BR-2570, BR-2571). */
export function graphInputs(ws: Workspace): Result<GraphInputs> {
  const all = changeStates(ws, { backlog: [], delegatable: false });
  if (!all.ok) return all;
  return ok({ states: all.value.states.filter(hasFile) });
}

/**
 * A change's state in the graph, mapped from its primary state (BR-2570, BR-2571): the state module is the one place a
 * change's state is decided; undefined for a dropped or missing change, which is not drawn.
 */
export function graphState(s: ChangeState): GraphState | undefined {
  switch (s.state) {
    case "landed":
      return "landed";
    case "dropped":
    case "missing":
      return undefined;
    case "waiting-owner":
    case "waiting-deps":
      return "waiting";
    case "ready-delegatable":
    case "ready-self":
      // reason: a change with a branch was started; nobody on it now is still work in progress, not new work (BR-2570, BR-2291)
      return s.hasBranch ? "in_progress" : "ready";
    default:
      return "in_progress";
  }
}

/** Which changes belong to a release (its own id, releases merged into it, its features) or to a feature (BR-2570, BR-2561). */
export function memberOf(corpus: Corpus, doc: Release | Feature): (c: Change) => boolean {
  if (doc.kind === "feature") return (c) => c.feature === doc.id;
  const scope = releaseScope(corpus, doc);
  return (c) => (c.release !== undefined && scope.ids.has(c.release)) || (c.feature !== undefined && scope.features.has(c.feature));
}

const num = (id: string) => Number(id.split("-")[1]);

/** The graph's nodes in order: a change after the ones it depends on that are drawn too, otherwise by number; a cycle's changes by number (BR-2570). */
export function changeGraph(inputs: GraphInputs, member: (c: Change) => boolean): GraphNode[] {
  const nodes = inputs.states
    .filter((l) => member(l.change))
    .flatMap((l) => {
      const state = graphState(l);
      return state ? [{ listed: l, state }] : [];
    })
    .sort((a, b) => num(a.listed.change.id) - num(b.listed.change.id));
  const ids = new Set(nodes.map((n) => n.listed.change.id));
  const edges = dependencyEdges(nodes.map((n) => n.listed.change));
  const out: GraphNode[] = [];
  const placed = new Set<string>();
  let rest = nodes;
  while (rest.length > 0) {
    const next = rest.find((n) => (edges.get(n.listed.change.id) ?? []).every((d) => !ids.has(d) || placed.has(d)));
    // reason: changes on a cycle wait for each other forever; they are drawn by number instead of not at all (BR-2570)
    const pick = next ?? rest[0]!;
    out.push(pick);
    placed.add(pick.listed.change.id);
    rest = rest.filter((n) => n !== pick);
  }
  return out;
}

/** How many changes are in each state: the workload, never how done a release or feature is (BR-2568). */
export function workload(nodes: readonly GraphNode[]): Record<GraphState, number> {
  return Object.fromEntries(GRAPH_ORDER.map((k) => [k, nodes.filter((n) => n.state === k).length])) as Record<GraphState, number>;
}

/** The text of `canon change graph` (BR-2570). */
export function graphLines(doc: Release | Feature, nodes: readonly GraphNode[]): string[] {
  const w = workload(nodes);
  const out = [`${doc.id}  ${doc.title}  变更 ${nodes.length} 个：${GRAPH_ORDER.map((k) => `${GRAPH_LABEL[k]} ${w[k]}`).join("  ")}`];
  if (nodes.length === 0) out.push("(no changes)");
  for (const n of nodes) {
    const c = n.listed.change;
    const deps = c.dependsOn?.length ? `  depends on ${c.dependsOn.join(", ")}` : "";
    const waiting = n.state === "waiting" ? `  ${waitingMark(n.listed.waiting)}` : "";
    out.push(`${c.id.padEnd(8)} ${GRAPH_LABEL[n.state]}  ${c.title}${deps}${waiting}`);
  }
  return out;
}

/** The `--json` form of `canon change graph` (BR-2570). */
export function graphJson(doc: Release | Feature, nodes: readonly GraphNode[]): Record<string, unknown> {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    counts: workload(nodes),
    changes: nodes.map((n) => ({ id: n.listed.change.id, title: n.listed.change.title, state: n.state, depends_on: n.listed.change.dependsOn ?? [], waiting_for: waitingJson(n.listed.waiting) })),
  };
}
