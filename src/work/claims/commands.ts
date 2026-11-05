import { defineCommand } from "citty";
import { AS_ARG, entry, fail, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { readFileSync } from "node:fs";
import { runAsCheck } from "./as-hook.ts";
import { handOverClaim } from "./claims.ts";
import { sessionProcess } from "./liveness.ts";

/** `canon work take`: the main session takes back a claim its subagent held (BR-2336, D-62). */

const takeCmd = defineCommand({
  meta: { description: "Main session only: take over the claim of a subagent of this session (C-n --from <agent id>); the holder becomes this session" },
  args: {
    change: { type: "positional", required: true },
    from: { type: "string", required: true, description: "The subagent's agent id, the name its claim carries (agent:<session>:<id>)" },
    ...AS_ARG,
  },
  run({ args }) {
    // reason: a subagent takes nothing over, and the main session never passes --as (BR-2336, D-62)
    if (args.as !== undefined) fail({ code: "invalid", message: "`canon work take` is for the main session: do not pass --as" });
    const from = String(args.from);
    if (!/^[A-Za-z0-9_-]+$/.test(from)) fail({ code: "invalid", message: `--from ${JSON.stringify(from)}: an agent id is letters, digits, - and _ only` });
    const ws = workspace();
    if (!/^agent:[^:]+$/.test(ws.actor)) fail({ code: "invalid", message: `\`canon work take\` runs in the main session of a Claude Code conversation (actor agent:<session>), not as ${ws.actor}` });
    const change = String(args.change).toUpperCase();
    const r = handOverClaim(ws.db, change, ws.actor, from, ws.config.claimLeaseMs, sessionProcess());
    if (!r.ok) fail(r.error);
    say(`${change}: claim taken over from subagent ${from}; it is now held by ${ws.actor} in ${r.value.holder}`);
    say(`cd ${r.value.holder}`);
  },
});

/** `canon work check-as --hook`: the PreToolUse hook that checks `--as` on canon claim commands (BR-2340, D-62). */
const checkAsCmd = defineCommand({
  meta: { description: "Run by Claude Code's PreToolUse hook before each Bash call: refuse a canon work start, land, stop, drop or take whose --as does not match who runs it; reads the hook input on stdin" },
  args: { hook: { type: "boolean", description: "Read Claude Code's PreToolUse input from stdin (required)" } },
  run({ args }) {
    if (!args.hook) fail({ code: "invalid", message: "`canon work check-as` is run by Claude Code's PreToolUse hook: pass --hook, the hook input comes on stdin" });
    process.stdout.write(runAsCheck(readFileSync(0, "utf8"), process.cwd()));
  },
});

export const claimCommands: DomainCommands = { commands: [entry("take", 65, takeCmd, "work"), entry("check-as", 66, checkAsCmd, "work")] };
