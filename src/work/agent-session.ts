import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { agentSession, sessionActor } from "../kernel/agent.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { CoordDb } from "./db.ts";

type Session = NonNullable<ReturnType<typeof agentSession>>;

/** Native Codex shell tools expose a thread id; startup hooks provide its parent session (D-101). */
export function effectiveAgentSession(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Result<Session | undefined> {
  const context = agentSession(env);
  if (!context || context.runtime !== "codex" || env["CODEX_SESSION_ID"]?.trim()) return ok(context);
  const path = CoordDb.pathFor(cwd);
  if (!path.ok || !existsSync(path.value)) return ok(context);
  try {
    const db = new Database(path.value, { readonly: true });
    try {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) return ok(context);
      const row = db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind='session.codex' AND subject=? ORDER BY id DESC LIMIT 1").get(context.id);
      if (!row) return ok(context);
      const data: unknown = JSON.parse(row.detail);
      if (data === null || typeof data !== "object" || !("session" in data) || typeof data.session !== "string" || !("child" in data) || (data.child !== null && typeof data.child !== "string")) return err("io", "the recorded Codex session relationship is malformed");
      return ok({ runtime: "codex", id: data.session, ...(data.child ? { child: data.child } : {}) });
    } finally { db.close(); }
  } catch (e) { return err("io", `cannot read the Codex session relationship: ${(e as Error).message}`); }
}

/** Reuses the shared event log: no transcript parsing, extra database or guessed parent relationship. */
export function recordCodexStartup(cwd: string, raw: string, actorOverride?: string): Result<Session> {
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return err("invalid", "canon brief --hook needs Codex startup JSON on stdin"); }
  if (input === null || typeof input !== "object" || !("session_id" in input) || typeof input.session_id !== "string" || !input.session_id.trim() || !("hook_event_name" in input) || !["SessionStart", "SubagentStart"].includes(String(input.hook_event_name))) return err("invalid", "canon brief --hook needs a SessionStart or SubagentStart with a session_id");
  const child = "agent_id" in input && typeof input.agent_id === "string" && input.agent_id ? input.agent_id : undefined;
  if ((input.hook_event_name === "SubagentStart" && !child) || (child && !/^[A-Za-z0-9_-]+$/.test(child))) return err("invalid", "Codex SubagentStart needs a valid agent_id");
  const override = actorOverride?.trim();
  if (override && !override.startsWith("agent:")) return err("invalid", "a Codex startup hook can only act as agent:<name>");
  const context: Session = { runtime: "codex", id: input.session_id.trim(), ...(child ? { child } : {}) };
  const path = CoordDb.pathFor(cwd);
  if (!path.ok) return path;
  const opened = CoordDb.open(path.value, cwd);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    const subject = child ?? context.id;
    const detail = { session: context.id, child: child ?? null };
    db.db.transaction(() => {
      const row = db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind='session.codex' AND subject=? ORDER BY id DESC LIMIT 1").get(subject);
      if (row?.detail !== JSON.stringify(detail)) db.event(override || sessionActor("codex", context.id, child), "session.codex", subject, detail);
    }).immediate();
    return ok(context);
  } catch (e) { return err("io", `cannot record the Codex session relationship: ${(e as Error).message}`); }
  finally { db.db.close(); }
}
