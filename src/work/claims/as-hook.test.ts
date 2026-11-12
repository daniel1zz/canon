import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { CoordDb } from "../db.ts";
import { CHECK_AS_COMMAND } from "../../install/hook.ts";
import { project } from "../testkit.ts";

// reason: the hook is driven the way Claude Code runs it: `canon work check-as --hook` with the hook input as JSON on stdin (BR-2340, D-62).
const CLI = join(import.meta.dir, "../../invocation/main.ts");
const SESSION = "s1abcdef-0000";

async function hook(stdin: string, cwd: string, env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PID: undefined, ...env };
  delete base["CANON_ACTOR"];
  const p = Bun.spawn(["bun", CLI, "work", "check-as", "--hook"], { cwd, stdin: new Response(stdin), stdout: "pipe", stderr: "pipe", env: base as Record<string, string> });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const input = (command: string, cwd: string, agentId?: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command }, ...(agentId ? { agent_id: agentId } : {}) });

const events = (root: string): { actor: string; reason?: string; sub?: string }[] => {
  const path = CoordDb.pathFor(root);
  if (!path.ok || !existsSync(path.value)) return [];
  const db = CoordDb.open(path.value, root);
  if (!db.ok) throw new Error(db.error.message);
  return db.value.db.query<{ actor: string; detail: string }, []>("SELECT actor, detail FROM events WHERE kind = 'hook.skip' ORDER BY id").all().map((e) => ({ actor: e.actor, ...(JSON.parse(e.detail) as Record<string, string>) }));
};

/** Subagent `a1` (agent id) or the main session (undefined). */
const A1 = "a1";
const denied = (out: string) => (out === "" ? undefined : (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string; hookEventName: string } }).hookSpecificOutput);

const root = project();

type Case = [label: string, command: string, agent: string | undefined, reasonHas: string | undefined];

const CASES: Case[] = [
  // the triggering sides
  ["subagent land without --as is refused with the id to use", "canon work land --finish", A1, "--as a1"],
  ["subagent land --as a1 passes", "canon work land --as a1 --finish", A1, undefined],
  ["subagent land --as=a1 passes", "canon work land --as=a1", A1, undefined],
  ["subagent land --as with another id is refused and says what it got", "canon work land --as b2", A1, "Got --as 'b2'"],
  ["main session land --as is refused", "cd /x && canon work land --as abc", undefined, "--as is only for subagents"],
  ["main session land without --as passes", "cd /x && canon work land", undefined, undefined],
  ["a second segment after ; is checked", "cd /x; canon work stop --release --next y", A1, "--as a1"],
  ["the segment after a pipe and ; is checked", "canon work test | tail -5; canon work land", A1, "--as a1"],
  ["a claim command on a later line is checked: subagent take refused", "ls\ncanon work take C-5 --from abc", A1, "canon work take is for the main session only"],
  ["a claim command on a later line: main session take passes", "ls\ncanon work take C-5 --from abc", undefined, undefined],
  ["subagent take with --as is refused too", "canon work take C-5 --from abc --as a1", A1, "canon work take is for the main session only"],
  ["subagent unstall, with or without --as, is refused", "canon work unstall C-5 --reason x", A1, "canon work unstall is for the main session only"],
  ["main session unstall without --as passes", "canon work unstall C-5 --reason x", undefined, undefined],
  ["CANON_ACTOR prefix is refused for a subagent", "CANON_ACTOR=agent:x:y canon work land", A1, "do not set CANON_ACTOR"],
  ["CANON_ACTOR prefix is refused for the main session", "CANON_ACTOR=agent:x:y canon work land", undefined, "do not set CANON_ACTOR"],
  ["an absolute canon path counts", "/usr/local/bin/canon work land", A1, "--as a1"],
  ["a time prefix and a subshell are looked through", "time canon work land", A1, "--as a1"],
  ["a subshell paren is looked through", "(cd x && canon work land)", A1, "--as a1"],
  ["a quoted --as is not the option", 'canon work land "--as a1"', A1, "--as a1"],
  ["--as with no value is refused", "canon work land --as", A1, "Got --as ''"],
  ["a && inside quotes does not split: only the real second segment counts and it is right", 'git commit -m "a && canon work land" && canon work land --as a1', A1, undefined],
  ["start and drop are checked like land", "canon work start --title x", A1, "canon work start --as a1"],
  ["one wrong segment among several refuses the call", "canon work land --as a1 && canon work stop --next x", A1, "--as a1"],
  // the non-triggering sides
  ["commit message mentioning the command passes", 'git commit -m "fix: canon work land refused"', A1, undefined],
  ["echo of the command passes", 'echo "canon work land"', A1, undefined],
  ["grep for the command passes", 'grep "canon work land" notes.md', A1, undefined],
  ["heredoc body mentioning the command passes", "git commit -F- <<EOF\ncanon work land\nEOF", A1, undefined],
  ["comment mentioning the command passes", "# canon work land", A1, undefined],
  ["grep of a decision file passes", "cat canon/decisions/D-62.md | grep 'canon work take'", A1, undefined],
  ["status is not a checked subcommand", "canon work status", A1, undefined],
  ["test is not a checked subcommand", "canon work test", A1, undefined],
  ["a command with no canon in it passes", "ls -la", A1, undefined],
];

describe("the hook refuses canon claim commands with the wrong --as (BR-2340)", () => {
  for (const [label, command, agent, reasonHas] of CASES) {
    test(`BR-2340: ${label}`, async () => {
      const r = await hook(input(command, root, agent), root);
      expect(r.code).toBe(0);
      const d = denied(r.out);
      if (reasonHas === undefined) {
        expect(r.out).toBe("");
      } else {
        expect(d?.permissionDecision).toBe("deny");
        expect(d?.hookEventName).toBe("PreToolUse");
        expect(d?.permissionDecisionReason).toContain(reasonHas);
        // never rewrites, never allows
        expect(r.out).not.toContain("updatedInput");
        expect(r.out).not.toContain('"allow"');
      }
    });
  }

  test("BR-2340 BR-2455: a subagent's canon work unstall is refused with or without its own --as, and the reason says to tell the main session", async () => {
    for (const command of ["canon work unstall C-5 --reason x", "canon work unstall C-5 --reason x --as a1"]) {
      const d = denied((await hook(input(command, root, A1), root)).out);
      expect([d?.permissionDecision, d?.permissionDecisionReason.includes("report the refusals to the main session")]).toEqual(["deny", true]);
    }
  });

  test("BR-2340: a deny names the subagent's real agent id in the way to re-run", async () => {
    const r = await hook(input("canon work land", root, "af46bebbe7bc17e68"), root);
    expect(denied(r.out)?.permissionDecisionReason).toContain("--as af46bebbe7bc17e68");
  });

  test("BR-2340: a call with no canon in it opens no coordination database", async () => {
    const bare = mkdtempSync(join(tmpdir(), "canon-nodb-"));
    expect((await hook(input("ls", bare, A1), bare)).out).toBe("");
    expect(events(bare)).toEqual([]);
  });
});

describe("a call the hook cannot check passes and is recorded (BR-2341)", () => {
  for (const [label, command, sub] of [
    ["sh -c", 'sh -c "canon work land"', "land"],
    ["eval", 'eval "canon work stop"', "stop"],
    ["xargs", "echo C-1 | xargs canon work land", "land"],
    ["a $() assignment", "x=$(canon work land)", "land"],
  ] as const) {
    test(`BR-2341: ${label} passes with a hook.skip naming the subcommand`, async () => {
      const dir = project();
      const r = await hook(input(command, dir, A1), dir);
      expect([r.code, r.out]).toEqual([0, ""]);
      expect(events(dir)).toEqual([{ actor: `agent:s1abcdef:${A1}`, reason: "unparsable", sub }]);
    });
  }

  test("BR-2341: an unreadable call next to a correct one is recorded; next to a wrong one it is refused and not recorded", async () => {
    const dir = project();
    const ok = await hook(input('sh -c "canon work stop" ; canon work land --as a1', dir, A1), dir);
    expect(ok.out).toBe("");
    expect(events(dir).length).toBe(1);
    const bad = await hook(input('sh -c "canon work stop" ; canon work land --as b2', dir, A1), dir);
    expect(denied(bad.out)?.permissionDecision).toBe("deny");
    expect(events(dir).length).toBe(1);
  });

  test("BR-2341: a plain mention is not recorded, and neither is a script the hook cannot see into", async () => {
    const dir = project();
    for (const c of ['echo "canon work land"', 'git commit -m "canon work land"', "bash run.sh"]) expect((await hook(input(c, dir, A1), dir)).out).toBe("");
    expect(events(dir)).toEqual([]);
  });

  test("BR-2341: input that is not JSON passes with a bad-input record", async () => {
    const dir = project();
    const r = await hook("not json", dir);
    expect([r.code, r.out]).toEqual([0, ""]);
    expect(events(dir).map((e) => e.reason)).toEqual(["bad-input"]);
  });

  test("BR-2341: when the event cannot be written the call passes with a systemMessage naming the reason, and nothing is recorded", async () => {
    const bare = mkdtempSync(join(tmpdir(), "canon-nogit-"));
    const r = await hook(input('sh -c "canon work land"', bare, A1), bare);
    expect(r.code).toBe(0);
    const m = JSON.parse(r.out) as { systemMessage: string };
    expect(m.systemMessage).toContain("unparsable");
    expect(m.systemMessage).toContain("--as was not checked");
  });

  test("BR-2341: a hook command that fails prints the systemMessage and exits 0 through its || echo", () => {
    const r = Bun.spawnSync(["/bin/sh", "-c", CHECK_AS_COMMAND], { env: { PATH: "/nonexistent" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("systemMessage");
    expect(r.stdout.toString()).toContain("canon is not on PATH");
  });
});

describe("the check-as command itself", () => {
  test("BR-2340: without --hook it is a usage error", async () => {
    const p = Bun.spawn(["bun", CLI, "work", "check-as"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2);
  });
});
