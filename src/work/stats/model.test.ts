import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { project } from "../testkit.ts";

// reason: driven the way the hosts run it: the CLI with the hook input as JSON on stdin (BR-2531, BR-2532)
const CLI = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(): string {
  const root = project();
  roots.push(root);
  return root;
}

function run(root: string, args: string[], stdin = "", env: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_THREAD_ID: undefined, CANON_ACTOR: "human:t", ...env };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root, stdin: new Response(stdin), stdout: "pipe", stderr: "pipe", env: base as Record<string, string> });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function db(root: string): CoordDb {
  const path = CoordDb.pathFor(root);
  if (!path.ok) throw new Error(path.error.message);
  const opened = CoordDb.open(path.value, root);
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

function models(root: string): { actor: string; detail: Record<string, unknown> }[] {
  const d = db(root);
  try {
    return d.db.query<{ actor: string; detail: string }, []>("SELECT actor, detail FROM events WHERE kind = 'session.model' ORDER BY id").all().map((r) => ({ actor: r.actor, detail: JSON.parse(r.detail) }));
  } finally { d.db.close(); }
}

const claude = (event: string, extra: Record<string, unknown>) => JSON.stringify({ session_id: "3b9f74d5-5bc9-4f0c", hook_event_name: event, ...extra });

test("BR-2531: canon work model --hook records the Claude Code session's model at start and on a switch, says nothing, and records an unknown model with its reason", () => {
  const root = repo();
  const start = run(root, ["work", "model", "--hook"], claude("SessionStart", { model: "claude-opus-5-5" }));
  expect([start.code, start.out]).toEqual([0, ""]);
  expect(run(root, ["work", "model", "--hook"], claude("PostModelSwitch", { from_model: "claude-opus-5-5", to_model: "claude-sonnet-5-5" })).code).toBe(0);
  expect(run(root, ["work", "model", "--hook"], JSON.stringify({ session_id: "ffffffff-1", hook_event_name: "SessionStart" })).code).toBe(0);
  expect(models(root)).toEqual([
    { actor: "agent:3b9f74d5", detail: { host: "claude-code", model: "claude-opus-5-5", via: "SessionStart" } },
    { actor: "agent:3b9f74d5", detail: { host: "claude-code", model: "claude-sonnet-5-5", via: "PostModelSwitch" } },
    { actor: "agent:ffffffff", detail: { host: "claude-code", model: null, via: "SessionStart", reason: "SessionStart input had no model" } },
  ]);
});

test("BR-2531: a Codex Stop with the model already recorded writes nothing; a Codex subthread is its own actor; bad input exits 2 and writes nothing", () => {
  const root = repo();
  const stop = (extra: Record<string, unknown> = {}) => run(root, ["work", "model", "--hook", "--runtime", "codex"], JSON.stringify({ session_id: "s-1", hook_event_name: "Stop", model: "gpt-6.1", ...extra }));
  expect(stop().code).toBe(0);
  expect(stop().code).toBe(0);
  expect(stop({ hook_event_name: "SubagentStart", agent_id: "child-1" }).code).toBe(0);
  expect(models(root).map((m) => m.actor)).toEqual(["agent:codex-s-1", "agent:codex-s-1:child-1"]);
  expect(run(root, ["work", "model", "--hook"], "not json").code).toBe(2);
  expect(run(root, ["work", "model", "--hook"], JSON.stringify({ hook_event_name: "SessionStart", model: "m" })).code).toBe(2);
  expect(stop({ agent_id: "bad id" }).code).toBe(2);
  expect(models(root)).toHaveLength(2);
});

test("BR-2531: Codex's startup hook records the model from the same input it registers the session with", () => {
  const root = repo();
  const r = run(root, ["brief", "--hook", "--runtime", "codex"], JSON.stringify({ session_id: "s-9", hook_event_name: "SessionStart", model: "gpt-6.1" }), { CANON_ACTOR: undefined });
  expect(r.code).toBe(0);
  expect(models(root)).toEqual([{ actor: "agent:codex-s-9", detail: { host: "codex", model: "gpt-6.1", via: "SessionStart" } }]);
});

test("BR-2532: canon stats counts landings and refusals under the model the session had then, lists a subagent's borrowed model apart, and leaves --json unchanged", () => {
  const root = repo();
  const d = db(root);
  try {
    d.event("agent:old", "land.ok", "C-1", {});
    d.event("agent:aaaaaaaa", "session.model", "agent:aaaaaaaa", { host: "claude-code", model: "claude-opus-5-5", via: "SessionStart" });
    d.event("agent:aaaaaaaa", "land.ok", "C-2", {});
    d.event("agent:aaaaaaaa", "land.refuse", "C-3", {});
    d.event("agent:aaaaaaaa", "land.ok", "C-3", {});
    d.event("agent:aaaaaaaa:w1", "land.ok", "C-4", {});
    d.event("agent:aaaaaaaa", "session.model", "agent:aaaaaaaa", { host: "claude-code", model: "claude-sonnet-5-5", via: "PostModelSwitch" });
    d.event("agent:aaaaaaaa", "land.ok", "C-5", {});
  } finally { d.db.close(); }
  const r = run(root, ["stats"]);
  expect(r.code).toBe(0);
  const section = r.out.slice(r.out.indexOf("landings by host and model:")).split("\n\n")[0]!.split("\n").map((l) => l.trim().split(/\s{2,}/));
  expect(section).toEqual([
    ["landings by host and model:"],
    ["host", "model", "landed", "refused"],
    ["claude-code", "claude-opus-5-5", "2", "1"],
    ["-", "unknown: no record", "1", "0"],
    ["claude-code", "claude-opus-5-5 (session's)", "1", "0"],
    ["claude-code", "claude-sonnet-5-5", "1", "0"],
  ]);
  expect(run(root, ["stats", "--json"]).out).not.toContain("claude-opus");
  const last = Number(JSON.parse(run(root, ["events", "--json"]).out).at(-1).id);
  expect(run(root, ["stats", "--since", String(last)]).out).not.toContain("landings by host and model");
});
