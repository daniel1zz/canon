import { defineCommand } from "citty";
import { entry, fail, json, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { computeStats, renderSearchStats, renderSharedShare, renderStats, searchStats, sharedShare } from "./stats.ts";
import { pendingBlocks, recordVerdict, renderPending, renderVerdictSummary, verdictSummary } from "./verdict.ts";
import { eventsSince, lastEventId, parseSince, renderEvents, renderWindow, windowSummary } from "./window.ts";

/** `canon stats` and `canon events`: what the event table recorded. */

/** `--since`, or a usage error naming what was given (BR-2154, BR-2156). */
function sinceArg(v: unknown): number {
  const n = parseSince(v);
  if (n === undefined) fail({ code: "invalid", message: `--since must be an event id (a whole number, 0 or more), got ${JSON.stringify(v)}` });
  return n;
}

const stats = defineCommand({
  meta: { description: "Check precision: runs, refusals and what happened after each refusal; checks due for review. --since <event id> counts only later events and adds a concurrency summary of them" },
  args: { json: { type: "boolean" }, since: { type: "string", description: "Only events after this event id; adds the window summary (landings, queue waits, conflicts, who took part)" } },
  run({ args }) {
    const ws = workspace();
    const since = args.since === undefined ? undefined : sinceArg(args.since);
    const today = new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local time
    // reason: every part reads up to one event id, so a landing written meanwhile cannot make them disagree (issue #37)
    const until = lastEventId(ws.db);
    const s = computeStats(ws.db, ws.config.checkReviews, today, since ?? 0, until);
    const window = since === undefined ? undefined : windowSummary(ws.db, since, until);
    if (args.json) return json(window ? { since, checks: s, window } : s);
    if (window) say(`${renderWindow(window)}\n`);
    say(renderStats(s));
    // reason: verdicts are text-only; the --json fields are fixed (BR-2202, BR-2255)
    const verdicts = renderVerdictSummary(verdictSummary(ws.db, since ?? 0, until));
    if (verdicts) say(`\n${verdicts}`);
    const searches = searchStats(ws.db, since ?? 0, until);
    if (searches.searches > 0) say(`\n${renderSearchStats(searches)}`);
    // reason: the shared code line is the last one (BR-2121, issue #70)
    const share = sharedShare(ws.root, ws.config);
    if (share) say(`\n${renderSharedShare(share)}`);
  },
});

const events = defineCommand({
  meta: { description: "List raw coordination events (id, time, actor, worktree, kind, subject, detail), newest last" },
  args: {
    since: { type: "string", description: "Only events after this event id (default 0: all)" },
    kind: { type: "string", description: "Only this event kind, e.g. land.ok; repeat for several" },
    subject: { type: "string", description: "Only events about this subject, e.g. C-12" },
    json: { type: "boolean" },
  },
  run({ args }) {
    const ws = workspace();
    const since = args.since === undefined ? 0 : sinceArg(args.since);
    const raw = (args as Record<string, unknown>)["kind"];
    const kinds = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);
    const rows = eventsSince(ws.db, { since, kinds, ...(typeof args.subject === "string" ? { subject: args.subject } : {}) });
    if (args.json) return json(rows);
    say(renderEvents(rows));
  },
});

/** `canon verdict`: whether a rule-review block named a real problem, judged by someone outside the change (D-35). */
const verdict = defineCommand({
  meta: { description: "Verdicts on rule-review blocks: real problem or wording changed just to pass, judged by an executor outside the change" },
  subCommands: {
    pending: defineCommand({
      meta: { description: "Review blocks of landed changes your judge kind (agent or human) has not judged, with the commit blocked and the commit landed" },
      args: { json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const blocks = pendingBlocks(ws.db, ws.root, ws.actor);
        if (args.json) return json(blocks);
        say(renderPending(blocks));
      },
    }),
    record: defineCommand({
      meta: { description: "Record a verdict on one review block: real (the block named a real problem) or wording (only reworded to pass)" },
      args: {
        refusal: { type: "positional", required: true, description: "Event id of the land.refuse with reason review" },
        verdict: { type: "positional", required: true, description: "real | wording" },
        reason: { type: "string", description: "What in the code before and after the block shows it" },
      },
      run({ args }) {
        const ws = workspace();
        const id = String(args.refusal);
        if (!/^\d+$/.test(id)) fail({ code: "invalid", message: `the refusal must be an event id (a whole number), got ${JSON.stringify(args.refusal)}` });
        const r = must(recordVerdict(ws.db, ws.actor, Number(id), String(args.verdict), typeof args.reason === "string" ? args.reason : ""));
        say(`recorded a ${r.judge} verdict on refusal ${id} (${r.subject}): ${String(args.verdict)}`);
      },
    }),
  },
});

export const statsCommands: DomainCommands = { commands: [entry("stats", 140, stats), entry("events", 150, events), entry("verdict", 152, verdict)] };
