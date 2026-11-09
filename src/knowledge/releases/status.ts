import type { Change, Corpus, Release, Rule } from "../documents/model.ts";
import { planStatuses, type PlanStatus } from "../plans/status.ts";
import { STATE_LABEL, STATE_ORDER, type ExecutionState } from "../../work/execution/state.ts";

/** `canon release status` (D-61): the rules tagged with each release, grouped by the execution state D-32 derives. */

const number = (id: string) => Number(id.split("-")[1]);

export interface RuleLine {
  readonly id: string;
  readonly title: string;
  readonly state: ExecutionState["kind"];
  /** The change whose pass record counts, for a passed rule or one waiting for main's tests. */
  readonly change?: string;
  readonly changedIn: readonly string[];
}

export interface ReleaseStatus {
  readonly release: Release;
  /** Rules tagged with the release, not retired, by id. */
  readonly rules: readonly RuleLine[];
  readonly counts: Readonly<Record<ExecutionState["kind"], number>>;
  /** For a shipped release: its rules a later release changed (`changed_in`). Empty for a release not shipped. */
  readonly changedAfterShip: readonly RuleLine[];
  /** The plans tagged with the release (`release: R-n` on the plan change), by number (D-79). */
  readonly plans: readonly PlanStatus[];
}

/** One status per release, by number; every release in the corpus. */
export function releaseStatuses(corpus: Corpus, states: ReadonlyMap<string, ExecutionState>): ReleaseStatus[] {
  const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status !== "retired" && d.release !== undefined);
  // reason: a step is done only by a change done on main, so the corpus alone (main's, or the landing's tree) decides
  // done; changes still on their branches would only add working steps, which a release does not count (D-79, BR-2372)
  const plans = planStatuses(corpus, corpus.docs.filter((d): d is Change => d.kind === "change").map((change) => ({ change, onMain: true })));
  return corpus.docs
    .filter((d): d is Release => d.kind === "release")
    .sort((a, b) => number(a.id) - number(b.id))
    .map((release) => {
      const lines = rules
        .filter((r) => r.release === release.id)
        .sort((a, b) => number(a.id) - number(b.id))
        .map((r): RuleLine => {
          const s = states.get(r.id);
          return { id: r.id, title: r.title, state: s?.kind ?? "rerun", ...(s && (s.kind === "passed" || s.kind === "waiting") ? { change: s.change } : {}), changedIn: r.changedIn ?? [] };
        });
      const counts = Object.fromEntries(STATE_ORDER.map((k) => [k, lines.filter((l) => l.state === k).length])) as Record<ExecutionState["kind"], number>;
      return { release, rules: lines, counts, changedAfterShip: release.status === "shipped" ? lines.filter((l) => l.changedIn.length > 0) : [], plans: plans.filter((p) => p.change.release === release.id) };
    });
}

const AFTER_SHIP = "发布后又改了";

/** The one-line summary of a release: id, status, title, the count of each state, and for a shipped release the changed-after-ship count. */
export function summaryLine(s: ReleaseStatus): string {
  const counts = STATE_ORDER.map((k) => `${STATE_LABEL[k]} ${s.counts[k]}`).join("  ");
  return `${s.release.id}  ${s.release.status}  ${s.release.title}  ${counts}${s.release.status === "shipped" ? `  ${AFTER_SHIP} ${s.changedAfterShip.length}` : ""}${s.plans.map((p) => `  ${planProgress(p)}`).join("")}`;
}

/** A tagged plan's progress after the rule counts: `计划 C-n 已完成 21/51 (41%)` (D-79). */
const planProgress = (p: PlanStatus): string => `计划 ${p.change.id} 已完成 ${p.counts.done}/${p.steps.length} (${p.percent}%)`;

/** The lines of one release: its summary, then each state's rule ids, then (shipped) the rules changed after it shipped. */
export function detailLines(s: ReleaseStatus): string[] {
  const out = [summaryLine(s)];
  for (const k of STATE_ORDER) {
    const of = s.rules.filter((l) => l.state === k);
    if (of.length === 0) continue;
    out.push(`  ${STATE_LABEL[k]}: ${of.map((l) => (l.change ? `${l.id} (${l.change})` : l.id)).join(", ")}`);
  }
  if (s.changedAfterShip.length > 0) out.push(`  ${AFTER_SHIP}: ${s.changedAfterShip.map((l) => `${l.id} (changed in ${l.changedIn.join(", ")})`).join(", ")}`);
  return out;
}

/** The `--json` form: the summary of a release, with its rules when `withRules`. */
export function statusJson(s: ReleaseStatus, withRules: boolean): Record<string, unknown> {
  return {
    id: s.release.id,
    title: s.release.title,
    status: s.release.status,
    shipped_at: s.release.shippedAt ?? null,
    counts: s.counts,
    changed_after_ship: s.changedAfterShip.length,
    // reason: without a tagged plan the JSON stays exactly as it was (D-79)
    ...(s.plans.length > 0 ? { plans: s.plans.map((p) => ({ id: p.change.id, title: p.change.title, total: p.steps.length, done: p.counts.done, percent: p.percent })) } : {}),
    ...(withRules ? { rules: s.rules.map((l) => ({ id: l.id, title: l.title, state: l.state, change: l.change ?? null, changed_in: l.changedIn })), changed_after_ship_rules: s.changedAfterShip.map((l) => l.id) } : {}),
  };
}
