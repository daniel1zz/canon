import { err, ok, type Result } from "./result.ts";

export type AgentRuntime = "claude" | "codex";
export const SKILL_DIRS = { claude: ".claude/skills", codex: ".agents/skills" } as const;
export const ROOT_INSTRUCTIONS = ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"] as const;

/** Host identity, shared by coordination commands and their hook records (D-101). */
export function agentSession(env: Record<string, string | undefined> = process.env): { runtime: AgentRuntime; id: string; child?: string } | undefined {
  const session = env["CODEX_SESSION_ID"]?.trim();
  const thread = env["CODEX_THREAD_ID"]?.trim();
  if (session || thread) return { runtime: "codex", id: session || thread!, ...(session && thread && session !== thread ? { child: thread } : {}) };
  if (env["CLAUDECODE"] === "1") return { runtime: "claude", id: env["CLAUDE_CODE_SESSION_ID"]?.trim() || "unknown" };
  return undefined;
}

export function sessionActor(runtime: AgentRuntime, session: string, child?: string): string {
  const id = runtime === "codex" ? `codex-${encodeURIComponent(session.trim())}` : session.trim().slice(0, 8);
  return `agent:${id}${child ? `:${child}` : ""}`;
}

export function readRuntime(value: unknown): Result<AgentRuntime> {
  if (value === undefined) return ok(agentSession()?.runtime ?? "claude");
  return value === "claude" || value === "codex" ? ok(value) : err("invalid", "--runtime must be claude or codex");
}

/** Native Codex root instructions remain reviewable when a project has an older explicit file list. */
export const standingInstructions = (configured: readonly string[]): string[] => [...new Set([...configured, ...ROOT_INSTRUCTIONS.slice(1)])];
