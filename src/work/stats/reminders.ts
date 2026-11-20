import type { ChangeState } from "../../knowledge/changes/state.ts";
import { age } from "../reminders/due.ts";
import { outcomes, type Outcome } from "../reminders/handled.ts";
import type { Workspace } from "../workspace.ts";

/**
 * How the main agent handled its reminders (BR-2585, D-151, P6): from the `reminder.handled` events in the window and the
 * agenda now. Text only, like the other sections after the checks (BR-2202).
 */
export interface ReminderStats {
  readonly handled: number;
  /** Items on the agenda now with no outcome ever recorded (the delegate group not counted). */
  readonly unhandled: number;
  readonly handed: number;
  readonly handedLanded: number;
  readonly handedOpen: number;
  readonly handedDropped: number;
  readonly viaSettles: number;
  readonly deferred: number;
  readonly notDoing: number;
  /** Milliseconds from each item's start to its outcome, for those with a start. */
  readonly times: readonly number[];
  /** Keys handed to a change that has landed, still on the agenda. */
  readonly stillOpen: readonly string[];
}

/** `open` is the agenda's item keys now (judge and owner); `states` the change states (BR-2571). */
export function reminderStats(ws: Workspace, since: number, until: number, open: readonly string[], states: readonly ChangeState[]): ReminderStats {
  const inWindow = outcomes(ws, { since, until });
  const ever = outcomes(ws);
  const all = [...inWindow.values()];
  const state = (id: string | null) => states.find((s) => s.id === id)?.state;
  const handed = all.filter((o) => o.outcome === "handed");
  const time = (o: Outcome) => (o.since === null ? undefined : Date.parse(o.at) - Date.parse(o.since));
  return {
    handled: all.length,
    unhandled: open.filter((k) => !ever.has(k)).length,
    handed: handed.length,
    handedLanded: handed.filter((o) => state(o.to) === "landed").length,
    handedDropped: handed.filter((o) => state(o.to) === "dropped").length,
    handedOpen: handed.filter((o) => state(o.to) !== "landed" && state(o.to) !== "dropped").length,
    viaSettles: handed.filter((o) => o.via === "settles").length,
    deferred: all.filter((o) => o.outcome === "deferred").length,
    notDoing: all.filter((o) => o.outcome === "not-doing").length,
    times: all.map(time).filter((t): t is number => t !== undefined && t >= 0).sort((a, b) => a - b),
    stillOpen: handed.filter((o) => state(o.to) === "landed" && open.includes(o.key)).map((o) => o.key),
  };
}

const median = (xs: readonly number[]): number => {
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
};

/** The `Reminders` section (BR-2585); empty when nothing was handled and nothing is open. */
export function renderReminderStats(r: ReminderStats): string {
  if (r.handled === 0 && r.unhandled === 0) return "";
  const total = r.handled + r.unhandled;
  const lines = ["Reminders", `  handled ${r.handled} of ${total} (${Math.round((r.handled / total) * 100)}%)`];
  lines.push(`  handed ${r.handed} (${r.handedLanded} landed, ${r.handedOpen} open, ${r.handedDropped} dropped)${r.viaSettles > 0 ? `, ${r.viaSettles} via --settles` : ""}`);
  lines.push(`  deferred ${r.deferred}`, `  not-doing ${r.notDoing}`);
  if (r.times.length > 0) lines.push(`  time to outcome: median ${age(median(r.times))}, max ${age(r.times.at(-1)!)}`);
  if (r.stillOpen.length > 0) lines.push(`  handed but still open after landing: ${r.stillOpen.join(", ")}`);
  return lines.join("\n");
}
