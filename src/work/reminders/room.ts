import type { Memory } from "../../kernel/machine.ts";
import type { Machine } from "../session/load.ts";
import type { Workspace } from "../workspace.ts";

/**
 * Whether the machine has room for another worker, and how many more fit (BR-2581): BR-2526's three conditions, with the
 * full test runs running counted in. A running full run takes a slot, and lowers the load limit to HEAVY_SHARE of it while
 * it runs, because the 5-minute load lags a run that just started. `canon work watch` adds hysteresis on top (BR-2528).
 */
export interface Room {
  readonly room: boolean;
  readonly fits: number;
  /** Why there is no room, in BR-2526's wording; empty when there is room. */
  readonly reasons: readonly string[];
  readonly load: number | undefined;
  /** The load limit in force: BR-2526's, or HEAVY_SHARE of it while a full test run is running. */
  readonly limit: number | undefined;
  readonly cpus: number | undefined;
  readonly held: number;
  readonly max: number;
  readonly fullRuns: number;
  /** The changes whose delegation in force holds a slot and is light (BR-2632), in order. */
  readonly light: readonly string[];
  /** No room only because of the load: a light delegation may still be made, `fits` of them ignoring the load (BR-2632). */
  readonly loadOnly: boolean;
  readonly fitsIgnoringLoad: number;
}

/** The share of the load limit in force while a full test run is running (BR-2581), and the share watch falls below before it says room again (BR-2528). */
export const HEAVY_SHARE = 0.9;
export const HYSTERESIS = 0.9;

/** One decimal at most: 16, 14.4. */
const short = (n: number): string => String(Math.round(n * 10) / 10);

/**
 * `held` is the slots in use (BR-2526's count), `fullRuns` the full test runs running (BR-2582). With `wasBusy` (watch,
 * BR-2528) the load must fall below HYSTERESIS of the limit before there is room again.
 */
export function roomOf(ws: Workspace, read: { memory: Memory | undefined; machine: Machine | undefined }, held: number, fullRuns: number, wasBusy = false, light: readonly string[] = []): Room {
  const max = ws.config.delegateMaxWorkers;
  const reasons: string[] = [];
  if (read.memory?.tight) reasons.push(read.memory.text);
  let byLoad = false;
  const m = read.machine;
  const base = m ? ws.config.delegateMaxLoadPerCpu * m.cpus : undefined;
  const limit = base === undefined ? undefined : fullRuns > 0 ? base * HEAVY_SHARE : base;
  if (m && limit !== undefined) {
    // reason: compared unrounded, as BR-2526 and BR-2400 do; once busy, watch says room only below HYSTERESIS of the limit (BR-2528)
    const line = wasBusy ? limit * HYSTERESIS : limit;
    if (m.load5 >= line) byLoad = true;
    if (m.load5 >= line) reasons.push(`5-minute load ${m.load5.toFixed(1)} on ${m.cpus} CPUs (limit ${short(limit)}${fullRuns > 0 ? " while a full test run is running" : ""})`);
  }
  const fits = Math.max(0, max - held - fullRuns);
  if (fits === 0) reasons.push(held >= max ? `${held} of delegate_max_workers (${max}) in use${lightNote(light)}` : `${held} of delegate_max_workers (${max}) in use${lightNote(light)}; ${fullRuns} full test run(s) take the last slot(s)`);
  const loadOnly = byLoad && reasons.length === 1;
  return { room: reasons.length === 0, fits: reasons.length === 0 ? fits : 0, reasons, load: m?.load5, limit, cpus: m?.cpus, held, max, fullRuns, light, loadOnly, fitsIgnoringLoad: loadOnly ? fits : reasons.length === 0 ? fits : 0 };
}

/** ` (2 light: C-9, C-12)`, at most 5 named, or nothing when no held delegation is light (BR-2581, BR-2632). */
export const lightNote = (light: readonly string[]): string => (light.length === 0 ? "" : ` (${light.length} light: ${light.slice(0, 5).join(", ")}${light.length > 5 ? `, … +${light.length - 5}` : ""})`);

/** `load 4.2 of 16 on 8 CPUs, 2/10 slots[ (1 light: C-9)][, 1 full test run(s) running]` (BR-2581). */
export function roomDetail(r: Room): string {
  const load = r.load !== undefined && r.limit !== undefined ? `load ${r.load.toFixed(1)} of ${short(r.limit)} on ${r.cpus} CPUs, ` : "";
  return `${load}${r.held}/${r.max} slots${lightNote(r.light)}${r.fullRuns > 0 ? `, ${r.fullRuns} full test run(s) running` : ""}`;
}
