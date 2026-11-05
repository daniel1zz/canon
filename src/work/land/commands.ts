import { defineCommand } from "citty";
import { AS_ARG, entry, EXIT, fail, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { LESSON_REMINDER } from "../session/session.ts";
import { redMainLandingLines } from "../watch/redmain.ts";
import { hookStatus } from "../../install/hook.ts";
import { land } from "./land.ts";

/** `canon work land`. */

const landCmd = defineCommand({
  meta: { description: "Land this worktree's branch on main: queue → rebase → floor → canon check → main" },
  args: { finish: { type: "boolean", description: "Also close the change and release it" }, timeout: { type: "string", description: "Minutes to wait in the queue (default: land_timeout_minutes, 60)" }, ...AS_ARG },
  async run({ args }) {
    const minutes = args.timeout === undefined ? undefined : Number(args.timeout);
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) fail({ code: "invalid", message: `--timeout must be a positive number of minutes, got ${JSON.stringify(args.timeout)}` });
    const ws = workspace(args.as);
    const timeoutMs = minutes === undefined ? ws.config.landTimeoutMs : minutes * 60_000;
    // reason: in Claude Code a project without the --as check hook has no protection for subagents; said here, where the agent lands (BR-2342, D-62)
    if (process.env["CLAUDECODE"] === "1") {
      const hooks = hookStatus(ws.root);
      if (hooks.ok && !hooks.value.checkAs) say("this project's .claude/settings.json has no canon check-as hook: --as is not checked for subagents; run canon update");
    }
    const out = await land(ws, { finish: Boolean(args.finish), timeoutMs, guide: WORKFLOW_GUIDE }, say);
    if (out.kind === "landed") {
      for (const line of redMainLandingLines(ws.db)) say(line);
      if (out.finished) say(LESSON_REMINDER);
      return;
    }
    if (out.kind === "timeout") {
      console.error(`canon: still ${out.ahead} landing(s) ahead after ${timeoutMs / 60_000} min; run again`);
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

export const landCommands: DomainCommands = { commands: [entry("land", 20, landCmd, "work")] };
