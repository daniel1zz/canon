import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { currentActor } from "./workspace.ts";
import { project, startNew, ws } from "./testkit.ts";

const MAIN = join(import.meta.dir, "..", "invocation", "main.ts");

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

describe("actor through the CLI", () => {
  test("BR-2023: inside Claude Code, CANON_ACTOR=human:alice exits 2 and writes nothing", () => {
    const root = project();
    const env = { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "89d45e3f-b9c5", CANON_ACTOR: "human:alice" };
    const r = Bun.spawnSync([process.execPath, MAIN, "work", "start", "--title", "X"], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("agent:<name>");
    expect(existsSync(join(root, "canon/changes"))).toBe(false);
    const path = join(root, ".git/canon/state.db");
    if (existsSync(path)) {
      const db = new Database(path, { readonly: true });
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);
      db.close();
    }
  });

  test("BR-2023: a CANON_ACTOR of only spaces counts as unset", () => {
    expect(value(currentActor({ CANON_ACTOR: "   " }))).toBe(`human:${userInfo().username}`);
    expect(value(currentActor({ CANON_ACTOR: "   ", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "89d45e3f-b9c5" }))).toBe("agent:89d45e3f");
    expect(value(currentActor({ CANON_ACTOR: " agent:x " }))).toBe("agent:x");
  });
});

describe("worktree of an event", () => {
  test("BR-2131: canon work start in the primary checkout records the primary checkout on id.allocate and start.ok", () => {
    const root = project();
    startNew(root, "From main");
    const main = ws(root).root;
    const rows = ws(root).db.db.query<{ kind: string; worktree: string | null }, []>("SELECT kind, worktree FROM events WHERE kind IN ('id.allocate','start.ok') ORDER BY id").all();
    expect(rows).toEqual([
      { kind: "id.allocate", worktree: main },
      { kind: "start.ok", worktree: main },
    ]);
  });
});
