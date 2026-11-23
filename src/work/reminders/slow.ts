import { isClosed, type ChangeState } from "../../knowledge/changes/state.ts";
import type { Workspace } from "../workspace.ts";
import { age, type DueItem } from "./due.ts";


interface Ev { readonly id: number; readonly ts: string; readonly kind: string; readonly detail: string }

/** Whether a `work.test` run failed: a test file, the type check or canon check (BR-2612, as `canon work test` exits 1). */
function failed(detail: string): boolean {
  const d = JSON.parse(detail) as { failed?: number; typecheck?: number; check?: number; timedOut?: boolean };
  return (d.failed ?? 0) > 0 || (d.typecheck ?? 0) !== 0 || (d.check ?? 0) !== 0 || d.timedOut === true;
}

/**
 * BR-2612: a `slow:<C-n>` item for each change this session delegated that is in force, not closed and not stalled, when
 * more than policies.agenda.slow_hours passed since its last delegation or its last slow_test_failures test runs since then all failed; with
 * where the time went (queued for a full test slot, testing, other).
 */
export function slowItems(ws: Workspace, states: readonly ChangeState[], now: number): DueItem[] {
  const out: DueItem[] = [];
  for (const s of states) {
    if (!s.delegation || s.delegation.owner !== ws.actor || isClosed(s) || s.stalled) continue;
    const events = ws.db.db
      .query<Ev, [string]>("SELECT id, ts, kind, detail FROM events WHERE subject = ? AND kind IN ('delegation.create', 'delegation.update', 'work.test', 'test.full.wait', 'test.full.start') ORDER BY id")
      .all(s.id);
    const last = events.filter((e) => e.kind === "delegation.create" || e.kind === "delegation.update").at(-1);
    if (!last) continue;
    const after = events.filter((e) => e.id > last.id);
    const runs = after.filter((e) => e.kind === "work.test").map((e) => ({ ...e, failed: failed(e.detail) }));
    let streak = 0;
    for (let i = runs.length - 1; i >= 0 && runs[i]!.failed; i--) streak++;
    const elapsed = now - Date.parse(last.ts);
    // reason: the thresholds are the project's policies.agenda, 6 hours and 4 runs by default (BR-2612, BR-2639, D-164)
    if (elapsed <= ws.config.agendaPolicy.slow_hours * 3_600_000 && streak < ws.config.agendaPolicy.slow_test_failures) continue;
    // reason: a run waits once per process; its wait ends when the same process starts (BR-2576's events)
    const waits = new Map<string, number>();
    let queued = 0;
    for (const e of after) {
      const pid = String((JSON.parse(e.detail) as { pid?: unknown }).pid);
      if (e.kind === "test.full.wait" && !waits.has(pid)) waits.set(pid, Date.parse(e.ts));
      if (e.kind === "test.full.start" && waits.has(pid)) { queued += Date.parse(e.ts) - waits.get(pid)!; waits.delete(pid); }
    }
    const testing = runs.reduce((n, r) => n + ((JSON.parse(r.detail) as { ms?: number }).ms ?? 0), 0);
    const other = Math.max(0, elapsed - queued - testing);
    const tests = runs.length === 0 ? "no test run yet" : `${runs.length} test run(s), ${streak > 0 ? `last ${streak} failed` : "last passed"}`;
    out.push({
      key: `slow:${s.id}`,
      kind: "slow",
      since: last.ts,
      summary: `delegated to ${s.delegation.worker}: ${age(elapsed)} since delegated; ${tests}; queued ${age(queued)}, testing ${age(testing)}, other ${age(other)}`,
      next: `ask the worker what blocks it, or canon work take ${s.id} and do it yourself (D-156)`,
      foldNext: "ask the worker what blocks it, or canon work take <n> and do it yourself (D-156)",
      group: "judge",
      tier: 1,
    });
  }
  return out;
}
