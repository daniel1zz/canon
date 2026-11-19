import { sessionActor, type AgentRuntime } from "../../kernel/agent.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../db.ts";

/** Which host and model a session uses, as `session.model` events record it (BR-2531, D-137). */
export type Host = "claude-code" | "codex";
export interface ModelRecord {
  readonly host: Host;
  /** null when the hook input named no model; `reason` then says why. */
  readonly model: string | null;
  /** The hook event the record came from. */
  readonly via: string;
  readonly reason?: string;
}

const CHILD = /^[A-Za-z0-9_-]+$/;

/** The session actor and model a host hook's input names (BR-2531). */
export function modelFromHook(input: unknown, runtime: AgentRuntime): Result<{ actor: string; record: ModelRecord }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return err("invalid", "canon work model --hook needs the hook's JSON object on stdin");
  const o = input as Record<string, unknown>;
  const session = typeof o["session_id"] === "string" ? o["session_id"].trim() : "";
  if (!session) return err("invalid", "canon work model --hook: the hook input has no session_id");
  const via = o["hook_event_name"];
  if (typeof via !== "string") return err("invalid", "canon work model --hook: the hook input has no hook_event_name");
  // reason: Claude Code's PostModelSwitch names the new model to_model; every other input calls it model (BR-2531)
  const raw = o[runtime === "claude" && via === "PostModelSwitch" ? "to_model" : "model"];
  const model = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  const agent = runtime === "codex" && typeof o["agent_id"] === "string" && o["agent_id"] !== "" ? o["agent_id"] : undefined;
  if (agent !== undefined && !CHILD.test(agent)) return err("invalid", `canon work model --hook: agent_id ${JSON.stringify(agent)} may hold only letters, digits, - and _`);
  const record: ModelRecord = { host: runtime === "codex" ? "codex" : "claude-code", model, via, ...(model === null ? { reason: `${via} input had no model` } : {}) };
  return ok({ actor: sessionActor(runtime, session, agent), record });
}

/** Writes a `session.model` event unless the actor's latest one has the same host and model; true when it wrote (BR-2531). */
export function recordModel(db: CoordDb, actor: string, record: ModelRecord): boolean {
  return db.db.transaction(() => {
    const row = db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'session.model' AND subject = ? ORDER BY id DESC LIMIT 1").get(actor);
    if (row) {
      const last = JSON.parse(row.detail) as Partial<ModelRecord>;
      if (last.host === record.host && (last.model ?? null) === record.model) return false;
    }
    db.event(actor, "session.model", actor, { ...record });
    return true;
  }).immediate();
}

export interface ModelRow {
  readonly host: string;
  readonly model: string;
  readonly landed: number;
  readonly refused: number;
}

/**
 * Landings and refusals in (since, until], each under its actor's latest `session.model` before it; a subagent
 * (`agent:<session>:<name>`) without its own record falls back to its session's (BR-2532).
 */
export function landingsByModel(db: CoordDb, since: number, until: number): ModelRow[] {
  const rows = db.db
    .query<{ id: number; actor: string; kind: string; detail: string }, [number, number, number]>(
      "SELECT id, actor, kind, detail FROM events WHERE id <= ? AND (kind = 'session.model' OR (kind IN ('land.ok', 'land.refuse') AND id > ?)) AND id <= ? ORDER BY id",
    )
    .all(until, since, until);
  const latest = new Map<string, ModelRecord>();
  const counts = new Map<string, { host: string; model: string; landed: number; refused: number }>();
  for (const r of rows) {
    if (r.kind === "session.model") {
      latest.set(r.actor, JSON.parse(r.detail) as ModelRecord);
      continue;
    }
    const parent = /^(agent:[^:]+):/.exec(r.actor)?.[1];
    const own = latest.get(r.actor);
    const rec = own ?? (parent === undefined ? undefined : latest.get(parent));
    const host = rec?.host ?? "-";
    // reason: a Claude Code subagent records no model of its own and may run another one; marked so its share is visible before anyone tiers by model (BR-2532)
    const borrowed = own === undefined && rec !== undefined ? " (session's)" : "";
    const model = rec === undefined ? "unknown: no record" : `${rec.model ?? `unknown: ${rec.reason ?? "no model"}`}${borrowed}`;
    const key = `${host}\u0000${model}`;
    const c = counts.get(key) ?? { host, model, landed: 0, refused: 0 };
    if (r.kind === "land.ok") c.landed++;
    else c.refused++;
    counts.set(key, c);
  }
  return [...counts.values()].sort((a, b) => b.landed - a.landed || a.host.localeCompare(b.host) || a.model.localeCompare(b.model));
}

/** The `landings by host and model` section, or "" when the window has no landing event (BR-2532). */
export function renderLandingsByModel(rows: readonly ModelRow[]): string {
  if (rows.length === 0) return "";
  const h = Math.max(4, ...rows.map((r) => r.host.length));
  const m = Math.max(5, ...rows.map((r) => r.model.length));
  const line = (a: string, b: string, c: string, d: string) => `  ${a.padEnd(h)}  ${b.padEnd(m)}  ${c.padStart(6)}  ${d.padStart(7)}`;
  return ["landings by host and model:", line("host", "model", "landed", "refused"), ...rows.map((r) => line(r.host, r.model, String(r.landed), String(r.refused)))].join("\n") + "\n";
}
