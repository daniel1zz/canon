import { readRuntime } from "../../kernel/agent.ts";
import { defineCommand } from "citty";
import { AS_ARG, RUNTIME_ARG, entry, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { readFileSync } from "node:fs";
import { runAsCheck } from "./as-hook.ts";
import { handOverClaim } from "./claims.ts";
import { takeBack } from "../delegation/take.ts";
import { sessionProcess } from "./liveness.ts";
import { normalizeSubject } from "../session/subject.ts";

/**
 * `canon work take`: the design owner takes back a change it delegated, in any process (BR-2500, D-128); a claim of
 * this session's subagent with no delegation record goes back to the main session as before (BR-2336, D-62).
 */
const takeCmd = defineCommand({
  meta: { description: "Take back a claim: the design owner of a delegated change (C-n --from <worker name> [--stopped]), or the main session from its own subagent with no delegation" },
  args: {
    change: { type: "positional", required: true },
    from: { type: "string", required: true, description: "The worker's name, the last part of its actor agent:<session>:<name>" },
    stopped: { type: "boolean", description: "Delegated change only: you confirm the host or dispatch tool has stopped the worker, when canon cannot see that its process is gone" },
    ...AS_ARG,
  },
  run({ args }) {
    // reason: a subagent takes nothing over, and the main session never passes --as (BR-2336, D-62)
    if (args.as !== undefined) fail({ code: "invalid", message: "`canon work take` is for the main session: do not pass --as" });
    const from = String(args.from);
    if (!/^[A-Za-z0-9_-]+$/.test(from)) fail({ code: "invalid", message: `--from ${JSON.stringify(from)}: a worker name or agent id is letters, digits, - and _ only` });
    const ws = workspace();
    const change = normalizeSubject(String(args.change));
    const back = takeBack(ws.db, change, ws.actor, from, Boolean(args.stopped), ws.config.claimLeaseMs, sessionProcess());
    if (back) {
      if (!back.ok) fail(back.error);
      say(`${change}: taken back from worker ${from}${back.value.asserted ? " (stopped: asserted)" : ""}; the delegation has ended, epoch ${back.value.epoch}; it is now held by ${ws.actor} in ${back.value.worktree}`);
      say(`cd ${back.value.worktree}`);
      return;
    }
    // reason: a subagent claim with no delegation record is taken back whether or not it has stopped (BR-2336), so --stopped changes nothing here
    if (!/^agent:[^:]+$/.test(ws.actor)) fail({ code: "invalid", message: `\`canon work take\` runs in the main session of a Claude Code or Codex conversation (actor agent:<session>), not as ${ws.actor}` });
    const r = handOverClaim(ws.db, change, ws.actor, from, ws.config.claimLeaseMs, sessionProcess());
    if (!r.ok) fail(r.error);
    say(`${change}: claim taken over from subagent ${from}; it is now held by ${ws.actor} in ${r.value.holder}`);
    say(`cd ${r.value.holder}`);
  },
});

/** `canon work check-as --hook`: the PreToolUse hook that checks `--as` on canon claim commands (BR-2340, D-62). */
const checkAsCmd = defineCommand({
  meta: { description: "Run by the host's PreToolUse hook before each Bash call: refuse a canon work start, land, stop, drop or take whose --as does not match who runs it; reads the hook input on stdin" },
  args: { ...RUNTIME_ARG, hook: { type: "boolean", description: "Read the host's PreToolUse input from stdin (required)" } },
  run({ args }) {
    if (!args.hook) fail({ code: "invalid", message: "`canon work check-as` is run by the host's PreToolUse hook: pass --hook, the hook input comes on stdin" });
    process.stdout.write(runAsCheck(readFileSync(0, "utf8"), process.cwd(), must(readRuntime(args.runtime))));
  },
});

export const claimCommands: DomainCommands = { commands: [entry("take", 65, takeCmd, "work"), entry("check-as", 66, checkAsCmd, "work")] };
