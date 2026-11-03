import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { currentActor } from "./workspace.ts";

const value = (r: ReturnType<typeof currentActor>) => (r.ok ? r.value : `error:${r.error.code}`);

describe("actor", () => {
  test("BR-2023: explicit agent actor, else the Claude Code session, else the OS user as a human", () => {
    expect(value(currentActor({ CANON_ACTOR: "agent:x", CLAUDECODE: "1" }))).toBe("agent:x");
    expect(value(currentActor({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "89d45e3f-b9c5-4e23" }))).toBe("agent:89d45e3f");
    expect(value(currentActor({ CLAUDECODE: "1" }))).toBe("agent:unknown");
    expect(value(currentActor({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "  " }))).toBe("agent:unknown");
    expect(value(currentActor({}))).toBe(`human:${userInfo().username}`);
    expect(value(currentActor({ CANON_ACTOR: "human:alice" }))).toBe("human:alice");
  });

  test("BR-2023: a subagent is the session's actor, and a CANON_ACTOR with colons is an opaque name", () => {
    const session = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "3d606482-8b99" };
    expect(value(currentActor(session))).toBe("agent:3d606482"); // main thread and subagents alike: same environment
    expect(value(currentActor({ ...session, CANON_ACTOR: "agent:89d45e3f:add88b47" }))).toBe("agent:89d45e3f:add88b47");
    expect(value(currentActor({ CANON_ACTOR: "agent:89d45e3f:add88b47" }))).toBe("agent:89d45e3f:add88b47");
  });

  test("BR-2023: an agent session cannot act as a human", () => {
    expect(value(currentActor({ CANON_ACTOR: "human:alice", CLAUDECODE: "1" }))).toBe("error:invalid");
  });
});
