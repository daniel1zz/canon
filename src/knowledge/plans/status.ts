import type { Change, Corpus } from "../documents/model.ts";
import { readPlan, type Step } from "./parse.ts";

/** What a plan's steps stand at, worked out from the changes doing them every time, never stored (BR-2372, D-77). */

export type StepState = "done" | "working" | "ready" | "blocked";

export const STATE_ORDER: readonly StepState[] = ["ready", "working", "blocked", "done"];
export const STATE_LABEL: Readonly<Record<StepState, string>> = { done: "已完成", working: "进行中", ready: "可开始", blocked: "被挡住" };

/** A change that may do steps, and whether it is on main: one only on its own branch has not landed, whatever it says (BR-2372). */
export interface Doer {
  readonly change: Change;
  readonly onMain: boolean;
}

export interface StepStatus {
  readonly step: Step;
  readonly state: StepState;
  /** The changes doing it, not the dropped ones. */
  readonly changes: readonly string[];
  /** The dependencies not done yet; empty unless the step is blocked. */
  readonly waitingFor: readonly string[];
}

export interface PlanStatus {
  readonly change: Change;
  readonly steps: readonly StepStatus[];
  readonly counts: Readonly<Record<StepState, number>>;
  /** Whole percent of steps done, rounded down. */
  readonly percent: number;
}

/** One status per change with a valid plan, by number (BR-2373); `doers` are the changes whose `plan` names it. */
export function planStatuses(corpus: Corpus, doers: readonly Doer[]): PlanStatus[] {
  return corpus.docs
    .filter((d): d is Change => d.kind === "change")
    .sort((a, b) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]))
    .flatMap((change) => {
      const plan = readPlan(change.body);
      return plan.kind === "plan" ? [statusOf(change, plan.steps, doers)] : [];
    });
}

function statusOf(change: Change, steps: readonly Step[], doers: readonly Doer[]): PlanStatus {
  const doing = (s: Step) => doers.filter((d) => d.change.plan === change.id && d.change.steps?.includes(s.name) && d.change.status !== "dropped");
  // reason: done needs every change landed and done on main; one only on its branch is still being done (BR-2372)
  const finished = (d: Doer) => d.onMain && d.change.status === "done";
  const done = new Set(steps.filter((s) => { const ds = doing(s); return ds.length > 0 && ds.every(finished); }).map((s) => s.name));
  const list = steps.map((step): StepStatus => {
    const changes = doing(step).map((d) => d.change.id);
    const waitingFor = step.dependsOn.filter((d) => !done.has(d));
    const state: StepState = done.has(step.name) ? "done" : changes.length > 0 ? "working" : waitingFor.length === 0 ? "ready" : "blocked";
    return { step, state, changes, waitingFor: state === "blocked" ? waitingFor : [] };
  });
  const counts = Object.fromEntries(STATE_ORDER.map((k) => [k, list.filter((s) => s.state === k).length])) as Record<StepState, number>;
  return { change, steps: list, counts, percent: Math.floor((100 * counts.done) / steps.length) };
}

/** The one-line summary of a plan (BR-2373). */
export function summaryLine(p: PlanStatus): string {
  const total = p.steps.length;
  return `${p.change.id}  ${p.change.title}  ${STATE_LABEL.done} ${p.counts.done}/${total} (${p.percent}%)  ${STATE_LABEL.working} ${p.counts.working}  ${STATE_LABEL.ready} ${p.counts.ready}  ${STATE_LABEL.blocked} ${p.counts.blocked}`;
}

/** The summary, then a line per state that has steps (BR-2374). */
export function detailLines(p: PlanStatus): string[] {
  const out = [summaryLine(p)];
  const show = (s: StepStatus): string =>
    s.state === "ready" ? `${s.step.name} ${s.step.content}` : s.state === "working" ? `${s.step.name} (${s.changes.join(", ")})` : s.state === "blocked" ? `${s.step.name} (等 ${s.waitingFor.join(", ")})` : s.step.name;
  for (const k of STATE_ORDER) {
    const of = p.steps.filter((s) => s.state === k);
    if (of.length > 0) out.push(`  ${STATE_LABEL[k]}: ${of.map(show).join(k === "done" ? ", " : "; ")}`);
  }
  return out;
}

/** The `--json` form of a plan: its counts, with the steps when `withSteps` (BR-2373, BR-2374). */
export function statusJson(p: PlanStatus, withSteps: boolean): Record<string, unknown> {
  return {
    id: p.change.id,
    title: p.change.title,
    total: p.steps.length,
    done: p.counts.done,
    working: p.counts.working,
    ready: p.counts.ready,
    blocked: p.counts.blocked,
    percent: p.percent,
    ...(withSteps ? { steps: p.steps.map((s) => ({ step: s.step.name, content: s.step.content, depends_on: s.step.dependsOn, state: s.state, changes: s.changes, waiting_for: s.waitingFor })) } : {}),
  };
}
