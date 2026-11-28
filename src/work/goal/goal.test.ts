import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";

// reason: each case spawns the CLI several times; a loaded machine takes seconds per run (as in overview.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const F = (n: number) => id("F", n);
const C = (n: number) => id("C", n);
const SESSION = "abcdef12-0000-4000-8000-000000000001";
const OTHER = "99999999-0000-4000-8000-000000000002";

/** canon as a Claude Code session `session` would run it; `session` null runs it outside any agent session. */
function canon(cwd: string, session: string | null, args: string[], stdin?: string) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: undefined, CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_THREAD_ID: undefined };
  if (session) Object.assign(env, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session });
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** The Stop hook as the host runs it for `session`, in `cwd`. */
const stop = (cwd: string, session = SESSION) => JSON.parse(canon(cwd, null, ["goal", "check", "--hook"], JSON.stringify({ session_id: session, hook_event_name: "Stop", stop_hook_active: false, cwd })).out) as { decision?: string; reason?: string; systemMessage?: string };

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
}

const release = (n: number, status: string, criteria: string, front = "") => `---\nid: ${R(n)}\ntitle: 版本${n}\nstatus: ${status}\n${front}---\n\n## 目标\n\n内容\n\n## 成功标准\n\n${criteria}\n`;
const feature = (n: number, criteria: string) => `---\nid: ${F(n)}\ntitle: 模块${n}\nstatus: active\n---\n\n## 目标\n\n内容\n\n## 成功标准\n\n${criteria}\n`;

describe("canon goal", () => {
  test("BR-2506 BR-2518: the brief of an agent session with a release in progress and no goal says how to turn goal mode on; not once it is on, not outside a session, not with no active release", () => {
    const HINT = "  goal mode is off for this session: canon goal start keeps it working toward these success criteria (canon goal stop ends it)";
    const root = project();
    write(root, { [`canon/releases/${R(5)}.md`]: release(5, "active", "- S1 甲（未满足）") });
    expect(canon(root, SESSION, ["brief"]).out.split("\n")).toContain(HINT);
    expect(canon(root, null, ["brief"]).out.split("\n")).not.toContain(HINT);
    expect(canon(root, SESSION, ["goal", "start"]).code).toBe(0);
    expect(canon(root, SESSION, ["brief"]).out.split("\n")).not.toContain(HINT);
    const planned = project();
    write(planned, { [`canon/releases/${R(6)}.md`]: release(6, "planned", "- S1 丙") });
    expect(canon(planned, SESSION, ["brief"]).out.split("\n")).not.toContain(HINT);
  });

  test("BR-2518: start takes the releases in progress or the ones named, stop ends it, a bare goal shows it; each session has its own", () => {
    const root = project();
    write(root, { [`canon/releases/${R(1)}.md`]: release(1, "shipped", "- x", `shipped_at: ${"a".repeat(40)}\n`), [`canon/releases/${R(5)}.md`]: release(5, "active", "- S1 甲（未满足）\n- S2 乙"), [`canon/releases/${R(6)}.md`]: release(6, "planned", "- S1 丙") });
    const started = canon(root, SESSION, ["goal", "start"]);
    expect([started.code, started.out.split("\n")[0]]).toEqual([0, `goal: ${R(5)}`]);
    expect(started.out).toContain(`${R(5)}  active  版本5  成功标准 2 条：已满足 0  未满足 1  待负责人 0  未证明 1`);
    expect(canon(root, SESSION, ["goal"]).out.split("\n")[0]).toBe(`goal: ${R(5)}`);
    expect(canon(root, OTHER, ["goal"]).out.trim()).toBe("no goal");
    expect(canon(root, SESSION, ["goal", "start", R(6)]).out.split("\n")[0]).toBe(`goal: ${R(6)}`);
    expect(JSON.parse(canon(root, SESSION, ["goal", "--json"]).out).releases).toEqual([R(6)]);
    expect(canon(root, SESSION, ["goal", "start", R(1)]).code).toBe(1);
    expect(canon(root, SESSION, ["goal", "start", R(99)]).code).toBe(3);
    expect(canon(root, SESSION, ["goal", "stop"]).out.trim()).toBe("goal stopped");
    expect(canon(root, SESSION, ["goal"]).out.trim()).toBe("no goal");
    expect(canon(root, SESSION, ["goal", "stop"]).out.trim()).toBe("no goal");
    expect(canon(root, null, ["goal", "start"]).code).toBe(2);
    const empty = project();
    expect(canon(empty, SESSION, ["goal", "start"]).code).toBe(1);
  });
});

describe("the Stop hook", () => {
  test("BR-2519: no goal (and the dispatch check off) lets the session stop; open criteria hold it with what is open, who advances it, the next step and the drift", () => {
    const root = project();
    write(root, {
      [`canon/releases/${R(5)}.md`]: release(5, "active", "- S1 负责人玩通。（待负责人）", `features: [${F(1)}]\n`),
      [`canon/features/${F(1)}.md`]: feature(1, "- S1 五个分支各有构筑通关。（未满足）\n- S2 有引导。（已满足：" + R(5) + "）"),
      [`canon/changes/${C(9)}.md`]: `---\nid: ${C(9)}\ntitle: 做\nstatus: open\nrules: []\nadvances: [${F(1)}/S1]\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`,
    });
    // reason: C-9 can start, so the dispatch check (BR-2655) would hold these stops; it has its own tests
    for (const who of [SESSION, OTHER]) canon(root, who, ["goal", "dispatch", "off"]);
    expect(stop(root)).toEqual({});
    canon(root, SESSION, ["goal", "start"]);
    const land = ws(root).db.db.query("INSERT INTO events(ts, actor, kind, subject, detail) VALUES (?, 'agent:a', 'land.ok', ?, '{}')");
    for (let n = 1; n <= 3; n++) land.run(`2026-11-16T0${n}:00:00.000Z`, C(20 + n));
    const held = stop(root);
    expect(held.decision).toBe("block");
    expect(held.reason!.split("\n")).toEqual([
      `Goal (canon goal): ${R(5)} not reached: 1 success criteria still unmet or unproven.`,
      `- ${F(1)}/S1 [未满足] 五个分支各有构筑通关。  (advanced by ${C(9)})`,
      "Next: continue a change that advances one of them, or start one with advances: [<doc>/S<k>]; land it, then stop again.",
      "Drift: 3 of the last 3 landed changes advance none of these criteria.",
    ]);
    expect(stop(root, OTHER)).toEqual({});
  });

  test("BR-2519: three stops in a row without progress let the session go and keep the goal; a change to the worktree in between resets the count", () => {
    const root = project();
    write(root, { [`canon/releases/${R(5)}.md`]: release(5, "active", "- S1 甲（未满足）") });
    canon(root, SESSION, ["goal", "start"]);
    expect(stop(root).decision).toBe("block");
    expect(stop(root).decision).toBe("block");
    expect(stop(root).decision).toBe("block");
    writeFileSync(join(root, "app.txt"), "changed\n");
    expect(stop(root).decision).toBe("block");
    for (let i = 0; i < 2; i++) expect(stop(root).decision).toBe("block");
    const let_go = stop(root);
    expect([let_go.decision, let_go.systemMessage]).toEqual([undefined, "goal: 3 continuations in a row without progress; stopping, the goal stays (canon goal stop ends it)"]);
    expect(canon(root, SESSION, ["goal"]).out.split("\n")[0]).toBe(`goal: ${R(5)}`);
    expect(stop(root).decision).toBe("block");
  });

  test("BR-2519: only the owner's criteria left lets it stop with the goal kept; everything met ends the goal; an unreadable project lets it stop", () => {
    const root = project();
    write(root, { [`canon/releases/${R(5)}.md`]: release(5, "active", "- S1 负责人玩通。（待负责人）\n- S2 甲（已满足：" + R(5) + "）") });
    canon(root, SESSION, ["goal", "start"]);
    expect(stop(root)).toEqual({ systemMessage: "goal: only the owner's acceptance is left: 1 criterion(s)" });
    write(root, { [`canon/releases/${R(5)}.md`]: release(5, "active", "- S1 负责人玩通。（已满足：" + R(5) + "）\n- S2 甲（已满足：" + R(5) + "）") });
    expect(stop(root)).toEqual({ systemMessage: `goal reached: ${R(5)}` });
    expect(canon(root, SESSION, ["goal"]).out.trim()).toBe("no goal");
    const outside = mkdtempSync(join(tmpdir(), "no-repo-"));
    const r = canon(outside, null, ["goal", "check", "--hook"], JSON.stringify({ session_id: SESSION }));
    expect([r.code, (JSON.parse(r.out) as { systemMessage: string }).systemMessage.startsWith("canon goal check failed:")]).toEqual([0, true]);
  });
});
