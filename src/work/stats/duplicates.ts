import type { ChangeState } from "../../knowledge/changes/state.ts";
import { latestAnswers, pairKey, remindedPairs } from "../../knowledge/changes/duplicate-events.ts";
import type { Workspace } from "../workspace.ts";

/**
 * How precise the duplicate reminder is, per stage (BR-2659, D-171, P6): the pairs reminded in the window, each pair's
 * latest answer whenever given, and how many pairs have a side dropped since. Text only (BR-2202).
 */
export interface StageStats {
  readonly stage: string;
  readonly reminded: number;
  readonly same: number;
  readonly not: number;
  readonly dropped: number;
}

const STAGES = ["new", "land"] as const;

export function duplicateStats(ws: Workspace, since: number, until: number, states: readonly ChangeState[]): StageStats[] {
  const pairs = remindedPairs(ws, { since, until });
  const answers = latestAnswers(ws);
  const dropped = new Set(states.filter((s) => s.state === "dropped").map((s) => s.id));
  return STAGES.flatMap((stage) => {
    const mine = pairs.filter((p) => p.stage === stage);
    if (mine.length === 0) return [];
    const answer = (p: { a: string; b: string }) => answers.get(pairKey(p.a, p.b));
    return [{
      stage,
      reminded: mine.length,
      same: mine.filter((p) => answer(p)?.same === true).length,
      not: mine.filter((p) => answer(p)?.same === false).length,
      dropped: mine.filter((p) => dropped.has(p.a) || dropped.has(p.b)).length,
    }];
  });
}

/** The `Duplicate reminders` section (BR-2659); empty when no stage was reminded in the window. */
export function renderDuplicateStats(rows: readonly StageStats[]): string {
  if (rows.length === 0) return "";
  const lines = ["Duplicate reminders"];
  for (const r of rows) {
    const answered = r.same + r.not;
    const precision = answered === 0 ? "-" : `${Math.round((r.same / answered) * 100)}%`;
    lines.push(`  ${r.stage}: reminded ${r.reminded} pair(s), answered ${answered} (same ${r.same}, not ${r.not}), unanswered ${r.reminded - answered}, precision ${precision}, one side dropped since ${r.dropped}`);
  }
  return lines.join("\n");
}
