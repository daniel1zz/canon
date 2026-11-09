import { defineCommand } from "citty";
import { entry, fail, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { computeStats, renderSearchStats, renderSharedShare, renderStats, searchStats, sharedShare } from "./stats.ts";
import { pendingBlocks, recordVerdict, renderPending, renderVerdictSummary, verdictSummary } from "./verdict.ts";
import { dirname } from "node:path";
import { CoordDb } from "../db.ts";
import { worktreesDir } from "../session/session.ts";
import { renderReviewCounts, reviewCounts } from "./reviews.ts";
import { DEFAULT_DAYS, projectsDir, renderUsage, usageReport } from "./usage.ts";
import { claimsWithState } from "../claims/claims.ts";
import { batchStats, renderBatchStats } from "./batches.ts";
import { followEvents } from "./follow.ts";
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
    // reason: text-only like the verdicts; the --json fields are fixed (BR-2202, BR-2397)
    const reviews = renderReviewCounts(reviewCounts(ws.db, since ?? 0, until));
    if (reviews) say(`\n${reviews}`);
    // reason: the batch section is text-only too (BR-2202, BR-2379); `canon events --kind batch.end --json` has the raw rows
    const batches = renderBatchStats(batchStats(ws.db, since ?? 0, until));
    if (batches) say(`\n${batches}`);
    const searches = searchStats(ws.db, since ?? 0, until);
    if (searches.searches > 0) say(`\n${renderSearchStats(searches)}`);
    // reason: the shared code line is the last one (BR-2121, issue #70)
    const share = sharedShare(ws.root, ws.config);
    if (share) say(`\n${renderSharedShare(share)}`);
  },
});

/** The `--kind` values, repeated or not. */
function kindsOf(args: object): string[] {
  const raw = (args as Record<string, unknown>)["kind"];
  return raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);
}

const events = defineCommand({
  meta: { description: "List raw coordination events (id, time, actor, worktree, kind, subject, detail), newest last" },
  args: {
    since: { type: "string", description: "Only events after this event id (default 0: all)" },
    kind: { type: "string", description: "Only this event kind, e.g. land.ok; repeat for several" },
    subject: { type: "string", description: "Only events about this subject, e.g. C-12" },
    json: { type: "boolean" },
    follow: { type: "boolean", description: "Keep running and print each new matching event (one JSON object per line with --json); starts after the latest event unless --since is given; stops on SIGTERM or SIGINT" },
  },
  async run({ args }) {
    const ws = workspace();
    if (args.follow) {
      const filter = { kinds: kindsOf(args), ...(typeof args.subject === "string" ? { subject: args.subject } : {}) };
      const from = args.since === undefined ? undefined : sinceArg(args.since);
      let stop = false;
      const onSignal = () => { stop = true; };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
      await followEvents(ws.db, filter, from, (r) => say(args.json ? JSON.stringify(r) : renderEvents([r])), () => stop, () => void claimsWithState(ws.db));
      return;
    }
    const since = args.since === undefined ? 0 : sinceArg(args.since);
    const kinds = kindsOf(args);
    const rows = eventsSince(ws.db, { since, kinds, ...(typeof args.subject === "string" ? { subject: args.subject } : {}) });
    if (args.json) return json(rows);
    say(renderEvents(rows));
  },
});

/** `canon verdict`: whether each rule-review finding was real, recorded by hand and self-reported (D-49). */
const verdict = defineCommand({
  meta: { description: "Verdicts on rule-review findings: real, spurious or unclear; recorded by hand and self-reported" },
  subCommands: {
    pending: defineCommand({
      meta: { description: "Review blocks of landed changes with a finding that has no verdict yet, each finding's verdicts and the commit the review saw" },
      args: { json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const blocks = pendingBlocks(ws.db);
        if (args.json) return json(blocks);
        say(renderPending(blocks));
      },
    }),
    record: defineCommand({
      meta: { description: "Record a human verdict on one finding of a review block: real, spurious or unclear (not from a Claude Code session)" },
      args: {
        block: { type: "positional", required: true, description: "Event id of the review.block" },
        finding: { type: "positional", required: true, description: "The finding's number in that block (1, 2, ...)" },
        verdict: { type: "positional", required: true, description: "real | spurious | unclear" },
        reason: { type: "string", description: "What in the blocked commit shows it" },
      },
      run({ args }) {
        const ws = workspace();
        const v = String(args.verdict);
        const r = must(recordVerdict(ws.db, ws.actor, String(args.block), String(args.finding), v, typeof args.reason === "string" ? args.reason : ""));
        say(`recorded a human verdict on finding ${String(args.finding)} of block ${String(args.block)} (${r.subject}): ${v}`);
      },
    }),
  },
});

/** `canon usage`: what the injected skills, MCP servers and subagent types are used for (C-34, D-40). Read only. */
const usage = defineCommand({
  meta: { description: "Skill, MCP server and subagent type uses from this project's Claude Code session records, and the available ones unused for --days days with their injected size; read only" },
  args: { days: { type: "string", description: `Unused means not used in this many days (default ${DEFAULT_DAYS})` }, json: { type: "boolean" } },
  run({ args }) {
    const raw = args.days === undefined ? String(DEFAULT_DAYS) : String(args.days);
    if (!/^[1-9]\d*$/.test(raw)) fail({ code: "invalid", message: `--days must be a whole number of days, 1 or more, got ${JSON.stringify(args.days)}` });
    const ws = workspace();
    const at = { primary: ws.primary, worktrees: worktreesDir(ws), canonDir: dirname(must(CoordDb.pathFor(ws.root))) };
    const r = must(usageReport(projectsDir(), at, Number(raw), new Date()));
    if (args.json) return json(r);
    say(renderUsage(r));
  },
});

export const statsCommands: DomainCommands = { commands: [entry("stats", 140, stats), entry("events", 150, events), entry("verdict", 152, verdict), entry("usage", 153, usage)] };
