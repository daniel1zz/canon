import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { preBash } from "./prebash.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const sub = { session_id: "3d606482-8b99", agent_id: "add88b47cf722ff32", agent_type: "general-purpose", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls\necho 'q' \"$X\"", timeout: 5000, description: "d" } };
const LINE = "export CANON_ACTOR='agent:3d606482:add88b47cf722ff32'";

function hook(stdin: string) {
  const r = Bun.spawnSync(["bun", MAIN, "hook", "pre-bash"], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() };
}

describe("canon hook pre-bash", () => {
  test("BR-2127: in a subagent the command gets one export line in front, byte for byte unchanged, and no permission decision", () => {
    const r = hook(JSON.stringify(sub));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...sub.tool_input, command: `${LINE}\n${sub.tool_input.command}` } } });
    expect(r.out).not.toContain("permissionDecision");
  });

  test("BR-2127: the main thread, invalid input or an unsafe id print nothing and exit 0", () => {
    const { agent_id: _, ...main } = sub;
    for (const input of [JSON.stringify(main), "not json", "", JSON.stringify({ ...sub, agent_id: "a';rm -rf x" }), JSON.stringify({ ...sub, session_id: "3d60'482" }), JSON.stringify({ ...sub, tool_input: { command: 1 } }), "[]"]) {
      const r = hook(input);
      expect([r.code, r.out]).toEqual([0, ""]);
    }
  });

  test("BR-2127: another tool, or a command that already carries the line, is left alone", () => {
    expect(preBash(JSON.stringify({ ...sub, tool_name: "Read" }))).toBeUndefined();
    expect(preBash(JSON.stringify({ ...sub, tool_input: { command: `${LINE}\nls` } }))).toBeUndefined();
    expect(preBash(JSON.stringify({ ...sub, tool_name: undefined }))).toContain(LINE);
  });

  test("BR-2127: the rewritten command exports the subagent's actor and still runs the original command", () => {
    const out = JSON.parse(preBash(JSON.stringify({ ...sub, tool_input: { command: "printf '%s|' \"$CANON_ACTOR\" 'it ran'" } }))!);
    const r = Bun.spawnSync(["/bin/bash", "-c", out.hookSpecificOutput.updatedInput.command], { stdout: "pipe" });
    expect(r.stdout.toString()).toBe("agent:3d606482:add88b47cf722ff32|it ran|");
  });
});
