/**
 * `canon hook pre-bash` (BR-2127, D-17): Claude Code runs it before every Bash call. A subagent's calls carry
 * `agent_id` in the hook input while the main thread's do not, and a subagent otherwise has exactly the main
 * thread's environment. The hook puts one line in front of a subagent's command,
 *
 *   export CANON_ACTOR='agent:<first 8 of session_id>:<agent_id>'
 *
 * so canon tells subagents apart (BR-2023). It returns only `updatedInput`, never a permission decision: an
 * "allow" would approve the whole command, the user's own part included.
 */
const SAFE = /^[A-Za-z0-9_-]+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The hook's stdout for one PreToolUse input, or undefined when the call must run unchanged (print nothing). */
export function preBash(stdin: string): string | undefined {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return undefined;
  }
  if (!isObject(input)) return undefined;
  const { agent_id: agent, session_id: session, tool_name: tool, tool_input: toolInput } = input;
  if (tool !== undefined && tool !== "Bash") return undefined;
  if (typeof agent !== "string" || !SAFE.test(agent)) return undefined;
  if (typeof session !== "string") return undefined;
  const short = session.trim().slice(0, 8);
  if (!SAFE.test(short)) return undefined;
  if (!isObject(toolInput) || typeof toolInput["command"] !== "string") return undefined;
  // reason: both parts match SAFE, so single quotes need no escaping and the line cannot run anything else (BR-2127).
  const line = `export CANON_ACTOR='agent:${short}:${agent}'`;
  const command = toolInput["command"];
  if (command.startsWith(`${line}\n`)) return undefined; // already prefixed, e.g. the hook is configured twice
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: `${line}\n${command}` } } });
}
