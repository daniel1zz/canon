import { defineCommand } from "citty";
import { entry, EXIT, fail, json, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { describeAttempt, openAttempts } from "../land/queue/interrupted.ts";
import { AFTER_LAND_WAIT_MS } from "./hooks.ts";
import { isChore, normalizeSubject } from "../session/subject.ts";
import { afterLandState, readAfterLand, renderAfterLandAll, waitAfterLand } from "./after-land.ts";

/** `canon work after-land`: the background after_land commands of a landing (BR-2166). */

const afterLand = defineCommand({
  meta: { description: `Did the latest landing's background after_land commands and the review after it finish, with what exit codes, and what did the code review and the rule review say; --wait blocks until they finish (default ${AFTER_LAND_WAIT_MS / 60_000} min). Exit 0 all finished well, 1 one failed or the review could not run, 75 still running or queued, 3 none, 4 log missing` },
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
    const change = typeof args.change === "string" && args.change ? normalizeSubject(args.change) : undefined;
    const timeoutMs = minutes === undefined ? AFTER_LAND_WAIT_MS : minutes * 60_000;
    const r = args.wait ? await waitAfterLand(ws, change, timeoutMs) : readAfterLand(ws, change);
    if (!r.batch && !r.review) {
      const base = change ? `no landing of ${change} ran background after_land commands or a review after it` : "no landing has run background after_land commands or a review after it";
      // A landing killed or still running is why there is none yet (BR-2310, D-58).
      const unfinished = change ? openAttempts(ws.db, ws.config.main).filter((a) => a.subject === change && a.state !== "unknown") : [];
      fail({ code: "not_found", message: [base, ...unfinished.flatMap(describeAttempt)].join("\n") });
    }
    const st = afterLandState(r);
    const subject = r.batch?.change ?? r.review?.change ?? null;
    if (args.json) json({ ...(r.batch ?? { change: subject, commands: [] }), subject, workKind: subject === null ? null : isChore(subject) ? "chore" : "change", state: st, landedReview: r.review ? { state: r.review.state, log: r.review.log, lines: r.review.lines } : null });
    else {
      say(renderAfterLandAll(r));
      if (args.wait && st === "running") say(`still running after ${timeoutMs / 60_000} min; run canon work after-land --wait again`);
    }
    process.exit({ ok: EXIT.ok, failed: EXIT.refused, running: EXIT.timeout, unknown: EXIT.env }[st]);
  },
});

export const hooksCommands: DomainCommands = { commands: [entry("after-land", 70, afterLand, "work")] };
