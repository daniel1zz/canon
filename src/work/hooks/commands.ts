import { defineCommand } from "citty";
import { entry, EXIT, fail, json, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { describeAttempt, openAttempts } from "../land/queue/interrupted.ts";
import { AFTER_LAND_WAIT_MS, batchState, renderAfterLand, settleBackgroundHooks, waitBackgroundHooks } from "./hooks.ts";

/** `canon work after-land`: the background after_land commands of a landing (BR-2166). */

const afterLand = defineCommand({
  meta: { description: `Did the latest landing's background after_land commands finish, with what exit codes, and what did code review say; --wait blocks until they finish (default ${AFTER_LAND_WAIT_MS / 60_000} min). Exit 0 all exited 0, 1 one failed, 75 still running, 3 none, 4 log missing` },
  args: {
    change: { type: "positional", required: false, description: "That change's latest landing instead of the latest of all (C-n)" },
    wait: { type: "boolean", description: "Wait until every command has finished" },
    timeout: { type: "string", description: `Minutes --wait waits (default ${AFTER_LAND_WAIT_MS / 60_000})` },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const minutes = args.timeout === undefined ? undefined : Number(args.timeout);
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) fail({ code: "invalid", message: `--timeout must be a positive number of minutes, got ${JSON.stringify(args.timeout)}` });
    if (minutes !== undefined && !args.wait) fail({ code: "invalid", message: "--timeout only applies with --wait" });
    const ws = workspace();
    const change = typeof args.change === "string" && args.change ? args.change : undefined;
    const timeoutMs = minutes === undefined ? AFTER_LAND_WAIT_MS : minutes * 60_000;
    const b = args.wait ? await waitBackgroundHooks(ws.db, ws.actor, change, timeoutMs) : settleBackgroundHooks(ws.db, ws.actor, change);
    if (!b) {
      const base = change ? `no landing of ${change} ran background after_land commands` : "no landing has run background after_land commands";
      // A landing killed or still running is why there is none yet (BR-2310, D-58).
      const unfinished = change ? openAttempts(ws.db, ws.config.main).filter((a) => a.subject === change && a.state !== "unknown") : [];
      fail({ code: "not_found", message: [base, ...unfinished.flatMap(describeAttempt)].join("\n") });
    }
    const st = batchState(b);
    if (args.json) json({ ...b, state: st });
    else {
      say(renderAfterLand(b));
      if (args.wait && st === "running") say(`still running after ${timeoutMs / 60_000} min; run canon work after-land --wait again`);
    }
    process.exit({ ok: EXIT.ok, failed: EXIT.refused, running: EXIT.timeout, unknown: EXIT.env }[st]);
  },
});

export const hooksCommands: DomainCommands = { commands: [entry("after-land", 70, afterLand, "work")] };
