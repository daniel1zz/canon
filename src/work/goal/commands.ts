import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { readRuntime } from "../../kernel/agent.ts";
import { entry, fail, json, must, RUNTIME_ARG, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { openWorkspace } from "../workspace.ts";
import { setDispatch } from "./dispatch.ts";
import { checkGoal, goalActor, goalLines, goalOf, startGoal, stopGoal } from "./goal.ts";

/** `canon goal`: a session's goal mode, driven by the Stop hook (BR-2518, BR-2519, D-132). */

const actorOrFail = (): string => {
  const actor = must(goalActor());
  if (!actor) fail({ code: "invalid", message: "canon goal is for an agent session (Claude Code or Codex): run it inside one" });
  return actor;
};

const goal = defineCommand({
  meta: { description: "Goal mode for this session: with it on, the Stop hook keeps the session working toward the releases' success criteria (start, stop; no subcommand shows the goal); without a goal the Stop hook still names what the main session can do now (dispatch)" },
  args: { json: { type: "boolean" } },
  subCommands: {
    start: defineCommand({
      meta: { description: "Turn goal mode on for this session: the given releases, or the releases in progress" },
      args: { ids: { type: "positional", required: false, description: "Release ids (R-5 R-6); default: the releases in progress" } },
      run({ rawArgs }) {
        const ws = workspace();
        const ids = rawArgs.filter((a) => !a.startsWith("-"));
        for (const line of must(startGoal(ws, actorOrFail(), ids))) say(line);
      },
    }),
    stop: defineCommand({
      meta: { description: "Turn goal mode off for this session" },
      run() {
        say(must(stopGoal(workspace(), actorOrFail())));
      },
    }),
    dispatch: defineCommand({
      meta: { description: "The dispatch check at this session's stops (on by default): off when the owner asks to pause, on to resume; no argument shows it" },
      args: { to: { type: "positional", required: false, description: "on or off" } },
      run({ args }) {
        const to = args.to as string | undefined;
        if (to !== undefined && to !== "on" && to !== "off") fail({ code: "invalid", message: `canon goal dispatch takes on or off, not ${to}` });
        say(setDispatch(workspace(), actorOrFail(), to as "on" | "off" | undefined));
      },
    }),
    check: defineCommand({
      meta: { description: "The Stop hook: read the host's input from stdin and print the JSON that lets the session stop or keeps it working" },
      args: { ...RUNTIME_ARG, hook: { type: "boolean", description: "Read the Stop hook input from stdin (required)" } },
      run({ args }) {
        // reason: a Stop hook that fails must never trap the session; every path prints a JSON object and exits 0 (BR-2519)
        try {
          const rt = readRuntime(args.runtime);
          if (!rt.ok) throw new Error(rt.error.message);
          const runtime = rt.value;
          const input = readFileSync(0, "utf8");
          const cwd = (() => {
            try { const c = (JSON.parse(input) as { cwd?: unknown }).cwd; return typeof c === "string" && c !== "" ? c : process.cwd(); } catch { return process.cwd(); }
          })();
          const ws = openWorkspace(process.cwd());
          process.stdout.write(`${JSON.stringify(ws.ok ? checkGoal(ws.value, input, runtime, cwd) : { systemMessage: `canon goal check failed: ${ws.error.message}` })}\n`);
        } catch (e) {
          process.stdout.write(`${JSON.stringify({ systemMessage: `canon goal check failed: ${(e as Error).message}` })}\n`);
        }
        process.exit(0);
      },
    }),
  },
  run({ args, rawArgs }) {
    // reason: citty runs this after a subcommand too; only a bare `canon goal` shows the goal (BR-2518)
    if (rawArgs.some((a) => ["start", "stop", "check", "dispatch"].includes(a))) return;
    const ws = workspace();
    const g = goalOf(ws.db, actorOrFail());
    if (args.json) return json(g ? { releases: g.releases, started_at: g.startedAt } : null);
    if (!g) return say("no goal");
    for (const line of must(goalLines(ws, g))) say(line);
  },
});

export const goalCommands: DomainCommands = { commands: [entry("goal", 26, goal)] };
