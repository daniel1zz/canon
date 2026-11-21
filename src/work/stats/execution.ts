import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../db.ts";
import { isWorker } from "../delegation/worker.ts";

/**
 * How the changes landed in a window were done (BR-2611, D-156): by the main session itself, delegated and landed by the
 * worker, or delegated and landed by the main session after a handoff or take. Read from the event table and main's git.
 */
export type ExecutionWay = "self" | "worker" | "taken-back";
export const EXECUTION_WAYS: readonly ExecutionWay[] = ["self", "worker", "taken-back"];

export interface ExecutionGroup {
  readonly way: ExecutionWay;
  readonly changes: number;
  /** From the first `start.ok` (self) or the first delegation to the first `land.ok`, in whole minutes; null with no change. */
  readonly medianMinutes: number | null;
  /** `land.refuse` events per change before its first landing; null with no change. */
  readonly averageRefusals: number | null;
  /** `work.test` runs per change before its first landing; null with no change. */
  readonly medianTests: number | null;
  /** Lines added and deleted by the landing outside `canon/`; null with no change or none readable. */
  readonly medianLines: number | null;
}

interface Row { readonly id: number; readonly ts: string; readonly kind: string; readonly subject: string; readonly actor: string; readonly detail: string }

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** Lines added plus deleted between `base` and `sha` outside `canon/`; undefined when git cannot say. */
function codeLines(primary: string, base: string, sha: string): number | undefined {
  const r = git(primary, "diff", "--numstat", base, sha, "--", ".", ":(exclude)canon/");
  if (!r.ok) return undefined;
  let n = 0;
  for (const line of r.value.split("\n")) {
    const [a, d] = line.split("\t");
    // reason: a binary file shows `-`; it has no line count and adds none
    if (a && d && a !== "-" && d !== "-") n += Number(a) + Number(d);
  }
  return n;
}

/** The three groups for the changes whose first landing is in (since, until] (BR-2611). */
export function executionStats(db: CoordDb, primary: string, since: number, until: number): ExecutionGroup[] {
  const rows = db.db
    .query<Row, [number]>("SELECT id, ts, kind, subject, actor, detail FROM events WHERE id <= ? AND subject LIKE 'C-%' AND kind IN ('start.ok', 'delegation.create', 'delegation.update', 'land.ok', 'land.refuse', 'work.test') ORDER BY id")
    .all(until);
  const bySubject = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySubject.get(r.subject);
    if (list) list.push(r);
    else bySubject.set(r.subject, [r]);
  }
  const acc = new Map<ExecutionWay, { minutes: number[]; refusals: number[]; tests: number[]; lines: number[] }>(EXECUTION_WAYS.map((w) => [w, { minutes: [], refusals: [], tests: [], lines: [] }]));
  for (const events of bySubject.values()) {
    const landed = events.find((e) => e.kind === "land.ok");
    // reason: a change counts in the window its first landing falls in, once (BR-2611)
    if (!landed || landed.id <= since) continue;
    const before = events.filter((e) => e.id < landed.id);
    const delegated = before.find((e) => e.kind === "delegation.create" || e.kind === "delegation.update");
    const started = before.find((e) => e.kind === "start.ok");
    const from = delegated ?? started;
    // reason: only a change with a recorded start or delegation has a duration to compare (BR-2611)
    if (!from) continue;
    const way: ExecutionWay = !delegated ? "self" : isWorker(landed.actor) ? "worker" : "taken-back";
    const a = acc.get(way)!;
    a.minutes.push(Math.max(0, Math.floor((Date.parse(landed.ts) - Date.parse(from.ts)) / 60_000)));
    a.refusals.push(before.filter((e) => e.kind === "land.refuse").length);
    a.tests.push(before.filter((e) => e.kind === "work.test").length);
    const d = JSON.parse(landed.detail) as { sha?: unknown; base?: unknown };
    if (typeof d.sha === "string" && typeof d.base === "string") {
      const n = codeLines(primary, d.base, d.sha);
      if (n !== undefined) a.lines.push(n);
    }
  }
  return EXECUTION_WAYS.map((way) => {
    const a = acc.get(way)!;
    const n = a.minutes.length;
    return {
      way,
      changes: n,
      medianMinutes: median(a.minutes),
      averageRefusals: n === 0 ? null : Math.round((a.refusals.reduce((x, y) => x + y, 0) / n) * 10) / 10,
      medianTests: median(a.tests),
      medianLines: median(a.lines),
    };
  });
}

const LABEL: Record<ExecutionWay, string> = { self: "main session itself", worker: "delegated, worker landed", "taken-back": "delegated, main session landed" };

/** The `Execution` section (BR-2611); empty when no change landed in the window. */
export function renderExecutionStats(groups: readonly ExecutionGroup[]): string {
  if (groups.every((g) => g.changes === 0)) return "";
  const v = (x: number | null, unit = "") => (x === null ? "-" : `${x}${unit}`);
  const width = Math.max(...groups.map((g) => LABEL[g.way].length));
  return [
    "Execution (changes whose first landing is in the window, by who did them)",
    ...groups.map((g) => `  ${LABEL[g.way].padEnd(width)}  ${g.changes} change(s)  median ${v(g.medianMinutes, "m")} to land  ${v(g.averageRefusals)} refusal(s) avg  median ${v(g.medianTests)} test run(s)  median ${v(g.medianLines)} code line(s)`),
  ].join("\n");
}
