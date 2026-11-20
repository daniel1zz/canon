import type { Corpus, Feature, Release, Rule } from "../documents/model.ts";
import { CRITERION_LABEL, CRITERION_ORDER, criteriaOf, type Criterion, type CriterionState } from "./criteria.ts";
import { inRelease, releaseScope } from "./features.ts";
import { STATE_LABEL, STATE_ORDER, type ExecutionState } from "../../work/execution/state.ts";

/**
 * `canon release status` and `canon feature status` (D-61, D-151): the rules of a release or feature grouped by the
 * execution state D-32 derives, its success criteria, and whether it is done, which rules and criteria alone decide
 * (BR-2568). The changes linked to it are workload, passed in by the caller (BR-2570), never part of done.
 */

const number = (id: string) => Number(id.split("-")[1]);

export interface RuleLine {
  readonly id: string;
  readonly title: string;
  readonly state: ExecutionState["kind"];
  /** The change whose pass record counts, for a passed rule or one waiting for main's tests. */
  readonly change?: string;
  readonly changedIn: readonly string[];
}

/** A success criterion with the document it is written in (BR-2329). */
export interface DocCriterion {
  readonly doc: string;
  readonly criterion: Criterion;
}

/** The progress of a release or a feature: its rules, its criteria and whether it is done (BR-2568). */
export interface GoalStatus {
  readonly doc: Release | Feature;
  /** Its rules, not retired, by id. */
  readonly rules: readonly RuleLine[];
  readonly counts: Readonly<Record<ExecutionState["kind"], number>>;
  /** Its criteria: a release's own, then its features' (dropped ones left out) and those of releases merged into it. */
  readonly criteria: readonly DocCriterion[];
  readonly done: boolean;
}

export interface ReleaseStatus extends GoalStatus {
  readonly release: Release;
  /** For a shipped release: its rules a later release changed (`changed_in`). Empty for a release not shipped. */
  readonly changedAfterShip: readonly RuleLine[];
}

/** The workload of the changes linked to a release or feature: how many are in each state (BR-2570). */
export type Workload = Readonly<Record<"landed" | "in_progress" | "waiting" | "ready", number>>;

const WORKLOAD_LABEL: readonly [keyof Workload, string][] = [["landed", "已合入"], ["in_progress", "进行中"], ["waiting", "在等"], ["ready", "可开始"]];

function goalStatus(corpus: Corpus, doc: Release | Feature, rules: readonly Rule[], states: ReadonlyMap<string, ExecutionState>, criteriaDocs: readonly (Release | Feature)[]): GoalStatus {
  const lines = [...rules].sort((a, b) => number(a.id) - number(b.id)).map((r): RuleLine => {
    const s = states.get(r.id);
    return { id: r.id, title: r.title, state: s?.kind ?? "rerun", ...(s && (s.kind === "passed" || s.kind === "waiting") ? { change: s.change } : {}), changedIn: r.changedIn ?? [] };
  });
  const counts = Object.fromEntries(STATE_ORDER.map((k) => [k, lines.filter((l) => l.state === k).length])) as Record<ExecutionState["kind"], number>;
  const criteria = criteriaDocs.flatMap((d) => criteriaOf(d.body, corpus.types).map((criterion) => ({ doc: d.id, criterion })));
  // reason: done is what the rules and criteria say, never how many linked changes landed; nothing to judge is not done (BR-2568, D-148)
  const done = lines.length + criteria.length > 0 && lines.every((l) => l.state === "passed") && criteria.every((c) => c.criterion.state === "met");
  return { doc, rules: lines, counts, criteria, done };
}

const live = (corpus: Corpus) => corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status !== "retired");

/** One status per release, by number; every release in the corpus. */
export function releaseStatuses(corpus: Corpus, states: ReadonlyMap<string, ExecutionState>): ReleaseStatus[] {
  const rules = live(corpus).filter((d) => d.release !== undefined || d.feature !== undefined);
  return corpus.docs
    .filter((d): d is Release => d.kind === "release")
    .sort((a, b) => number(a.id) - number(b.id))
    .map((release) => {
      const scope = releaseScope(corpus, release);
      const features = [...scope.features].map((f) => corpus.docs.find((d): d is Feature => d.kind === "feature" && d.id === f)).filter((f): f is Feature => f !== undefined && f.status !== "dropped");
      const g = goalStatus(corpus, release, rules.filter((r) => inRelease(r, scope)), states, [release, ...features, ...scope.merged]);
      return { ...g, release, changedAfterShip: release.status === "shipped" ? g.rules.filter((l) => l.changedIn.length > 0) : [] };
    });
}

/** One status per feature, by number; dropped ones too (BR-2569). */
export function featureStatuses(corpus: Corpus, states: ReadonlyMap<string, ExecutionState>): GoalStatus[] {
  const rules = live(corpus);
  return corpus.docs
    .filter((d): d is Feature => d.kind === "feature")
    .sort((a, b) => number(a.id) - number(b.id))
    .map((f) => goalStatus(corpus, f, rules.filter((r) => r.feature === f.id), states, [f]));
}

const AFTER_SHIP = "发布后又改了";

const criteriaCounts = (g: GoalStatus): Record<CriterionState, number> => Object.fromEntries(CRITERION_ORDER.map((k) => [k, g.criteria.filter((c) => c.criterion.state === k).length])) as Record<CriterionState, number>;

/** `变更 已合入 a  进行中 b  在等 c  可开始 d`: the workload (BR-2328, BR-2569). */
export const workloadText = (w: Workload): string => `变更 ${WORKLOAD_LABEL.map(([k, l]) => `${l} ${w[k]}`).join("  ")}`;

/**
 * The one-line summary (BR-2328, BR-2569): id, status, title, the count of each rule state, for a shipped release the
 * changed-after-ship count, the criteria met, the workload when given, and done or not.
 */
export function summaryLine(g: GoalStatus, work?: Workload): string {
  const counts = STATE_ORDER.map((k) => `${STATE_LABEL[k]} ${g.counts[k]}`).join("  ");
  const shipped = "changedAfterShip" in g && g.doc.status === "shipped" ? `  ${AFTER_SHIP} ${(g as ReleaseStatus).changedAfterShip.length}` : "";
  const criteria = `  成功标准 已满足 ${criteriaCounts(g).met}/${g.criteria.length}`;
  return `${g.doc.id}  ${g.doc.status}  ${g.doc.title}  ${counts}${shipped}${criteria}${work ? `  ${workloadText(work)}` : ""}  ${g.done ? "完成" : "未完成"}`;
}

/** The lines of one release or feature: its summary, each state's rule ids, (shipped) the rules changed after it shipped, then each criterion (BR-2329). */
export function detailLines(g: GoalStatus, work?: Workload): string[] {
  const out = [summaryLine(g, work)];
  for (const k of STATE_ORDER) {
    const of = g.rules.filter((l) => l.state === k);
    if (of.length === 0) continue;
    out.push(`  ${STATE_LABEL[k]}: ${of.map((l) => (l.change ? `${l.id} (${l.change})` : l.id)).join(", ")}`);
  }
  const after = "changedAfterShip" in g ? (g as ReleaseStatus).changedAfterShip : [];
  if (after.length > 0) out.push(`  ${AFTER_SHIP}: ${after.map((l) => `${l.id} (changed in ${l.changedIn.join(", ")})`).join(", ")}`);
  for (const { doc, criterion: c } of g.criteria) out.push(`  ${doc}/${c.id} ${CRITERION_LABEL[c.state]} ${c.text}`);
  return out;
}

/** The `--json` form (BR-2328, BR-2329, BR-2569): the summary, with the rules and criteria when `withRules`. */
export function statusJson(g: GoalStatus, withRules: boolean, work?: Workload): Record<string, unknown> {
  const release = "changedAfterShip" in g ? (g as ReleaseStatus) : undefined;
  return {
    id: g.doc.id,
    title: g.doc.title,
    status: g.doc.status,
    ...(release ? { shipped_at: release.release.shippedAt ?? null } : {}),
    counts: g.counts,
    ...(release ? { changed_after_ship: release.changedAfterShip.length } : {}),
    criteria: criteriaCounts(g),
    ...(work ? { changes: work } : {}),
    done: g.done,
    ...(withRules
      ? {
          rules: g.rules.map((l) => ({ id: l.id, title: l.title, state: l.state, change: l.change ?? null, changed_in: l.changedIn })),
          ...(release ? { changed_after_ship_rules: release.changedAfterShip.map((l) => l.id) } : {}),
          criteria_list: g.criteria.map(({ doc, criterion: c }) => ({ doc, id: c.id, text: c.text, state: c.state, evidence: c.evidence })),
        }
      : {}),
  };
}
