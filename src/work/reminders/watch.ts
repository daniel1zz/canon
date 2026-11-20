import { existsSync } from "node:fs";
import { err, ok, type Result } from "../../kernel/result.ts";
import { claimsWithState } from "../claims/claims.ts";
import { readings } from "../delegation/capacity.ts";
import { isWorker } from "../delegation/worker.ts";
import { eventsSince, lastEventId, type EventRow } from "../stats/window.ts";
import type { Workspace } from "../workspace.ts";
import { dueItems, renderDue, workerSubjects, age, type DueItem, type Readings } from "./due.ts";

/**
 * `canon work watch` (BR-2528, D-136): meant to run under a host's Monitor tool, where every line it prints reaches the
 * session as a message. So it prints only what is worth handling: the due list once, then the events that concern the
 * caller, items that appear or go, and a `still` line for the items left open.
 */

export const TICK_MS = 1000;
export const RECOMPUTE_MS = 30_000;
export const MAX_EVENTS_PER_TICK = 20;
export const MAX_STILL_KEYS = 10;

/** The event kinds a main session hears about (BR-2528 point 2). */
const MAIN_KINDS = new Set(["land.ok", "land.refuse", "review.block", "handoff.write", "design.request", "human.ask", "human.answer", "claim.holder-gone", "claim.expired", "delegation.refuse"]);
/** The event kinds a worker hears about, on its own changes only (BR-2528 point 2, the worker items of BR-2527). */
const WORKER_KINDS = new Set(["land.ok", "land.refuse", "design.answer", "delegation.update", "claim.handover"]);

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

/** Runs until `io.stopped()`; an error other than a busy database is said in a `watch stopped` line and returned (BR-2528 point 7). */
export async function watchDue(ws: Workspace, since: number | undefined, io: WatchIo, read: Readings = readings, remindEveryMs: number = ws.config.remindEveryMs): Promise<Result<void>> {
  let cursor = 0;
  const file = ws.db.db.filename;
  const stop = (why: string, code: "io" | "invalid" | "conflict" | "not_found" | "refused" = "io"): Result<void> => {
    io.out(`watch stopped: ${why}; run canon work watch --since ${cursor} again`);
    return err(code, why);
  };
  // reason: SQLite keeps reading an unlinked database file, so a deleted coordination database is noticed only by looking (BR-2528 point 7)
  const gone = () => file !== "" && file !== ":memory:" && !existsSync(file);
  // When each open item was first seen and last said, by key: `still` counts from the last saying, `capacity` ages from its first sighting.
  const seen = new Map<string, number>();
  const said = new Map<string, number>();
  let items = new Map<string, DueItem>();
  let own = new Set<string>();
  const recompute = (): Result<DueItem[]> => {
    // reason: a claim lapse is an event only once some command judged it, so watching judges the claims each round (BR-2360, BR-2357)
    claimsWithState(ws.db);
    if (isWorker(ws.actor)) own = new Set(workerSubjects(ws));
    return dueItems(ws, io.clock(), read);
  };
  /** Prints the new events that concern the caller, at most MAX_EVENTS_PER_TICK of them (BR-2528 point 5). */
  const pass = (): void => {
    // The upper bound is read first, so an event written between the two queries is picked up next round (as BR-2357).
    const until = lastEventId(ws.db);
    if (until <= cursor) return;
    const rows = eventsSince(ws.db, { since: cursor, until, kinds: [] }).filter((e) => concerns(ws, e, own));
    const shown = rows.slice(0, MAX_EVENTS_PER_TICK);
    for (const e of shown) io.out(eventLine(e));
    if (rows.length > shown.length) io.out(`… ${rows.length - shown.length} more events: canon events --since ${shown.at(-1)!.id}`);
    cursor = until;
  };
  try {
    cursor = since ?? lastEventId(ws.db);
    io.out(`watch from #${cursor}`);
    if (isWorker(ws.actor)) own = new Set(workerSubjects(ws));
    // reason: after a re-arm the missed events come first, then the due list as it is now (BR-2528 point 6)
    if (since !== undefined) pass();
    const first = recompute();
    if (!first.ok) return stop(first.error.message, first.error.code);
    for (const it of first.value) {
      seen.set(it.key, io.clock());
      said.set(it.key, io.clock());
      io.out(`due ${renderDue(it, io.clock(), io.clock())}`);
    }
    items = new Map(first.value.map((it) => [it.key, it]));
  } catch (e) {
    return stop(e instanceof Error ? e.message : String(e));
  }
  let recomputedAt = io.clock();
  while (!io.stopped()) {
    try {
      if (gone()) return stop(`the coordination database ${file} is gone`);
      pass();
      const now = io.clock();
      if (now - recomputedAt >= RECOMPUTE_MS) {
        recomputedAt = now;
        const next = recompute();
        if (!next.ok) return stop(next.error.message, next.error.code);
        const fresh = new Map(next.value.map((it) => [it.key, it]));
        for (const key of items.keys()) {
          if (fresh.has(key)) continue;
          io.out(`done ${key}`);
          seen.delete(key);
          said.delete(key);
        }
        for (const [key, it] of fresh) {
          if (items.has(key)) continue;
          seen.set(key, now);
          said.set(key, now);
          io.out(`due ${renderDue(it, now, now)}`);
        }
        items = fresh;
      }
      const owed = [...items.values()].filter((it) => now - (said.get(it.key) ?? now) >= remindEveryMs);
      if (owed.length > 0) {
        const listed = owed.slice(0, MAX_STILL_KEYS).map((it) => `${it.key} ${age(now - (it.since === "now" ? (seen.get(it.key) ?? now) : Date.parse(it.since)))}`);
        const more = owed.length > MAX_STILL_KEYS ? ` … and ${owed.length - MAX_STILL_KEYS} more: canon work due` : "";
        io.out(`still ${listed.join(", ")}${more}`);
        for (const it of owed) said.set(it.key, now);
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
