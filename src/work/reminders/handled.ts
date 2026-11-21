import { err, ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../workspace.ts";

/**
 * The main agent's outcome for an agenda item (BR-2583, D-151): handed to a change, deferred, or not done, recorded as a
 * `reminder.handled` event. The agenda leaves an item out while its latest outcome holds.
 */
export type OutcomeKind = "handed" | "deferred" | "not-doing";

export interface Outcome {
  readonly key: string;
  readonly outcome: OutcomeKind;
  readonly to: string | null;
  readonly reason: string | null;
  /** Deferred until, ISO 8601. */
  readonly until: string | null;
  /** The item's start when the outcome was recorded; null when it had none. */
  readonly since: string | null;
  readonly via: "handled" | "settles";
  /** When the outcome was recorded, ISO 8601. */
  readonly at: string;
}

/** Every key's latest outcome (BR-2583: the newest one counts), optionally only events in (since, until]. */
export function outcomes(ws: Workspace, range: { since?: number; until?: number } = {}): Map<string, Outcome> {
  const rows = ws.db.db
    .query<{ ts: string; subject: string; detail: string }, [number, number]>("SELECT ts, subject, detail FROM events WHERE kind = 'reminder.handled' AND subject IS NOT NULL AND id > ? AND id <= ? ORDER BY id")
    .all(range.since ?? 0, range.until ?? Number.MAX_SAFE_INTEGER);
  const out = new Map<string, Outcome>();
  for (const r of rows) {
    const d = JSON.parse(r.detail) as Partial<Record<string, unknown>>;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const kind = d["outcome"];
    if (kind !== "handed" && kind !== "deferred" && kind !== "not-doing") continue;
    out.set(r.subject, { key: r.subject, outcome: kind, to: str(d["to"]), reason: str(d["reason"]), until: str(d["until"]), since: str(d["since"]), via: d["via"] === "settles" ? "settles" : "handled", at: r.ts });
  }
  return out;
}

/**
 * Whether the outcome still keeps the item out (BR-2583): not when the item began again after it was recorded; a hand-over
 * while the change it went to is not closed; a deferral until its time; not doing for good.
 */
export function holds(o: Outcome, itemSince: string | null, closed: (change: string) => boolean, now: number): boolean {
  if (itemSince !== null && o.since !== null && Date.parse(itemSince) > Date.parse(o.since)) return false;
  if (itemSince !== null && o.since === null && Date.parse(itemSince) > Date.parse(o.at)) return false;
  switch (o.outcome) {
    case "handed": return o.to !== null && !closed(o.to);
    case "deferred": return o.until !== null && now < Date.parse(o.until);
    case "not-doing": return true;
  }
}

/** `30m`, `4h`, `2d` in milliseconds; undefined for anything else (BR-2583). */
export function duration(text: string): number | undefined {
  const m = /^([1-9]\d*)([mhd])$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

/** The agenda key of a failing main (BR-2527, BR-2601). */
export const RED_MAIN = "red-main";

export interface Recorded {
  readonly key: string;
  readonly line: string;
}

/**
 * Records one outcome for each key, all or none, in one write transaction (BR-2583). `open` is each key on the caller's
 * agenda now with its start; `changeOpen` says whether `--to`'s change exists and is not closed.
 */
export function recordOutcome(
  ws: Workspace,
  keys: readonly string[],
  what: { outcome: OutcomeKind; to?: string; reason?: string; forMs?: number },
  open: ReadonlyMap<string, string | null>,
  changeOpen: (id: string) => boolean,
  now: number,
  fixOnly: ReadonlySet<string> = new Set([RED_MAIN]),
): Result<Recorded[]> {
  // reason: a failing main is fixed, never put off or dropped (BR-2601, D-155); handing it to a fix change is still recorded
  if (what.outcome !== "handed" && keys.includes(RED_MAIN)) {
    ws.db.event(ws.actor, "reminder.handled.refuse", null, { reason: "red-main", outcome: what.outcome, keys: [...keys] });
    return err("refused", `${RED_MAIN} cannot be ${what.outcome === "deferred" ? "deferred" : "marked not doing"}: main failing cannot wait, it can only be fixed (canon work start --fix-main, or hand it to the fix change with --to <C-n>). Nothing was recorded`);
  }
  // reason: a P0 change must be done now; its interrupt is not put off or dropped either (BR-2606, D-155)
  const p0 = keys.filter((k) => k !== RED_MAIN && fixOnly.has(k));
  if (what.outcome !== "handed" && p0.length > 0) {
    ws.db.event(ws.actor, "reminder.handled.refuse", null, { reason: "p0", outcome: what.outcome, keys: [...keys] });
    return err("refused", `${p0.join(", ")} cannot be ${what.outcome === "deferred" ? "deferred" : "marked not doing"}: a P0 change must be done now; start it, delegate it, or have the owner lower its tier. Nothing was recorded`);
  }
  const missing = keys.filter((k) => !open.has(k));
  if (missing.length > 0) {
    ws.db.event(ws.actor, "reminder.handled.refuse", null, { reason: "not-on-agenda", keys: missing });
    return err("not_found", `not on your agenda now: ${missing.join(", ")}; canon work due lists its keys. Nothing was recorded`);
  }
  if (what.outcome === "handed" && !changeOpen(what.to!)) {
    ws.db.event(ws.actor, "reminder.handled.refuse", null, { reason: "change", to: what.to });
    return err("not_found", `${what.to} is not an open change; hand the item to an open one. Nothing was recorded`);
  }
  const until = what.forMs !== undefined ? new Date(now + what.forMs).toISOString() : null;
  const lines: Recorded[] = [];
  ws.db.db.transaction(() => {
    for (const key of keys) {
      ws.db.event(ws.actor, "reminder.handled", key, { outcome: what.outcome, to: what.to ?? null, reason: what.reason ?? null, until, since: open.get(key) ?? null, via: "handled" });
      const said = what.outcome === "handed" ? `handed to ${what.to}` : what.outcome === "deferred" ? `deferred until ${until}: ${what.reason}` : `not doing: ${what.reason}`;
      lines.push({ key, line: `handled ${key}: ${said}` });
    }
  }).immediate();
  return ok(lines);
}

/** `canon work start --settles` hands each finding to the change it opened (BR-2530, BR-2583). */
export function recordSettles(ws: Workspace, change: string, findings: readonly { id: number; openedAt: string }[]): void {
  for (const f of findings) ws.db.event(ws.actor, "reminder.handled", `finding:${f.id}`, { outcome: "handed", to: change, reason: null, until: null, since: f.openedAt, via: "settles" });
}
