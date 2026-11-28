import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";

// reason: each case spawns the CLI several times; a loaded machine takes seconds per run (as in goal.test.ts)
setDefaultTimeout(90_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const SESSION = "abcdef12-0000-4000-8000-000000000011";
const OTHER = "99999999-0000-4000-8000-000000000012";
const ROOM = "normal,0.1,8";
const BUSY = "normal,100,8";
const C = (n: number) => ["C", n].join("-");

function canon(cwd: string, session: string | null, args: string[], opts: { stdin?: string; actor?: string; machine?: string } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: opts.actor, CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_THREAD_ID: undefined, CANON_MACHINE: opts.machine ?? ROOM };
  if (session) Object.assign(env, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session });
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin), env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

type Out = { decision?: string; reason?: string; systemMessage?: string };
/** The Stop hook as the host runs it for `session`, in `cwd`. */
const stop = (root: string, cwd = root, session = SESSION, opts: { actor?: string; machine?: string } = {}) =>
  JSON.parse(canon(root, null, ["goal", "check", "--hook"], { ...opts, stdin: JSON.stringify({ session_id: session, hook_event_name: "Stop", stop_hook_active: false, cwd }) }).out) as Out;

/** A project with one change that can start now, and a second worktree to stop in. */
function setup(): { root: string; wt: string } {
  const root = project();
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, `canon/changes/${C(5)}.md`), `---\nid: ${C(5)}\ntitle: 能开始的活\nstatus: open\nrules: []\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  const wt = `${root}.wt`;
  sh(root, "worktree", "add", "-q", wt);
  return { root, wt };
}

const holds = (root: string) => ws(root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'dispatch.hold'").get()!.n;

describe("dispatch check at a stop", () => {
  test("BR-2655: a change that can start holds the stop once; stopping again with nothing done lets it go; the next stop holds again; the session's own event holds it again, another session moving main does not", () => {
    const { root, wt } = setup();
    const first = stop(root, wt);
    expect(first.decision).toBe("block");
    const lines = first.reason!.split("\n");
    expect(lines[0]).toBe("Dispatch (canon work due): before stopping, act on what you can do now, or stop again to leave it:");
    expect(lines.some((l) => l.startsWith(`- ready:${C(5)} P2 - 能开始的活 → canon work start ${C(5)}`))).toBe(true);
    expect(lines.at(-1)).toBe("Waiting for the owner's answer or for running work: stop again. The owner asked to pause: canon goal dispatch off.");
    expect(holds(root)).toBe(1);
    expect(stop(root, wt)).toEqual({});
    expect(stop(root, wt).decision).toBe("block");
    ws(root).db.db.query("INSERT INTO events(ts, actor, kind, subject, detail) VALUES (?, ?, 'claim', NULL, '{}')").run(new Date().toISOString(), `agent:${SESSION.slice(0, 8)}:helper`);
    expect(stop(root, wt).decision).toBe("block");
    writeFileSync(join(root, "other.txt"), "x\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "another session landed");
    expect(stop(root, wt)).toEqual({});
  });

  test("BR-2655: no room and nothing to judge, a worker's stop, and the other session's own state each let the stop go", () => {
    const { root, wt } = setup();
    expect(stop(root, wt, SESSION, { machine: BUSY })).toEqual({});
    expect(stop(root, wt, SESSION, { actor: "agent:s:w1" })).toEqual({});
    expect(stop(root, wt).decision).toBe("block");
    expect(stop(root, wt, OTHER).decision).toBe("block");
  });

  test("BR-2660 BR-2655: dispatch off lets this session's stops go and not another's; on checks it again; a wrong argument or no session is a usage error", () => {
    const { root, wt } = setup();
    expect(canon(root, SESSION, ["goal", "dispatch"]).out.trim()).toBe("dispatch check: on");
    const off = canon(root, SESSION, ["goal", "dispatch", "off"]);
    expect([off.code, off.out.trim()]).toEqual([0, "dispatch check: off for this session (canon goal dispatch on turns it back on)"]);
    expect(canon(root, SESSION, ["goal", "dispatch"]).out.trim()).toBe("dispatch check: off for this session (canon goal dispatch on turns it back on)");
    expect(stop(root, wt)).toEqual({});
    expect(stop(root, wt, OTHER).decision).toBe("block");
    expect(canon(root, SESSION, ["goal", "dispatch", "on"]).out.trim()).toBe("dispatch check: on");
    expect(stop(root, wt).decision).toBe("block");
    expect(canon(root, SESSION, ["goal", "dispatch", "pause"]).code).toBe(2);
    expect(canon(root, null, ["goal", "dispatch", "off"]).code).toBe(2);
  });

  test("BR-2655 BR-2519: a goal that holds the session says only the goal, not the dispatch check", () => {
    const { root, wt } = setup();
    const R = ["R", 5].join("-");
    mkdirSync(join(root, "canon/releases"), { recursive: true });
    writeFileSync(join(root, `canon/releases/${R}.md`), `---\nid: ${R}\ntitle: 版本\nstatus: active\n---\n\n## 目标\n\n内容\n\n## 成功标准\n\n- S1 甲（未满足）\n`);
    sh(root, "add", `canon/releases/${R}.md`);
    sh(root, "commit", "-qm", "release");
    canon(root, SESSION, ["goal", "start"]);
    const held = stop(root, wt);
    expect(held.decision).toBe("block");
    expect(held.reason!.startsWith("Goal (canon goal):")).toBe(true);
    expect(held.reason).not.toContain("Dispatch");
  });
});
