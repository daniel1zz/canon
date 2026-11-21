import { existsSync } from "node:fs";
import { err, ok, type Result } from "../../kernel/result.ts";
import { claimsWithState } from "../claims/claims.ts";
import { readings } from "../delegation/capacity.ts";
import { isWorker } from "../delegation/worker.ts";
import { eventsSince, lastEventId, type EventRow } from "../stats/window.ts";
import type { Workspace } from "../workspace.ts";
import { agenda, DELEGATE_SHOWN, dueList, heavyLine, readyLine, summary, type Agenda, type Readings } from "./agenda.ts";
import { renderDue, workerSubjects } from "./due.ts";
import { runningFullRuns, type Slots } from "./heavy.ts";
import { roomOf } from "./room.ts";

/**
 * `canon work watch` (BR-2528, D-151): meant to run under a host's Monitor tool, where every line it prints reaches the
 * session as a message. So it prints only when something happens or changes: the agenda summary once, then the events
 * that concern the caller, the agenda's changes, the machine crossing its capacity threshold, and what can start after a
 * landing. Nothing is repeated on a timer (D-151 amends D-136).
 */

export const TICK_MS = 1000;
/** How often the agenda is worked out again with no event, to see what changes without one: a stall, a deferral ending (BR-2528). */
export const RECOMPUTE_MS = 60_000;
export const MAX_EVENTS_PER_TICK = 20;
/** The most new items said at once (BR-2528). */
export const MAX_NEW_ITEMS = 10;

/** The event kinds a main session hears about (BR-2528 point 2). */
const MAIN_KINDS = new Set(["land.ok", "land.refuse", "review.block", "handoff.write", "design.request", "human.ask", "human.answer", "claim.holder-gone", "claim.expired", "delegation.refuse"]);
/** The event kinds a worker hears about, on its own changes only (BR-2528 point 2, the worker items of BR-2527). */
const WORKER_KINDS = new Set(["land.ok", "land.refuse", "design.answer", "delegation.update", "claim.handover"]);
/** The events after which the agenda may differ, so it is worked out again at once (BR-2528 point 4). */
const CHANGES_STATE = /^(land\.|delegation\.|claim\.(take|release|expired|holder-gone|handover)|drop\.|change\.|review\.|finding\.|reminder\.handled$|test\.full\.|floor\.(pass|fail|flaky)|human\.|design\.|handoff\.|start\.ok$|accept\.)/;

export interface WatchIo {
  readonly out: (line: string) => void;
  readonly stopped: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly clock: () => number;
}

const isBusy = (e: unknown): boolean => /SQLITE_(BUSY|LOCKED)|database is locked/.test(String((e as { code?: string })?.code ?? "") + " " + String((e as Error)?.message ?? ""));

/** What to do about one event, at the end of its line. */
function nextFor(e: EventRow): string {
  const s = e.subject ?? "-";
  const d = e.detail;
  switch (e.kind) {
    case "land.ok": return `canon work after-land --wait ${s}`;
    case "land.refuse": return `canon events --subject ${s} --kind land.refuse`;
    case "review.block": return "canon work due";
    case "handoff.write": return "canon work status";
    case "design.request": return `canon work design-answer ${String(d["request"] ?? "<n>")} "<answer>"`;
    case "human.ask": return `ask the owner, then canon human answer ${String(d["id"] ?? "<n>")} "<answer>" --relayed "<their words>"`;
    case "human.answer": return "canon work due";
    case "claim.holder-gone":
    case "claim.expired": return "canon work status";
    case "delegation.refuse": return "canon work due";
    case "design.answer":
    case "delegation.update": return `canon work accept-design ${s}`;
    case "claim.handover": return `canon work stop --reason partial --next "<what is left>" --release`;
    default: return "canon work due";
  }
}

/** One event as a watch line: `#<id> <kind> <subject> <actor> <reason> → <next>`. */
export function eventLine(e: EventRow): string {
  const reason = typeof e.detail["reason"] === "string" ? ` ${e.detail["reason"]}` : "";
  return `#${e.id} ${e.kind} ${e.subject ?? "-"} ${e.actor}${reason} → ${nextFor(e)}`;
}

/** Whether an event concerns the caller (BR-2528 point 2). `own` is the worker's changes. */
function concerns(ws: Workspace, e: EventRow, own: ReadonlySet<string>): boolean {
  if (isWorker(ws.actor)) return WORKER_KINDS.has(e.kind) && e.subject !== null && own.has(e.subject) && e.actor !== ws.actor;
  if (!MAIN_KINDS.has(e.kind)) return false;
  // reason: a design request goes to its change's design owner only (BR-2499)
  if (e.kind === "design.request") return e.detail["owner"] === ws.actor;
  return true;
}

/** Every item of an agenda by key, each with the line `+` prints for it (BR-2528 point 4). */
function itemLines(a: Agenda, now: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of a.delegate?.ready ?? []) out.set(`ready:${r.id}`, [`+ delegate ${readyLine(r)}`, ...r.facts.map((f) => `    ${f}`)].join("\n"));
  for (const it of dueList(a)) out.set(it.key, `+ ${it.group} ${renderDue(it, now)}`);
  return out;
}

/** What the heavy line is about, without how long each has run: a change in it is said, a longer run is not (BR-2528). */
const heavyKey = (a: Agenda): string => `${a.heavy.running.map((r) => `${r.subject ?? "main"}@${r.since}`).sort().join(",")};${a.heavy.waiting}`;

export interface WatchDeps {
  readonly read?: Readings;
  readonly slots?: Slots;
}

/** Runs until `io.stopped()`; an error other than a busy database is said in a `watch stopped` line and returned (BR-2528 point 8). */
export async function watchDue(ws: Workspace, since: number | undefined, io: WatchIo, deps: WatchDeps = {}): Promise<Result<void>> {
  const read = deps.read ?? readings;
  const worker = isWorker(ws.actor);
  let cursor = 0;
  const file = ws.db.db.filename;
  const stop = (why: string, code: "io" | "invalid" | "conflict" | "not_found" | "refused" = "io"): Result<void> => {
    io.out(`watch stopped: ${why}; run canon work watch --since ${cursor} again`);
    return err(code, why);
  };
  // reason: SQLite keeps reading an unlinked database file, so a deleted coordination database is noticed only by looking (BR-2528 point 8)
  const gone = () => file !== "" && file !== ":memory:" && !existsSync(file);
  let own = new Set<string>();
  let busy = false;
  const recompute = (now: number): Result<Agenda> => {
    // reason: a claim lapse is an event only once some command judged it, so watching judges the claims each round (BR-2360, BR-2357)
    claimsWithState(ws.db);
    if (worker) own = new Set(workerSubjects(ws));
    return agenda(ws, { now, read, wasBusy: busy, ...(deps.slots ? { slots: deps.slots } : {}) });
  };
  /** The new events: the lines of those that concern the caller (at most MAX_EVENTS_PER_TICK, BR-2528 point 6), and whether any may change the agenda. */
  const pass = (): { lines: { line: string; landed?: string }[]; changed: boolean } => {
    // The upper bound is read first, so an event written between the two queries is picked up next round (as BR-2357).
    const until = lastEventId(ws.db);
    if (until <= cursor) return { lines: [], changed: false };
    const all = eventsSince(ws.db, { since: cursor, until, kinds: [] });
    const rows = all.filter((e) => concerns(ws, e, own));
    const shown = rows.slice(0, MAX_EVENTS_PER_TICK);
    const lines: { line: string; landed?: string }[] = shown.map((e) => ({ line: eventLine(e), ...(e.kind === "land.ok" && e.subject ? { landed: e.subject } : {}) }));
    if (rows.length > shown.length) lines.push({ line: `… ${rows.length - shown.length} more events: canon events --since ${shown.at(-1)!.id}` });
    cursor = until;
    return { lines, changed: all.some((e) => CHANGES_STATE.test(e.kind)) };
  };
  let prev: Agenda;
  try {
    cursor = since ?? lastEventId(ws.db);
    io.out(`watch from #${cursor}`);
    if (worker) own = new Set(workerSubjects(ws));
    // reason: after a re-arm the missed events come first, then the agenda as it is now (BR-2528 point 7)
    if (since !== undefined) for (const l of pass().lines) io.out(l.line);
    const first = recompute(io.clock());
    if (!first.ok) return stop(first.error.message, first.error.code);
    prev = first.value;
    for (const line of summary(prev, io.clock())) io.out(line);
    busy = prev.delegate !== null && !prev.delegate.room.room;
  } catch (e) {
    return stop(e instanceof Error ? e.message : String(e));
  }
  let recomputedAt = io.clock();
  while (!io.stopped()) {
    try {
      if (gone()) return stop(`the coordination database ${file} is gone`);
      const now = io.clock();
      const events = pass();
      if (events.changed || now - recomputedAt >= RECOMPUTE_MS) {
        recomputedAt = now;
        const next = recompute(now);
        if (!next.ok) return stop(next.error.message, next.error.code);
        const a = next.value;
        // reason: what can start because of a landing is said right after its land.ok line, whoever landed (BR-2528 point 3)
        const was = new Set(prev.startable);
        const fresh = a.startable.filter((id) => !was.has(id));
        const landed = events.lines.filter((l) => l.landed !== undefined);
        for (const l of events.lines) {
          io.out(l.line);
          if (!worker && fresh.length > 0 && l === landed.at(-1)) io.out(`${landed.map((x) => x.landed).join(", ")} landed; ${fresh.join(", ")} can start now`);
        }
        const before = itemLines(prev, now);
        const after = itemLines(a, now);
        for (const key of before.keys()) if (!after.has(key)) io.out(`- ${key}`);
        const added = [...after].filter(([key]) => !before.has(key));
        for (const [, line] of added.slice(0, MAX_NEW_ITEMS)) io.out(line);
        if (added.length > MAX_NEW_ITEMS) io.out(`… +${added.length - MAX_NEW_ITEMS} more: canon work due`);
        if (heavyKey(a) !== heavyKey(prev)) io.out(heavyLine(a.heavy, now) ?? "heavy: none");
        prev = a;
      } else {
        for (const l of events.lines) io.out(l.line);
      }
      // reason: the machine is read every second and said only when it crosses the threshold, with hysteresis (BR-2528 point 5)
      if (!worker && prev.delegate) {
        const heavy = runningFullRuns(deps.slots);
        if (!heavy.ok) return stop(heavy.error.message, heavy.error.code);
        const room = roomOf(ws, read(), prev.delegate.room.held, heavy.value.running.length, busy);
        if (busy && room.room) {
          busy = false;
          const ready = prev.delegate.changes.slice(0, DELEGATE_SHOWN).map((c) => c.id);
          io.out(`capacity room: room for ${room.fits} more${ready.length > 0 ? `; delegatable: ${ready.join(", ")}` : ""}`);
        } else if (!busy && !room.room) {
          busy = true;
          io.out(`capacity busy: ${room.reasons.join("; ")}; delegate no new worker`);
        }
      }
    } catch (e) {
      // reason: a landing can hold the write lock past the busy timeout; watching skips the round instead of ending (BR-2357, BR-2528)
      if (!isBusy(e)) return stop(e instanceof Error ? e.message : String(e));
    }
    if (io.stopped()) break;
    await io.sleep(TICK_MS);
  }
  return ok(undefined);
}
