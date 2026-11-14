import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { currentActor } from "./workspace.ts";
import { project } from "./testkit.ts";

const MAIN = join(import.meta.dir, "../invocation/main.ts");
const envFor = (values: Record<string, string> = {}) => ({ ...process.env, CANON_ACTOR: "", CLAUDECODE: "", CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "", CODEX_SESSION_ID: "", CODEX_THREAD_ID: "", ...values });
const value = (r: ReturnType<typeof currentActor>) => r.ok ? r.value : `error:${r.error.code}`;
function cli(root: string, env: Record<string, string | undefined>, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("Codex coordination identity", () => {
  test("BR-2023: independent Codex sessions, Claude and a terminal keep distinct actors", () => {
    expect(value(currentActor(envFor({ CODEX_THREAD_ID: "session-a" })))).toBe("agent:codex-session-a");
    expect(value(currentActor(envFor({ CODEX_THREAD_ID: "session-b" })))).toBe("agent:codex-session-b");
    expect(value(currentActor(envFor({ CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: "session-a" })))).toBe("agent:codex-session-a");
    expect(value(currentActor(envFor({ CODEX_THREAD_ID: "session-a" }), "worker"))).toBe("agent:codex-session-a:worker");
    expect(value(currentActor(envFor({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "session-a" })))).toBe("agent:session-");
    expect(value(currentActor(envFor()))).toStartWith("human:");
    expect(value(currentActor(envFor({ CODEX_THREAD_ID: "session-a", CLAUDECODE: "1" })))).toBe("agent:codex-session-a");
  });

  test("BR-2023: Codex children retain the parent session and refuse a sibling's --as", () => {
    const env = envFor({ CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: "child-1" });
    expect(value(currentActor(env))).toBe("agent:codex-session-a:child-1");
    expect(value(currentActor(env, "child-1"))).toBe("agent:codex-session-a:child-1");
    expect(currentActor(env, "child-2").ok).toBe(false);
    expect(currentActor(envFor({ CODEX_THREAD_ID: "session-a", CANON_ACTOR: "human:alice" })).ok).toBe(false);
    expect(currentActor(envFor({ CODEX_THREAD_ID: "session-a", CANON_ACTOR: "agent:x" }), "child-1").ok).toBe(false);
    expect(currentActor(envFor(), "child-1").ok).toBe(false);
  });

  test("BR-2023 BR-2104: the CLI persists a Codex child identity and another session cannot stop its work", () => {
    const root = project();
    const child = envFor({ CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: "child-1" });
    const started = cli(root, child, "work", "start", "--title", "Codex child", "--as", "child-1");
    expect(started.code).toBe(0);
    const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
    const claim = db.query<{ holder: string; worktree: string }, []>("SELECT holder, worktree FROM claims").get()!;
    db.close();
    expect(claim.holder).toBe("agent:codex-session-a:child-1");
    const other = cli(claim.worktree, envFor({ CODEX_THREAD_ID: "session-b" }), "work", "stop", "--next", "attempt");
    expect(other.code).toBe(5);
    expect(other.err).toContain("claimed by agent:codex-session-a:child-1");
  });

  test("BR-2023: a Codex human override and a wrong child id refuse before writing coordination state", () => {
    for (const [values, extra] of [
      [{ CODEX_THREAD_ID: "session-a", CANON_ACTOR: "human:alice" }, []],
      [{ CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: "child-1" }, ["--as", "child-2"]],
    ] as const) {
      const root = project();
      const r = cli(root, envFor(values), "work", "start", "--title", "Refused", ...extra);
      expect(r.code).toBe(2);
      expect(existsSync(join(root, ".git/canon/state.db"))).toBe(false);
    }
  });

  test("BR-2100: a real Codex ancestor owns the claim; after it exits a different session can take it", () => {
    const root = project();
    mkdirSync(join(root, "bin"));
    // A real short-lived executable named codex exercises the OS process boundary without an AI request.
    const host = join(root, "bin/codex");
    symlinkSync("/bin/sh", host);
    const command = `"${process.execPath}" "${MAIN}" work start --title Liveness; code=$?; exit "$code"`;
    const r = Bun.spawnSync([host, "-c", command], { cwd: root, env: envFor({ CODEX_THREAD_ID: "liveness-a" }), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
    const claim = db.query<{ pid: number; subject: string }, []>("SELECT pid, subject FROM claims").get()!;
    db.close();
    expect(claim.pid).toBe(r.pid);
    const taken = cli(root, envFor({ CODEX_THREAD_ID: "liveness-b" }), "work", "start", claim.subject);
    expect(taken.code).toBe(0);
  });

  test("BR-2336: the Codex parent can take over its child's claim, but siblings and other sessions cannot", () => {
    const root = project();
    expect(cli(root, envFor({ CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: "child-1" }), "work", "start", "--title", "Child").code).toBe(0);
    const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
    const subject = db.query<{ subject: string }, []>("SELECT subject FROM claims").get()!.subject;
    expect(cli(root, envFor({ CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: "child-2" }), "work", "take", subject, "--from", "child-1").code).toBe(2);
    expect(cli(root, envFor({ CODEX_THREAD_ID: "session-b" }), "work", "take", subject, "--from", "child-1").code).toBe(5);
    expect(cli(root, envFor({ CODEX_THREAD_ID: "session-a" }), "work", "take", subject, "--from", "child-1").code).toBe(0);
    expect(db.query<{ holder: string }, []>("SELECT holder FROM claims").get()!.holder).toBe("agent:codex-session-a");
    db.close();
  });

  test("BR-2342: a Codex landing warns about the native missing identity hook; a terminal does not", () => {
    const root = project();
    const codex = cli(root, envFor({ CODEX_THREAD_ID: "session-a" }), "work", "land", "--finish");
    expect(codex.out).toContain(".codex/hooks.json has no canon check-as hook");
    expect(codex.out).not.toContain(".claude/settings.json has no canon check-as hook");
    const terminal = cli(root, envFor(), "work", "land", "--finish");
    expect(terminal.out).not.toContain("has no canon check-as hook");
  });

  test("BR-2023 BR-2276 BR-2289: native startup payloads bind a child with only CODEX_THREAD_ID to its parent", () => {
    const root = project();
    for (const input of [
      { hook_event_name: "SessionStart", session_id: "native-root", cwd: root, source: "startup" },
      { hook_event_name: "SubagentStart", session_id: "native-root", agent_id: "native-child", cwd: root, agent_type: "default" },
    ]) {
      const r = Bun.spawnSync([process.execPath, MAIN, "brief", "--hook", "--runtime", "codex"], { cwd: root, env: envFor(), stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
    }
    const repeat = Bun.spawnSync([process.execPath, MAIN, "brief", "--hook", "--runtime", "codex"], { cwd: root, env: envFor(), stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", session_id: "native-root" })), stdout: "pipe", stderr: "pipe" });
    expect(repeat.exitCode).toBe(0);
    expect(cli(root, envFor({ CODEX_THREAD_ID: "native-child" }), "work", "start", "--title", "Native child", "--as", "native-child").code).toBe(0);
    const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
    const claim = db.query<{ holder: string; subject: string }, []>("SELECT holder, subject FROM claims").get()!;
    expect(claim.holder).toBe("agent:codex-native-root:native-child");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind='session.codex'").get()!.n).toBe(2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind='session.codex' AND actor LIKE 'human:%'").get()!.n).toBe(0);
    expect(cli(root, envFor({ CODEX_THREAD_ID: "native-child" }), "human", "ask", "Ship it?", "--option", "yes,no").code).toBe(0);
    const response = { hook_event_name: "PostToolUse", session_id: "native-root", agent_id: "native-child", tool_name: "request_user_input", tool_input: { questions: [{ id: "ship", question: "Ship it?" }] }, tool_response: { answers: { ship: { answers: ["yes"] } } } };
    const recorded = Bun.spawnSync([process.execPath, MAIN, "human", "record", "--runtime", "codex"], { cwd: root, env: envFor(), stdin: Buffer.from(JSON.stringify(response)), stdout: "pipe", stderr: "pipe" });
    expect(recorded.exitCode).toBe(0);
    expect(db.query<{ actor: string }, []>("SELECT actor FROM events WHERE kind='human.asked'").get()!.actor).toBe("agent:codex-native-root:native-child");
    expect(cli(root, envFor({ CODEX_THREAD_ID: "native-child" }), "human", "answer", "1", "yes", "--relayed", "yes").code).toBe(0);
    expect(db.query<{ witness: string }, []>("SELECT witness FROM questions WHERE id=1").get()!.witness).toBe("match");
    expect(cli(root, envFor({ CODEX_THREAD_ID: "native-child" }), "human", "pending", "--all").out).toContain("the human's words match Claude Code's record");
    expect(cli(root, envFor({ CODEX_THREAD_ID: "native-root" }), "work", "take", claim.subject, "--from", "native-child").code).toBe(0);
    db.close();
  });

  test("BR-2023: malformed native startup refuses without state and still prints the workflow", () => {
    const root = project();
    const r = Bun.spawnSync([process.execPath, MAIN, "brief", "--hook", "--runtime", "codex"], { cwd: root, env: envFor(), stdin: Buffer.from('{"hook_event_name":"SubagentStart","session_id":"root"}'), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString()).toContain("How to work here");
    expect(existsSync(join(root, ".git/canon/state.db"))).toBe(false);
  });
});


test("BR-2023: corrupt recorded native relationships fail loudly before a new claim", () => {
  const root = project();
  const startup = Bun.spawnSync([process.execPath, MAIN, "brief", "--hook", "--runtime", "codex"], { cwd: root, env: envFor(), stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", session_id: "broken-root" })), stdout: "pipe", stderr: "pipe" });
  expect(startup.exitCode).toBe(0);
  const db = new Database(join(root, ".git/canon/state.db"));
  db.query("UPDATE events SET detail='not-json' WHERE kind='session.codex'").run();
  const broken = cli(root, envFor({ CODEX_THREAD_ID: "broken-root" }), "work", "start", "--title", "Refused");
  expect(broken.code).toBe(4);
  expect(broken.err).toContain("cannot read the Codex session relationship");
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claims").get()!.n).toBe(0);
  expect(cli(root, envFor({ CODEX_THREAD_ID: "independent" }), "work", "start", "--title", "Independent").code).toBe(0);
  db.close();
});
