import { defineCommand } from "citty";
import { entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { computeStats, renderSearchStats, renderSharedShare, renderStats, searchStats, sharedShare } from "./stats.ts";
import { pendingBlocks, recordVerdict, renderPending, renderVerdictSummary, verdictSummary } from "./verdict.ts";
import { dirname } from "node:path";
import { CoordDb } from "../db.ts";
import { corpusOf as corpusAtRef, worktreesDir } from "../session/session.ts";
import { git } from "../../kernel/git.ts";
import { findingsByCriterion, renderFindingsByCriterion, renderReviewCounts, reviewCounts } from "./reviews.ts";
import { DEFAULT_DAYS, projectsDir, renderUsage, usageReport } from "./usage.ts";
import { claimsWithState } from "../claims/claims.ts";
import { batchStats, renderBatchStats } from "./batches.ts";
import { designStats, renderDesignStats } from "./design.ts";
import { followEvents } from "./follow.ts";
import { reminderStats, renderReminderStats } from "./reminders.ts";
import { agenda, dueList } from "../reminders/agenda.ts";
import { readFileSync } from "node:fs";
import { readRuntime } from "../../kernel/agent.ts";
import { executionStats, renderExecutionStats } from "./execution.ts";
import { landingsByModel, modelFromHook, recordModel, renderLandingsByModel } from "./model.ts";
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
    // reason: text-only like the review counts; the --json fields are fixed (BR-2202, BR-2451)
    const byCriterion = renderFindingsByCriterion(findingsByCriterion(ws.db, since ?? 0, until));
    if (byCriterion) say(`\n${byCriterion}`);
    // reason: the batch section is text-only too (BR-2202, BR-2379); `canon events --kind batch.end --json` has the raw rows
    const batches = renderBatchStats(batchStats(ws.db, since ?? 0, until));
    if (batches) say(`\n${batches}`);
    // reason: text-only like the batch section; the --json fields are fixed (BR-2202, BR-2532)
    const byModel = renderLandingsByModel(landingsByModel(ws.db, since ?? 0, until));
    if (byModel) say(`\n${byModel}`);
    // reason: text-only like the model section; the --json fields are fixed (BR-2202, BR-2611)
    const execution = renderExecutionStats(executionStats(ws.db, ws.primary, since ?? 0, until));
    if (execution) say(`\n${execution}`);
    // reason: text-only like the review counts; whether a class needs a hard gate is read off these numbers (BR-2494, D-124)
    // reason: revisions are counted on main as committed, never on this checkout's HEAD or uncommitted text (BR-2494)
    const mainSha = must(git(ws.primary, "rev-parse", "--verify", `refs/heads/${ws.config.main}^{commit}`)).trim();
    const design = renderDesignStats(designStats(ws.db, ws.primary, must(corpusAtRef(ws, mainSha)), mainSha, since ?? 0, until));
    if (design) say(`\n${design}`);
    // reason: text-only like the review counts; how the main agent handled its reminders, read off the agenda now (BR-2585, D-151)
    const a = must(agenda(ws));
    const reminders = renderReminderStats(reminderStats(ws, since ?? 0, until, dueList(a).map((it) => it.key), a.states));
    if (reminders) say(`\n${reminders}`);
    const searches = searchStats(ws.db, since ?? 0, until);
    if (searches.searches > 0) say(`\n${renderSearchStats(searches)}`);
    // reason: the shared code line is the last one (BR-2121, issue #70)
    const share = sharedShare(ws.root, ws.config);
    if (share) say(`\n${renderSharedShare(share)}`);
  },
});

/** The `--kind` values, separated by commas; a repeated option is refused before this (BR-2156). */
function kindsOf(v: unknown): string[] {
  if (v === undefined) return [];
  const kinds = list(v);
  if (kinds.length === 0) fail({ code: "invalid", message: `--kind needs at least one event kind, got ${JSON.stringify(v)}` });
  return kinds;
}

const events = defineCommand({
  meta: { description: "List raw coordination events (id, time, actor, worktree, kind, subject, detail), newest last" },
  args: {
    since: { type: "string", description: "Only events after this event id (default 0: all)" },
    kind: { type: "string", description: "Only these event kinds, separated by commas, e.g. land.ok,land.refuse" },
    subject: { type: "string", description: "Only events about this subject, e.g. C-12" },
    json: { type: "boolean" },
    follow: { type: "boolean", description: "Keep running and print each new matching event (one JSON object per line with --json); starts after the latest event unless --since is given; stops on SIGTERM or SIGINT" },
  },
  async run({ args }) {
    const ws = workspace();
    if (args.follow) {
      const filter = { kinds: kindsOf(args.kind), ...(typeof args.subject === "string" ? { subject: args.subject } : {}) };
      const from = args.since === undefined ? undefined : sinceArg(args.since);
      let stop = false;
      const onSignal = () => { stop = true; };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
      await followEvents(ws.db, filter, from, (r) => say(args.json ? JSON.stringify(r) : renderEvents([r])), () => stop, () => void claimsWithState(ws.db));
      return;
    }
    const since = args.since === undefined ? 0 : sinceArg(args.since);
    const kinds = kindsOf(args.kind);
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

/** `canon work model --hook`: the hook that records the session's host and model (BR-2531, D-137). Prints nothing on success. */
const model = defineCommand({
  meta: { description: "Record the host and model of this session from a host hook's input on stdin (run by the SessionStart and PostModelSwitch hooks, and Codex's Stop hook)" },
  args: { hook: { type: "boolean", description: "Read the hook input from stdin" }, runtime: { type: "string", description: "claude or codex: whose hook input this is" } },
  run({ args }) {
    if (!args.hook) fail({ code: "invalid", message: "`canon work model` is run by the host's hooks: pass --hook, the hook input comes on stdin" });
    const runtime = must(readRuntime(args.runtime));
    let input: unknown;
    try { input = JSON.parse(readFileSync(0, "utf8")); } catch { fail({ code: "invalid", message: "canon work model --hook needs the hook's JSON object on stdin" }); }
    const parsed = must(modelFromHook(input, runtime));
    const given = (input as Record<string, unknown>)["cwd"];
    const cwd = typeof given === "string" && given !== "" ? given : process.cwd();
    const db = must(CoordDb.open(must(CoordDb.pathFor(cwd)), cwd));
    try { recordModel(db, parsed.actor, parsed.record); }
    catch (e) { fail({ code: "io", message: `canon work model: cannot record the model: ${(e as Error).message}` }); }
    finally { db.db.close(); }
  },
});

export const statsCommands: DomainCommands = { commands: [entry("model", 67, model, "work"), entry("stats", 140, stats), entry("events", 150, events), entry("verdict", 152, verdict), entry("usage", 153, usage)] };
