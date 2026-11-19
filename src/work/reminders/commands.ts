import { defineCommand } from "citty";
import { AS_ARG, EXIT, entry, fail, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { parseSince } from "../stats/window.ts";
import { dueItems, renderDue } from "./due.ts";
import { watchDue } from "./watch.ts";

/** `canon work due` and `canon work watch`: what the calling session should handle now, and as it changes (BR-2527, BR-2528, D-136). */

const dueCmd = defineCommand({
  meta: { description: "What this session should handle now, one line each: <key> <open for> <what> → <next command> (findings, questions, stalled delegations, design requests, a red main, a busy machine; a worker sees only its own changes)" },
  args: { json: { type: "boolean" }, ...AS_ARG },
  run({ args }) {
    const ws = workspace(args.as);
    const items = must(dueItems(ws));
    if (args.json) return json(items);
    if (items.length === 0) return say("nothing due");
    const now = Date.now();
    for (const it of items) say(renderDue(it, now));
  },
});

const watchCmd = defineCommand({
  meta: { description: "Keep running (under Claude Code's Monitor tool): print the due list, then the events that concern this session, items that appear (due) or go (done), and the ones still open every remind_every_minutes; stops on SIGTERM or SIGINT" },
  args: { since: { type: "string", description: "Start after this event id and first print the missed events that concern this session (re-arming: the last event number it printed)" }, ...AS_ARG },
  async run({ args }) {
    const ws = workspace(args.as);
    let since: number | undefined;
    if (args.since !== undefined) {
      since = parseSince(args.since);
      if (since === undefined) fail({ code: "invalid", message: `--since must be an event id (a whole number, 0 or more), got ${JSON.stringify(args.since)}` });
    }
    let stop = false;
    let wake: (() => void) | undefined;
    const onSignal = () => { stop = true; wake?.(); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    const r = await watchDue(ws, since, {
      out: say,
      stopped: () => stop,
      sleep: (ms) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; }),
      clock: Date.now,
    });
    must(r);
    process.exit(EXIT.ok);
  },
});

export const reminderCommands: DomainCommands = { commands: [entry("due", 16, dueCmd, "work"), entry("watch", 17, watchCmd, "work")] };
