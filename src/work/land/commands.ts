import { defineCommand } from "citty";
import { AS_ARG, entry, EXIT, fail, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { LESSON_REMINDER } from "../session/session.ts";
import { redMainLandingLines } from "../watch/redmain.ts";
import { hookStatus } from "../../install/hook.ts";
import { land } from "./land.ts";
import { backgroundRun, landArgs, landInBackground, recordExit, stopLanding } from "./detach.ts";
import { STALL_LIMIT, unstall } from "./stall.ts";

/** `canon work land`. */

const landCmd = defineCommand({
  meta: { description: "Land this worktree's branch on main: queue → rebase → floor → canon check → main" },
  args: {
    finish: { type: "boolean", description: "Also close the change and release it" },
    timeout: { type: "string", description: "Minutes to wait in the queue (default: land_timeout_minutes, 60)" },
    stop: { type: "boolean", description: "Stop this worktree's landing running in the background; it gives its turn up" },
    ...AS_ARG,
  },
  async run({ args }) {
    const run = backgroundRun();
    const minutes = args.timeout === undefined ? undefined : Number(args.timeout);
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) fail({ code: "invalid", message: `--timeout must be a positive number of minutes, got ${JSON.stringify(args.timeout)}` });
    if (args.stop && (args.finish || args.timeout !== undefined)) fail({ code: "invalid", message: "--stop takes no other option than --as" });
    const ws = workspace(args.as);
    const timeoutMs = minutes === undefined ? ws.config.landTimeoutMs : minutes * 60_000;
    if (run === undefined) {
      if (args.stop) {
        const stopped = await stopLanding(ws);
        if (!stopped.ok) fail({ code: stopped.code, message: stopped.message });
        process.exit(stopped.code);
      }
      // reason: in Claude Code a project without the --as check hook has no protection for subagents; said here, where the agent lands (BR-2342, D-62)
      if (process.env["CLAUDECODE"] === "1") {
        const hooks = hookStatus(ws.root);
        if (hooks.ok && !hooks.value.checkAs) say("this project's .claude/settings.json has no canon check-as hook: --as is not checked for subagents; run canon update");
      }
      // The landing runs in its own background process; this one only follows it and exits with its code (D-80, BR-2390).
      process.exit(await landInBackground(ws, landArgs({ finish: Boolean(args.finish), timeout: args.timeout, as: args.as })));
    }
    if (args.stop) fail({ code: "invalid", message: "--stop is not for the background landing itself" });
    recordExit(run);
    const out = await land(ws, { finish: Boolean(args.finish), timeoutMs, guide: WORKFLOW_GUIDE, run }, say);
    if (out.kind === "landed") {
      for (const line of redMainLandingLines(ws.db)) say(line);
      if (out.finished) say(LESSON_REMINDER);
      return;
    }
    if (out.kind === "timeout") {
      console.error(`canon: still ${out.ahead} landing(s) ahead after ${timeoutMs / 60_000} min; run again${out.keepsPlaceUntil ? ` (this landing keeps its place in the queue until ${out.keepsPlaceUntil}: landing again from this worktree before then puts it back ahead of the landings queued after it)` : ""}`);
      process.exit(EXIT.timeout);
    }
    console.error(`canon: land refused (${out.reason}): ${out.message}`);
    for (const f of out.findings ?? []) console.error(`  ${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
    for (const line of redMainLandingLines(ws.db)) console.error(line);
    if (out.reason === "claimed") process.exit(EXIT.conflict);
    if (out.reason === "environment") process.exit(EXIT.env);
    process.exit(out.reason === "dirty" || out.reason === "on-main" || out.reason === "no-floor" || out.reason === "no-claim" ? EXIT.usage : EXIT.refused);
  },
});

/** `canon work unstall`: the main session or a person lets a subagent's change stopped by refusals land again (BR-2455). */
const unstallCmd = defineCommand({
  meta: { description: `Let a subagent's change refused ${STALL_LIMIT} times in a row land again (main session or a person only)` },
  args: {
    change: { type: "positional", required: true, description: "The stopped change (C-n)" },
    reason: { type: "string", description: "What the main agent did about the refusals" },
  },
  run({ args }) {
    const ws = workspace();
    const r = unstall(ws.db, ws.actor, String(args.change), typeof args.reason === "string" ? args.reason : "");
    if (!r.ok) fail({ code: r.code, message: r.message });
    say(`${String(args.change)} may land again; ${STALL_LIMIT} more refusals in a row stop it again`);
  },
});

export const landCommands: DomainCommands = { commands: [entry("land", 20, landCmd, "work"), entry("unstall", 21, unstallCmd, "work")] };
