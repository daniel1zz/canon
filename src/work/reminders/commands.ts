import { defineCommand } from "citty";
import { AS_ARG, EXIT, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { changeStates, isClosed } from "../../knowledge/changes/state.ts";
import { isWorker } from "../delegation/worker.ts";
import { parseSince } from "../stats/window.ts";
import { agenda, agendaJson, agendaLines, dueList } from "./agenda.ts";
import { duration, recordOutcome, RED_MAIN, type OutcomeKind } from "./handled.ts";
import { watchDue } from "./watch.ts";

/** `canon work due`, `canon work watch` and `canon work handled`: the agenda, as it changes, and the main agent's outcomes (BR-2527, BR-2528, BR-2583, D-151). */

const dueCmd = defineCommand({
  meta: { description: "The agenda: changes to delegate while the machine has room, what to judge (main's correctness first, then what blocks others), what waits on the owner, the full test runs running; one line each, <key> <open for> <what> → <next command>; a worker sees only its own changes" },
  args: { json: { type: "boolean" }, ...AS_ARG },
  run({ args }) {
    const ws = workspace(args.as);
    const a = must(agenda(ws));
    if (args.json) return json(agendaJson(a));
    const lines = agendaLines(a);
    if (lines.length === 0) return say("nothing due");
    for (const line of lines) say(line);
  },
});

const watchCmd = defineCommand({
  meta: { description: "Keep running (under Claude Code's Monitor tool): print the agenda summary, then only what changes: events that concern this session, items that appear (+) or go (-), the machine crossing its capacity threshold, and what can start after a landing; no repeats; stops on SIGTERM or SIGINT" },
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

const handledCmd = defineCommand({
  meta: { description: "Record the main agent's outcome for agenda items (keys from canon work due, comma separated): --to <C-n> hands them to a change, --defer \"<reason>\" --for <30m|4h|2d> puts them off, --not-doing \"<reason>\" drops them; they leave the agenda until that no longer holds" },
  args: {
    keys: { type: "positional", required: true, description: "Agenda keys, comma separated: finding:12,stalled:C-5" },
    to: { type: "string", description: "Hand them to this change (C-n)" },
    defer: { type: "string", description: "Put them off, with the reason" },
    for: { type: "string", description: "With --defer: for how long, 30m, 4h or 2d" },
    "not-doing": { type: "string", description: "Not doing them, with the reason" },
  },
  run({ args }) {
    const ws = workspace();
    if (isWorker(ws.actor)) fail({ code: "invalid", message: "only a main session records how a reminder was handled; a worker's items go away when it acts on its change (BR-2583)" });
    const keys = list(args.keys);
    const given = [args.to !== undefined, args.defer !== undefined, args["not-doing"] !== undefined].filter(Boolean).length;
    if (keys.length === 0) fail({ code: "invalid", message: "give the agenda keys to record an outcome for, e.g. finding:12,stalled:C-5 (canon work due lists them)" });
    if (given !== 1) fail({ code: "invalid", message: "give exactly one outcome: --to <C-n>, --defer \"<reason>\" --for <30m|4h|2d>, or --not-doing \"<reason>\" (BR-2583)" });
    if (args.for !== undefined && args.defer === undefined) fail({ code: "invalid", message: "--for goes with --defer only" });
    let what: { outcome: OutcomeKind; to?: string; reason?: string; forMs?: number };
    if (args.to !== undefined) {
      const to = String(args.to).trim().toUpperCase();
      if (!/^[A-Z]+-\d+$/.test(to)) fail({ code: "invalid", message: `--to takes a change id (C-n), got ${JSON.stringify(args.to)}` });
      what = { outcome: "handed", to };
    } else if (args.defer !== undefined) {
      const reason = String(args.defer).trim();
      if (reason === "") fail({ code: "invalid", message: "--defer needs the reason" });
      if (args.for === undefined) fail({ code: "invalid", message: "--defer needs --for <30m|4h|2d>: how long to put it off" });
      const ms = duration(String(args.for));
      if (ms === undefined) fail({ code: "invalid", message: `--for takes a whole number with m, h or d (30m, 4h, 2d), got ${JSON.stringify(args.for)}` });
      what = { outcome: "deferred", reason, forMs: ms };
    } else {
      const reason = String(args["not-doing"]).trim();
      if (reason === "") fail({ code: "invalid", message: "--not-doing needs the reason" });
      what = { outcome: "not-doing", reason };
    }
    const now = Date.now();
    const a = must(agenda(ws, { now }));
    const open = new Map<string, string | null>([...dueList(a).map((it) => [it.key, it.since] as const), ...(a.delegate?.ready ?? []).map((c) => [`ready:${c.id}`, null] as const)]);
    const fixOnly = new Set([RED_MAIN, ...dueList(a).filter((it) => it.fixOnly).map((it) => it.key)]);
    const states = must(changeStates(ws, { delegatable: false })).states;
    const changeOpen = (id: string) => states.some((s) => s.id === id && s.change !== undefined && !isClosed(s));
    for (const r of must(recordOutcome(ws, keys, what, open, changeOpen, now, fixOnly))) say(r.line);
  },
});

export const reminderCommands: DomainCommands = { commands: [entry("due", 16, dueCmd, "work"), entry("watch", 17, watchCmd, "work"), entry("handled", 18, handledCmd, "work")] };
