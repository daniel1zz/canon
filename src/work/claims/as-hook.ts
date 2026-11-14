import { effectiveAgentSession } from "../agent-session.ts";
import { agentSession, type AgentRuntime } from "../../kernel/agent.ts";
import { openWorkspace } from "../workspace.ts";
import { checkCommand } from "./as-check.ts";
import { startedBySession } from "./liveness.ts";

/**
 * The PreToolUse hook `canon work check-as --hook` (BR-2340, D-62): reads Claude Code's hook input, returns what goes
 * to stdout: "" lets the call through, a `deny` object refuses it. It never rewrites the command and never returns
 * `allow`. A call it cannot check goes through with a `hook.skip` event (BR-2341); with only a systemMessage when
 * the event cannot be written either.
 */
export function runAsCheck(raw: string, fallbackCwd: string, runtime: AgentRuntime = agentSession()?.runtime ?? "claude"): string {
  let input: Record<string, unknown> | undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) input = v as Record<string, unknown>;
  } catch {
    // read below as bad input
  }
  const toolInput = input?.["tool_input"];
  const command = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>)["command"] : undefined;
  const cwd = typeof input?.["cwd"] === "string" && input["cwd"] !== "" ? input["cwd"] : fallbackCwd;
  if (typeof command !== "string") return skip("bad-input", "", cwd, undefined);
  // reason: almost every Bash call has no `canon` in it; those pass without reading anything else, so the hook costs one process start (D-62)
  if (!command.includes("canon")) return "";
  const context = runtime === "codex" ? effectiveAgentSession(process.env, cwd) : undefined;
  const agentId = typeof input?.["agent_id"] === "string" && input["agent_id"] !== "" ? input["agent_id"] : context?.ok ? context.value?.child : undefined;
  // reason: a Codex session gets its subagent from the session context; only a Claude Code session can be a worker started by another (BR-2468)
  const v = checkCommand(command, agentId, () => (runtime === "codex" ? false : workerByEnv(process.env) || startedBySession()));
  if (v.kind === "deny") return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: v.reason } })}\n`;
  if (v.kind === "skip") return skip(v.reason, v.sub, cwd, agentId);
  return "";
}

/** Records `hook.skip` and lets the call through; a failed record is said in a systemMessage instead (BR-2341). */
function skip(reason: string, sub: string, cwd: string, agentId: string | undefined): string {
  try {
    // the event names the subagent when the hook runs in a session that can carry the name (BR-2023), else the session
    const named = agentId === undefined ? undefined : openWorkspace(cwd, agentId);
    const ws = named?.ok ? named : openWorkspace(cwd);
    if (!ws.ok) return say(reason, `the event could not be recorded: ${ws.error.message}`);
    ws.value.db.event(ws.value.actor, "hook.skip", null, { reason, ...(sub === "" ? {} : { sub }) });
    return "";
  } catch (e) {
    return say(reason, `the event could not be recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A worker its launcher marked (BR-2468, D-114): `delegate run` sets CLAUDE_DELEGATE_CHILD=1 in the worker's environment,
 * which its hooks inherit; it holds when the launcher was detached from the session that started it and the process tree
 * no longer shows that session.
 */
export const workerByEnv = (env: Record<string, string | undefined>): boolean => env["CLAUDE_DELEGATE_CHILD"] === "1";

const say = (reason: string, why: string) => `${JSON.stringify({ systemMessage: `canon work check-as: --as was not checked for this Bash call (${reason}); ${why}` })}\n`;
