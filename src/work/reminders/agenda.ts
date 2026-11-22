import { err, ok, type Result } from "../../kernel/result.ts";
import { changeStates, isClosed, type ChangeState } from "../../knowledge/changes/state.ts";
import { readings } from "../delegation/capacity.ts";
import { isWorker } from "../delegation/worker.ts";
import { mainCorpus } from "../session/session.ts";
import type { Workspace } from "../workspace.ts";
import { age, ageOf, mainItems, renderDue, workerItems, type DueItem } from "./due.ts";
import { holds, outcomes } from "./handled.ts";
import { runningFullRuns, type HeavyRuns, type Loads, type Slots } from "./heavy.ts";
import { lightNote, roomDetail, roomOf, type Room } from "./room.ts";
import { interruptItems } from "./interrupt.ts";
import { changeFacts, contextOf } from "../delegation/notices.ts";
import { DEFAULT_TIER, type Tier } from "../priority/tiers.ts";

/**
 * The agenda (BR-2527, D-151): the one place that works out what the main agent should hear about. Three groups (what can
 * be delegated, what to judge, what waits on the owner) and the full test runs running; read from the change states
 * (BR-2571), the coordination database and the machine. `canon work due`, `canon brief`, the landing, `canon work start`,
 * `canon work watch` and `canon overview` all read it. Worked out on every read, never stored.
 */

/** What reads the machine; a test passes fixed readings (BR-2526's CANON_MACHINE is read by the default). */
export type Readings = () => ReturnType<typeof readings>;

export interface Ready {
  readonly id: string;
  readonly title: string;
}

/** A change that can start now, as the agenda's first group lists it (BR-2607): both ways, and the facts to weigh. */
export interface ReadyItem extends Ready {
  readonly tier: Tier;
  readonly delegatable: boolean;
  /** Why it cannot be delegated (BR-2571); empty when it can. */
  readonly notDelegatable: readonly string[];
  /** BR-2608's and BR-2609's lines for it. */
  readonly facts: readonly string[];
}

export interface Agenda {
  /** Null for a worker: it delegates nothing. */
  readonly delegate: { readonly room: Room; readonly changes: readonly Ready[]; readonly ready: readonly ReadyItem[] } | null;
  readonly judge: readonly DueItem[];
  readonly owner: readonly DueItem[];
  readonly yours: readonly DueItem[];
  readonly heavy: HeavyRuns;
  /** The changes that can start now (ready-delegatable or ready-self), in the owner's order: watch's "can start now" (BR-2528). */
  readonly startable: readonly string[];
  /** The change states it was worked out from (BR-2571); empty for a worker. */
  readonly states: readonly ChangeState[];
}

export interface AgendaOptions {
  readonly now?: number;
  readonly read?: Readings;
  /** watch's hysteresis: the machine was said busy last (BR-2528). */
  readonly wasBusy?: boolean;
  /** The machine-wide queue of full test runs; tests pass a directory of their own. */
  readonly slots?: Slots;
  /** The machine-wide queue of heavy steps waiting for the load; tests pass a directory of their own (BR-2630). */
  readonly load?: Loads;
}

/** How many delegatable changes are named (BR-2581) and how many items a summary group shows (BR-2529). */
export const DELEGATE_SHOWN = 5;
export const SUMMARY_SHOWN = 3;
/** The most keys a folded line names (BR-2527). */
export const FOLD_KEYS = 10;

const byOrder = (a: DueItem, b: DueItem): number => a.tier - b.tier || (a.since === null ? 1 : 0) - (b.since === null ? 1 : 0) || (a.since !== null && b.since !== null ? Date.parse(a.since) - Date.parse(b.since) : 0);

/** The calling session's agenda (BR-2527). */
export function agenda(ws: Workspace, opts: AgendaOptions = {}): Result<Agenda> {
  const now = opts.now ?? Date.now();
  const runs = runningFullRuns(opts.slots, opts.load, { primary: ws.primary });
  if (!runs.ok) return runs;
  const heavy = runs.value;
  if (isWorker(ws.actor)) return ok({ delegate: null, judge: [], owner: [], yours: workerItems(ws), heavy, startable: [], states: [] });
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  const all = changeStates(ws, { corpus: corpus.value, now });
  if (!all.ok) return all;
  const states = all.value.states;
  let machine: ReturnType<Readings>;
  try {
    machine = (opts.read ?? readings)();
  } catch (e) {
    // reason: CANON_MACHINE written wrong is a usage error said loudly, never a silent unmeasured machine (BR-2526)
    if (e instanceof Error && /CANON_MACHINE/.test(e.message)) return err("invalid", e.message);
    throw e;
  }
  const closed = new Set(states.filter(isClosed).map((s) => s.id));
  // reason: a slot is held by a delegation in force on a change not closed and not stalled, as BR-2526 counts it
  const holding = states.filter((s) => s.delegation !== undefined && !isClosed(s) && s.stalled === undefined).map((s) => s.id);
  const held = holding.length;
  const lightIds = new Set(ws.db.db.query<{ subject: string }, []>("SELECT subject FROM delegations WHERE ended IS NULL AND light IS NOT NULL").all().map((r) => r.subject));
  const room = roomOf(ws, machine, held, heavy.running.length, opts.wasBusy, holding.filter((id) => lightIds.has(id)).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""))));
  const done = outcomes(ws);
  const keep = (key: string, since: string | null): boolean => {
    const o = done.get(key);
    return !o || !holds(o, since, (id) => closed.has(id) || !states.some((s) => s.id === id), now);
  };
  const ctx = contextOf(corpus.value, states, ws.db);
  const items = [...mainItems(ws, now, states, corpus.value), ...interruptItems(ws, states, room, ctx)].filter((it) => keep(it.key, it.since));
  // reason: the main agent chooses who does a change, so every change that can start is listed with both ways, not only the delegatable ones (BR-2607, D-156)
  const startable = states.filter((s): s is ChangeState & { change: NonNullable<ChangeState["change"]> } => (s.state === "ready-delegatable" || s.state === "ready-self") && s.change !== undefined && keep(`ready:${s.id}`, null));
  const ready: ReadyItem[] = startable.map((s) => {
    const delegatable = s.state === "ready-delegatable";
    return { id: s.id, title: s.change.title, tier: s.priority?.tier ?? DEFAULT_TIER, delegatable, notDelegatable: s.notDelegatable, facts: changeFacts(ctx, s.id, s.change, delegatable) };
  });
  return ok({
    delegate: { room, changes: ready.filter((r) => r.delegatable).map((r) => ({ id: r.id, title: r.title })), ready },
    judge: items.filter((it) => it.group === "judge").sort(byOrder),
    owner: items.filter((it) => it.group === "owner").sort(byOrder),
    yours: [],
    heavy,
    startable: states.filter((s) => s.state === "ready-delegatable" || s.state === "ready-self").map((s) => s.id),
    states,
  });
}

/** The flat list of items to handle (BR-2527): judge and owner for a main session, a worker's own. */
export const dueList = (a: Agenda): DueItem[] => [...a.judge, ...a.owner, ...a.yours];

/** Whether nothing would be printed (BR-2527, BR-2529). */
export const isEmpty = (a: Agenda): boolean => (a.delegate === null || a.delegate.ready.length === 0) && dueList(a).length === 0 && a.heavy.running.length === 0 && a.heavy.waiting === 0 && a.heavy.loadWaiting.length === 0;

/** One group's items with the same kind folded together where there are two or more, in the order of each kind's first item (BR-2527). */
export function folded(items: readonly DueItem[]): DueItem[][] {
  const out: DueItem[][] = [];
  const at = new Map<string, DueItem[]>();
  for (const it of items) {
    const g = at.get(it.kind);
    if (g) g.push(it);
    else { const fresh = [it]; at.set(it.kind, fresh); out.push(fresh); }
  }
  return out;
}

/** A folded line: `<kind> ×<n> oldest <age>: <keys> → <next>` (BR-2527). */
function foldLine(g: readonly DueItem[], now: number): string {
  const oldest = g.find((it) => it.since !== null)?.since ?? null;
  const keys = g.slice(0, FOLD_KEYS).map((it) => it.key).join(", ");
  const more = g.length > FOLD_KEYS ? `, … +${g.length - FOLD_KEYS}` : "";
  return `${g[0]!.kind} ×${g.length} oldest ${ageOf(oldest, now)}: ${keys}${more} → ${g[0]!.foldNext}`;
}

const entryLine = (g: readonly DueItem[], now: number): string => (g.length === 1 ? renderDue(g[0]!, now) : foldLine(g, now));

/** `heavy: C-637 full test run 12m; 2 waiting; 1 waiting for the load (C-9 test 4m)` (BR-2582), or undefined when nothing runs or waits. */
export function heavyLine(h: HeavyRuns, now: number): string | undefined {
  if (h.running.length === 0 && h.waiting === 0 && h.loadWaiting.length === 0) return undefined;
  const running = h.running.map((r) => `${r.subject ?? "main"} full test run ${age(now - Date.parse(r.since))}`).join(", ");
  const shown = h.loadWaiting.slice(0, DELEGATE_SHOWN).map((w) => `${w.subject} ${w.kind} ${age(now - Date.parse(w.since))}`).join(", ");
  const more = h.loadWaiting.length > DELEGATE_SHOWN ? `, … +${h.loadWaiting.length - DELEGATE_SHOWN}` : "";
  const load = h.loadWaiting.length > 0 ? `; ${h.loadWaiting.length} waiting for the load (${shown}${more})` : "";
  return `heavy: ${running || "none running"}${h.waiting > 0 ? `; ${h.waiting} waiting` : ""}${load}`;
}

/** With only the load in the way a light delegation may still be made, up to the slots that fit (BR-2581, BR-2632). */
const lightFits = (d: NonNullable<Agenda["delegate"]>): boolean => d.room.loadOnly && d.room.fitsIgnoringLoad > 0;

/** The busy head's reasons, and when only the load is in the way, the slots and the light delegation that still fits (BR-2581). */
function busyHead(d: NonNullable<Agenda["delegate"]>): string {
  const light = lightFits(d) ? `; ${d.room.held}/${d.room.max} slots${lightNote(d.room.light)}; light delegations still fit ${d.room.fitsIgnoringLoad}: canon work delegate <C-n> --to <name> --light "<why>"` : "";
  return `delegate: busy (${d.room.reasons.join("; ")})${light}`;
}

/** The delegate group's head (BR-2581). */
export function delegateHead(d: NonNullable<Agenda["delegate"]>): string {
  if (d.room.room) return `delegate: room for ${d.room.fits} more (${roomDetail(d.room)})`;
  return `${busyHead(d)}; delegatable once it falls: ${d.changes.slice(0, DELEGATE_SHOWN).map((c) => c.id).join(", ") || "none"}`;
}

/** The first group's head in `canon work due` (BR-2607): the machine's room, and that the choice is the main agent's. */
export function startHead(d: NonNullable<Agenda["delegate"]>): string {
  return `${d.room.room ? `delegate: room for ${d.room.fits} more (${roomDetail(d.room)})` : busyHead(d)}; start or delegate: your call (D-156)`;
}

/** One change that can start (BR-2607): `ready:C-5 P2 - <title> → canon work start C-5 | canon work delegate C-5 --to <name>`. */
export function readyLine(r: ReadyItem): string {
  const ways = r.delegatable ? `canon work start ${r.id} | canon work delegate ${r.id} --to <name>` : `canon work start ${r.id} (not delegatable: ${r.notDelegatable.join("; ")})`;
  return `ready:${r.id} ${r.tier} - ${r.title} → ${ways}`;
}

/** The whole agenda as `canon work due` prints it (BR-2527, BR-2607, BR-2582). */
export function agendaLines(a: Agenda, now: number = Date.now()): string[] {
  const out: string[] = [];
  const d = a.delegate;
  if (d && d.ready.length > 0) {
    out.push(startHead(d));
    for (const r of d.ready.slice(0, DELEGATE_SHOWN)) out.push(`  ${readyLine(r)}`, ...r.facts.map((f) => `    ${f}`));
    if (d.ready.length > DELEGATE_SHOWN) out.push(`  … ${d.ready.length - DELEGATE_SHOWN} more ready (canon change list)`);
  }
  for (const [name, items] of [["judge", a.judge], ["owner", a.owner], ["yours", a.yours]] as const) {
    if (items.length === 0) continue;
    out.push(`${name}: ${items.length}`, ...folded(items).map((g) => `  ${entryLine(g, now)}`));
  }
  const heavy = heavyLine(a.heavy, now);
  if (heavy) out.push(heavy);
  return out;
}

/** The summary's line of one group: `judge: 7: stalled ×2, finding A ×5, … +1` (BR-2529). */
function summaryGroup(name: string, items: readonly DueItem[]): string {
  const entries = folded(items).map((g) => (g.length === 1 ? g[0]!.key : `${g[0]!.kind} ×${g.length}`));
  const more = entries.length > SUMMARY_SHOWN ? `, … +${entries.length - SUMMARY_SHOWN}` : "";
  return `${name}: ${items.length}: ${entries.slice(0, SUMMARY_SHOWN).join(", ")}${more}`;
}

/** The agenda summary's group lines, without the head line or indent (BR-2529; the overview's `## 议程`, BR-2505). */
export function summaryLines(a: Agenda, now: number = Date.now()): string[] {
  const out: string[] = [];
  const d = a.delegate;
  if (d && d.changes.length > 0) out.push(d.room.room ? `${delegateHead(d)}: ${d.changes.slice(0, DELEGATE_SHOWN).map((c) => c.id).join(", ")}` : delegateHead(d));
  if (a.judge.length > 0) out.push(summaryGroup("judge", a.judge));
  if (a.owner.length > 0) out.push(summaryGroup("owner", a.owner));
  if (a.yours.length > 0) out.push(summaryGroup("yours", a.yours));
  const heavy = heavyLine(a.heavy, now);
  if (heavy) out.push(heavy);
  return out;
}

/** The agenda summary as brief, the landing and watch print it; empty for an empty agenda (BR-2529). */
export function summary(a: Agenda, now: number = Date.now()): string[] {
  const lines = summaryLines(a, now);
  return lines.length === 0 ? [] : ["Agenda (canon work due):", ...lines.map((l) => `  ${l}`)];
}

const itemJson = (it: DueItem) => ({ key: it.key, kind: it.kind, since: it.since, summary: it.summary, next: it.next });

/** The `--json` form (BR-2527). */
export function agendaJson(a: Agenda): Record<string, unknown> {
  const d = a.delegate;
  return {
    delegate: d ? { room: d.room.room, fits: d.room.fits, reasons: d.room.reasons, load: d.room.load ?? null, limit: d.room.limit ?? null, cpus: d.room.cpus ?? null, held: d.room.held, max: d.room.max, full_runs: d.room.fullRuns, changes: d.changes.map((c) => c.id), light: d.room.light, light_fits: lightFits(d), ready: d.ready.map((r) => ({ id: r.id, tier: r.tier, delegatable: r.delegatable, not_delegatable: r.notDelegatable, facts: r.facts })) } : null,
    judge: a.judge.map(itemJson),
    owner: a.owner.map(itemJson),
    yours: a.yours.map(itemJson),
    heavy: { running: a.heavy.running, waiting: a.heavy.waiting, load_waiting: a.heavy.loadWaiting },
  };
}

/** The calling session's items to handle, flat (BR-2527): the agenda's judge and owner groups, or a worker's own. */
export function dueItems(ws: Workspace, now: number = Date.now(), read?: Readings, slots?: Slots): Result<DueItem[]> {
  const a = agenda(ws, { now, ...(read ? { read } : {}), ...(slots ? { slots } : {}) });
  return a.ok ? ok(dueList(a.value)) : a;
}
