import { memoryNow, type Memory } from "../../kernel/machine.ts";
import { ok, type Result } from "../../kernel/result.ts";
import type { Corpus } from "../../knowledge/documents/model.ts";
import { machineNow, type Machine } from "../session/load.ts";
import type { Workspace } from "../workspace.ts";
import { changeStates, isClosed } from "../../knowledge/changes/state.ts";

/**
 * Machine capacity when a delegation would add a worker (BR-2526, D-136): memory pressure, the 5-minute load per CPU,
 * and the worker slots held. Measured before the write transaction; `refusal` decides inside it, where the slots are
 * counted, so two sessions delegating at once cannot both take the last slot.
 */
export interface Capacity {
  readonly memory: Memory | undefined;
  readonly machine: Machine | undefined;
  /** Delegations in force that hold no slot: their change is closed on main, or they are stalled (BR-2522). */
  readonly free: ReadonlySet<string>;
}

/**
 * The machine readings. `CANON_MACHINE=<memory>,<load5>,<cpus>` replaces them (memory normal|warn|critical|none, load
 * `none` for an unmeasured load), so tests do not depend on how busy the machine running them is, as CANON_NOW does
 * for the clock. A value in any other form fails loudly.
 */
export function readings(env: Readonly<Record<string, string | undefined>> = process.env): { memory: Memory | undefined; machine: Machine | undefined } {
  const v = env["CANON_MACHINE"];
  if (v === undefined || v === "") return { memory: memoryNow(), machine: machineNow() };
  const m = /^(normal|warn|critical|none),(none|\d+(?:\.\d+)?),(\d+)$/.exec(v);
  if (!m) throw new Error(`CANON_MACHINE=${JSON.stringify(v)} is not <normal|warn|critical|none>,<load|none>,<cpus> (e.g. normal,1.5,8)`);
  const [, mem, load, cpus] = m;
  return {
    memory: mem === "none" ? undefined : { tight: mem !== "normal", text: `memory pressure ${mem}` },
    machine: load === "none" ? undefined : { load5: Number(load), cpus: Number(cpus) },
  };
}

/** Reads the machine and works out which delegations in force hold no slot. */
export function measure(ws: Workspace, main: Corpus, read: () => { memory: Memory | undefined; machine: Machine | undefined } = readings): Result<Capacity> {
  // reason: closed and stalled are the change state's to say, a branch-only change dropped since included (BR-2526, BR-2571)
  const all = changeStates(ws, { corpus: main, backlog: [], delegatable: false });
  if (!all.ok) return all;
  return ok({ ...read(), free: new Set(all.value.states.filter((s) => isClosed(s) || s.stalled !== undefined).map((s) => s.id)) });
}

/** The signals that could not be read, in the order the rule names them (BR-2526). */
export const unmeasured = (c: Capacity): ("memory" | "load")[] => [...(c.memory ? [] : ["memory" as const]), ...(c.machine ? [] : ["load" as const])];

/**
 * Inside the delegation's write transaction: the reasons a new worker is refused, with what was measured, or undefined
 * when it may start. Unmeasured signals take no part (BR-2526); the slots are always counted.
 */
/**
 * The machine conditions of BR-2526 (1, memory under pressure; 2, load too high) that hold now, one reason each; the
 * worker slots are not among them. `canon work due` lists a `capacity` item while any holds (BR-2527).
 */
export function pressure(ws: Workspace, c: Pick<Capacity, "memory" | "machine">): string[] {
  const perCpu = ws.config.delegateMaxLoadPerCpu;
  const reasons: string[] = [];
  if (c.memory?.tight) reasons.push(c.memory.text);
  // reason: compared unrounded, as BR-2400 does, so 15.96 on 8 CPUs is under a limit of 16 (BR-2526)
  if (c.machine && c.machine.load5 >= perCpu * c.machine.cpus) reasons.push(`5-minute load ${c.machine.load5.toFixed(1)} on ${c.machine.cpus} CPUs (limit ${perCpu * c.machine.cpus})`);
  return reasons;
}

export function refusal(ws: Workspace, c: Capacity): { reasons: string[]; detail: Record<string, unknown> } | undefined {
  const rows = ws.db.db.query<{ subject: string }, []>("SELECT subject FROM delegations WHERE ended IS NULL").all();
  const held = rows.filter((r) => !c.free.has(r.subject)).length;
  const max = ws.config.delegateMaxWorkers;
  const perCpu = ws.config.delegateMaxLoadPerCpu;
  const reasons = pressure(ws, c);
  if (held >= max) reasons.push(`${held} of delegate_max_workers (${max}) in use`);
  if (reasons.length === 0) return undefined;
  return {
    reasons,
    detail: { reason: "capacity", reasons, held, max, ...(c.memory ? { memory: c.memory.text } : {}), ...(c.machine ? { load: Math.round(c.machine.load5 * 10) / 10, cpus: c.machine.cpus, perCpu } : {}), unmeasured: unmeasured(c) },
  };
}

/** The refusal message (BR-2526). */
export const refusalMessage = (subject: string, reasons: readonly string[]): string =>
  `${subject} not delegated: the machine has no room for another worker (BR-2526): ${reasons.join("; ")}. Wait for a worker to land or for the load to fall, then delegate again`;

/** One line per signal that was not measured (BR-2526). */
export const unmeasuredLines = (c: Capacity): string[] => unmeasured(c).map((s) => `capacity: ${s} not measured on this platform; delegated without that check`);

