import { proposedNotice } from "./proposed.ts";
import { listedDelegations, stalledDelegations, stalledLine } from "../delegation/stall.ts";
import { readFileSync } from "node:fs";
import { readRuntime } from "../../kernel/agent.ts";
import { recordCodexStartup } from "../agent-session.ts";
import { machineNow, startHint } from "./load.ts";
import { defineCommand } from "citty";
import { writeSchemaFile } from "../../invocation/reference/reference.ts";
import { AS_ARG, RUNTIME_ARG, corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { takesMany } from "../../invocation/strict.ts";
import { delegationNotice } from "../delegation/records.ts";
import { changeRequestLines, ownerRequestLines, pendingRequests, statusRequestLines } from "../delegation/requests.ts";
import { guideFor, WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { noticeUpdates } from "../../install/commands.ts";
import { backgroundNotice, settleBackgroundHooks } from "../hooks/hooks.ts";
import { git, toplevel } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { backlogAt } from "../../knowledge/documents/backlog.ts";
import { findDoc, referencedIds } from "../../knowledge/query/query.ts";
import { openNotes, renderNote } from "../../knowledge/review/notes.ts";
import { findingsCount, openFindings, renderFinding } from "../../knowledge/review/findings/findings.ts";
import { suspectNotice } from "../../knowledge/links/brief.ts";
import { claimOfWorktree, claimsWithState, type ClaimState } from "../claims/claims.ts";
import { questions } from "../humans/questions.ts";
import { activeQueue, keptPlaces } from "../land/queue/queue.ts";
import { marks } from "../land/queue/urgent.ts";
import { dueItems, renderDue } from "../reminders/due.ts";
import { isWorker } from "../delegation/worker.ts";
import { attemptIn, describeAttempt, goneLanders, openAttempts } from "../land/queue/interrupted.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";
import { firstLine, handoffs } from "./handoffs.ts";
import { listedChanges, marksOf } from "./inflight.ts";
import { overlapsOf } from "./overlap.ts";
import { clean, LESSON_REMINDER, mainCorpus, start, startChore, stop } from "./session.ts";
import { CLEAN_DONE, cleanAfterLanding } from "./clean-after-land.ts";
import { choreIn, choresInFlight, isChore } from "./subject.ts";
import { redMainNotice, startFixMain } from "../watch/redmain.ts";
import { ensureWatcher, untestedNotice } from "../watch/watch.ts";
import { startTrailingReview, unreviewedNotice } from "../../knowledge/review/code-review-batch.ts";
import { failedReviewNotice } from "../../knowledge/review/landed-queue.ts";
import { unpushedNotice } from "../remote/remote.ts";
import { briefLine, othersDoing, planStatuses } from "../../knowledge/plans/status.ts";
import { briefSummary, overview } from "../overview/overview.ts";
import { LINK_ARGS, newLinks } from "../../knowledge/changes/commands.ts";

/** `canon brief` and `canon work start`, `stop`, `status`, `clean`: a session and its change's worktree. */

const startCmd = defineCommand({
  meta: { description: "Start a change in its own worktree: `--title` for a new one, or an existing change id" },
  args: {
    change: { type: "positional", required: false },
    title: { type: "string" },
    rules: { type: "string", description: "Rule ids the new change touches" },
    plan: { type: "string", description: "With --title and --step: the change holding the plan this change does steps of (BR-2376)" },
    step: { type: "string", description: "With --plan: the plan's step names this change does, comma separated (BR-2376)" },
    "fix-main": { type: "boolean", description: "Open the one change that fixes main's failing background floor (floor_timing: after, BR-2221)" },
    settles: { type: "string", description: "Open review finding numbers this change settles, comma separated (BR-2530)" },
    ...LINK_ARGS,
    ...AS_ARG,
  },
  run({ args }) {
    const ws = workspace(args.as);
    const fixMain = Boolean(args["fix-main"]);
    if (fixMain && (args.change || args.title || args.rules)) fail({ code: "invalid", message: "--fix-main opens its own change; give no change id, --title or --rules with it" });
    if (!fixMain && !args.change && !args.title) fail({ code: "invalid", message: "give a change id, --title for a new change, or --fix-main" });
    const planned = args.plan !== undefined || args.step !== undefined;
    if (planned && (args.plan === undefined || args.step === undefined)) fail({ code: "invalid", message: "--plan and --step go together: the plan's change and the steps this change does" });
    if (planned && (args.change || !args.title || fixMain)) fail({ code: "invalid", message: "--plan and --step go with --title for a new change, not with an existing change id or --fix-main" });
    const steps = list(args.step);
    if (planned && (String(args.plan).trim() === "" || steps.length === 0)) fail({ code: "invalid", message: "--plan needs a change id and --step at least one step name" });
    const linked = Object.keys(LINK_ARGS).some((k) => (args as Record<string, unknown>)[k] !== undefined);
    if (linked && (args.change || !args.title || fixMain)) fail({ code: "invalid", message: "--release, --feature, --issue and --depends go with --title for a new change; an existing change's links are edited with canon change link (BR-2562)" });
    // reason: checked on main, which the new branch starts from, before an id is allocated (BR-2562)
    const links = linked ? newLinks(ws, args as Record<string, unknown>, must(mainCorpus(ws))) : undefined;
    const target = typeof args.change === "string" && args.change ? { change: args.change } : { title: String(args.title), rules: list(args.rules), ...(planned ? { plan: { id: String(args.plan).trim().toUpperCase(), steps } } : {}), ...(links ? { links } : {}) };
    const settles = list(args.settles).map((v) => v.replace(/^#/, ""));
    if (settles.some((v) => !/^[1-9]\d*$/.test(v))) fail({ code: "invalid", message: `--settles takes review finding numbers, comma separated (got ${String(args.settles)})` });
    if (fixMain && settles.length > 0) fail({ code: "invalid", message: "--fix-main opens its own change; give no --settles with it" });
    const s = must(fixMain ? startFixMain(ws, say) : start(ws, target, say, { settles: settles.map(Number) }));
    for (const line of startHint(ws.db, machineNow(), { fixMain, created: s.created })) say(line);
    // A step another unfinished change is doing is said, never refused: a step may take several changes (BR-2385, D-77).
    if ("plan" in target && target.plan) for (const line of stepsTaken(ws, target.plan, s.change)) say(line);
    noticeUpdates(ws, say);
    say(`cd ${s.worktree}`);
  },
});

const choreStartCmd = defineCommand({
  meta: { description: "Start a chore (a light change) by title, or resume its chore identity; its change file and C number are written when it lands" },
  args: { target: { type: "positional", required: true }, ...AS_ARG },
  run({ args }) {
    const target = String(args.target);
    const started = must(startChore(workspace(args.as), isChore(target) ? { subject: target } : { title: target }, say));
    say(`${started.subject} is a light change: its change file and C number are written when it lands (canon chore land)`);
    say(`cd ${started.worktree}`);
  },
});

const stopCmd = defineCommand({
  meta: { description: "Hand off: record the next step for whoever continues this change" },
  args: { next: { type: "string", required: true }, note: { type: "string" }, release: { type: "boolean", description: "Release the claim too" }, ...AS_ARG },
  run({ args }) {
    const ws = workspace(args.as);
    const subject = must(stop(ws, String(args.next), typeof args.note === "string" ? args.note : undefined, Boolean(args.release), say));
    say(`${subject}: handoff recorded${args.release ? ", claim released" : ""}`);
    if (!isChore(subject)) say(LESSON_REMINDER);
  },
});

const status = defineCommand({
  meta: { description: "Claims, landing queue, handoffs and open questions" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const gone = goneLanders(ws.db);
    const untested = untestedNotice(ws);
    const unreviewed = unreviewedNotice(ws);
    const failedReviews = failedReviewNotice(ws.db);
    const chores = must(choresInFlight(ws));
    const stalled = must(stalledDelegations(ws));
    const data = { chores, ...(stalled.length > 0 ? { stalled } : {}), ...(untested.length > 0 ? { untested } : {}), ...(unreviewed.length > 0 ? { unreviewed } : {}), ...(failedReviews.length > 0 ? { failed_reviews: failedReviews } : {}), claims: claimsWithState(ws.db), queue: activeQueue(ws.db).map((q) => ({ ...q, lander_gone: gone.has(q.id) })), landings: openAttempts(ws.db, ws.config.main), resolving: keptPlaces(ws.db), handoffs: handoffs(ws.db), questions: questions(ws.db, "pending"), design_requests: pendingRequests(ws.db), urgent: marks(ws.db) };
    if (args.json) return json(data);
    for (const subject of must(listedDelegations(ws))) for (const line of delegationNotice(ws.db, subject)) say(line);
    // Delegations nobody is working on, each with what the design owner can do (BR-2522, #255).
    for (const s of stalled) say(stalledLine(s));
    // Pending design requests, each with the design owner who answers it (BR-2499).
    const requests = statusRequestLines(ws.db);
    if (requests.length) say(`Design requests waiting for their design owner (canon work design-answer <n> "<answer>"):\n${requests.join("\n")}`);
    for (const line of [...untested, ...unreviewed, ...failedReviews]) say(line);
    if (chores.length) say(`Unfinished chores: ${chores.map((c) => `${c.subject} (${c.branch})`).join(", ")}`);
    say("Claims:");
    // Every row is listed; one that no longer binds is marked, judged as `canon work start` judges it (BR-2192, BR-2100).
    for (const c of data.claims) say(`  ${c.subject.padEnd(8)} ${c.actor}  ${c.holder}  until ${c.expires_at}${STALE[c.state]}`);
    say("Landing queue:");
    for (const q of data.queue) say(`  #${q.id} ${q.state.padEnd(8)} ${q.subject ?? "-"}  ${q.worktree}${q.lander_gone ? "  (lander process gone)" : ""}`);
    // Refused for a conflict, keeping its place while its lander resolves it; the entries behind it land meanwhile (BR-2177).
    for (const q of data.resolving) say(`  #${q.id} resolving ${q.subject ?? "-"}  ${q.worktree}  keeps its place until ${q.keep_until}`);
    // Landings with no recorded result: still running, or killed where no signal handler could run (BR-2308, D-58).
    say("Landings with no result yet:");
    for (const a of data.landings) for (const line of describeAttempt(a)) say(`  ${line}`);
    // The owner's priorities that put a change ahead in the landing queue (BR-2363).
    if (data.urgent.length > 0) say("Urgent by the owner:");
    for (const m of data.urgent) say(`  ${m.change}  relayed by ${m.actor} (${m.at}): ${m.words}`);
    say("Handoffs:");
    for (const h of data.handoffs) say(`  ${h.subject.padEnd(8)} next: ${firstLine(h.next)}  (${h.actor}, ${h.updated_at})`);
    say(`Questions waiting for a human: ${data.questions.length}`);
  },
});

/** The lines saying which of a new change's steps other unfinished changes already do (BR-2385). */
function stepsTaken(ws: Workspace, plan: { id: string; steps: readonly string[] }, self: string): string[] {
  // reason: the change is already started; a failure to read the others is said, not raised: it is only a hint (BR-2385)
  const onMain = mainCorpus(ws);
  if (!onMain.ok) return [`could not check which changes already do ${plan.steps.join(", ")}: ${onMain.error.message}`];
  const all = listedChanges(ws, onMain.value, [], () => true);
  if (!all.ok) return [`could not check which changes already do ${plan.steps.join(", ")}: ${all.error.message}`];
  const doers = all.value.listed.map((l) => ({ change: l.change, onMain: l.onBranch.length === 0 }));
  return othersDoing(doers, plan.id, plan.steps, self).map((o) => `step ${o.step} is already being done by ${o.changes.join(", ")}`);
}

/** How `canon work status` marks a claim that no longer binds (BR-2192). */
const STALE: Record<ClaimState, string> = { live: "", expired: "  (expired: lease ended)", "holder-gone": "  (expired: session process exited)" };

const cleanCmd = takesMany(defineCommand({
  meta: { description: "Remove worktrees that are clean and fully landed; list the rest with the reason they stay. Name changes to remove only theirs" },
  args: {
    changes: { type: "positional", required: false, description: "Only these changes' worktrees (C-n ...)" },
    "after-landing": { type: "boolean", description: "Started by land --finish: retry for about two minutes while a process is still inside the one named worktree (BR-2486)" },
  },
  async run({ args }) {
    const ws = workspace();
    const names = args._.map(String);
    if (args["after-landing"]) {
      if (names.length !== 1) fail({ code: "invalid", message: "--after-landing takes exactly one change or chore" });
      let r: Awaited<ReturnType<typeof cleanAfterLanding>>;
      try {
        r = await cleanAfterLanding(ws, say, names[0]!);
      } finally {
        // reason: canon work after-land waits for this line, so it is written however the removal ends (BR-2486)
        say(CLEAN_DONE);
      }
      must(r);
      return;
    }
    const r = must(clean(ws, say, names));
    for (const k of r.kept) say(`kept ${k}`);
  },
}));

const brief = defineCommand({
  args: { ...RUNTIME_ARG, hook: { type: "boolean", description: "Read Codex startup JSON and record its session relationship" } },
  meta: { description: "Session start: how to work in a canon project, in a change's worktree that change and its handoff, elsewhere what is in flight (printed by the session-start hook)" },
  run({ args }) {
    // reason: the guide comes before anything that can fail, and failures are also said on stdout, which is what a
    // session-start hook shows the model; without it a session would know nothing about canon (BR-2090)
    // reason: the overview line needs the project root, found before anything that can fail; outside a repository the plain guide is printed and the failure follows (BR-2090)
    const top = toplevel(process.cwd());
    say(top.ok ? guideFor(top.value) : WORKFLOW_GUIDE);
    const failed = (what: string) =>
      say(`canon brief failed: ${what}\nFix this, then run canon brief again. Until then work as the guide above says; do not edit the main branch directly.`);
    let env = process.env;
    if (args.hook) {
      const runtime = readRuntime(args.runtime);
      if (!runtime.ok || runtime.value !== "codex") {
        const error = { code: "invalid" as const, message: "canon brief --hook requires --runtime codex" };
        failed(error.message);
        fail(error);
      }
      const registered = recordCodexStartup(process.cwd(), readFileSync(0, "utf8"), process.env["CANON_ACTOR"]);
      if (!registered.ok) { failed(registered.error.message); fail(registered.error); }
      env = { ...process.env, CODEX_SESSION_ID: registered.value.id, CODEX_THREAD_ID: registered.value.child ?? registered.value.id };
    }
    const opened = openWorkspace(process.cwd(), undefined, env);
    if (!opened.ok) {
      failed(opened.error.message);
      fail(opened.error);
    }
    let state: Result<void>;
    try {
      state = briefState(opened.value, env);
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e));
      throw e;
    }
    // reason: git or file errors reading main exit 4 like any other environment failure, not 70 (BR-2090, BR-2022)
    if (!state.ok) {
      failed(state.error.message);
      fail(state.error);
    }
  },
});

/** The text of the Monitor hint `canon brief` prints in a Claude Code main session (BR-2529). */
export const MONITOR_HINT = "Keep canon work watch running under Monitor (timeout 30 min); when it expires, re-arm with --since <the last event number it printed>.";

/** BR-2529: `Due now` with the due list when it is not empty; the Monitor hint whenever the session runs in Claude Code. */
function dueSection(ws: Workspace, env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  const due = dueItems(ws);
  if (!due.ok) out.push(`Cannot list what is due: ${due.error.message}`);
  else if (due.value.length > 0) {
    const now = Date.now();
    out.push("Due now (canon work due):", ...due.value.map((it) => `  ${renderDue(it, now)}`));
  }
  if (env["CLAUDECODE"] === "1") out.push(MONITOR_HINT);
  return out;
}

/** What `canon brief` says after the guide: in a claimed worktree only its own change; elsewhere the handoffs and questions; then the update notice. */
function briefState(ws: Workspace, env: Readonly<Record<string, string | undefined>> = process.env): Result<void> {
  const claimed = claimOfWorktree(ws.db, ws.root);
  const chore = choreIn(ws);
  if (!chore.ok) return chore;
  if (claimed && chore.value && claimed.subject !== chore.value) return err("conflict", "worktree and claim identity disagree");
  const mine = claimed ?? (chore.value ? { subject: chore.value } : undefined);
  const hs = handoffs(ws.db);
  // A failing main comes first, in every worktree (BR-2220); then the background floor starts if main's latest commit needs it (BR-2219).
  for (const line of redMainNotice(ws.db, mine?.subject)) say(line);
  ensureWatcher(ws, say);
  // The design requests this session answers as design owner, in every worktree: a worker waits on them (BR-2499).
  for (const line of ownerRequestLines(ws.db, ws.actor)) say(line);
  for (const line of [...untestedNotice(ws), ...unreviewedNotice(ws)]) say(line);
  // The last batch of a burst has no later landing to review it (BR-2316).
  startTrailingReview(ws, say);
  if (mine) {
    for (const line of delegationNotice(ws.db, mine.subject)) say(line);
    // The requests on this change with their answers, next to the latest design revision above (BR-2499).
    for (const line of changeRequestLines(ws.db, mine.subject)) say(line);
    say(isChore(mine.subject)
      ? `You are in chore ${mine.subject} (${ws.root}); its record is its commits. Land with canon chore land.`
      : `You are in ${mine.subject} (${ws.root}). Read it: canon show ${mine.subject}; context: canon context ${mine.subject}`);
    const h = hs.find((x) => x.subject === mine.subject);
    if (h) say(`Handoff from ${h.actor} at ${h.updated_at}: next — ${h.next}${h.note ? `\n${h.note}` : ""}`);
    // The last landing from this worktree, when it was killed before it recorded a result (BR-2310).
    const landing = attemptIn(ws.db, ws.config.main, ws.root);
    if (landing?.state === "interrupted") for (const line of describeAttempt(landing)) say(line);
    const overlaps = overlapsOf(ws, ws.root);
    for (const u of overlaps.unreadable) say(`Overlap check failed: ${u}`);
    for (const o of overlaps.found) say(`Overlap: ${o.change} also changes ${o.files.join(", ")}`);
    // Open review notes on the rules and decisions this change names, handled in this change if it touches them (BR-2147).
    const corpus = corpusOf(ws).corpus;
    const own = findDoc(corpus, mine.subject);
    if (own) for (const n of openNotes(ws.db, [...referencedIds(own, ws.config.types)].filter((id) => id !== own.id))) say(`Open review note on ${renderNote(n)}`);
    // Open review findings on the same documents, each once; they stay until closed explicitly (BR-2437, D-89).
    if (own) for (const f of openFindings(ws.db, [...referencedIds(own, ws.config.types)].filter((id) => id !== own.id))) say(`Open review finding ${renderFinding(f)}`);
    // Suspect references on the rules and decisions this change names (BR-2429).
    if (own) for (const line of suspectNotice(ws.root, corpus, ws.config.linksSince, referencedIds(own, ws.config.types))) say(line);
  } else {
    // reason: other sessions' handoffs and the question queue are shown only where no change is claimed; injected
    // into a change's session they draw it into work that is not its own (BR-2024)
    // The whole progress first, so a session starts from the release and not from the latest small change (BR-2506);
    // a failure is said in one line, never fatal: the rest of the brief still comes.
    const progress = overview(ws, { ruleCounts: false });
    if (progress.ok) for (const line of briefSummary(progress.value)) say(line);
    else say(`Overall progress unavailable: ${progress.error.message}`);
    // Commits on main the remote lacks, counted locally; like the handoffs, only where no change is claimed (BR-2261, BR-2024).
    for (const line of unpushedNotice(ws)) say(line);
    if (hs.length) say(`Unfinished changes with handoffs: ${hs.map((h) => h.subject).join(", ")} (canon work status)`);
    const chores = choresInFlight(ws);
    if (!chores.ok) say(`Cannot list unfinished chores: ${chores.error.message}`);
    else if (chores.value.length) say(`Unfinished chores (resume with canon chore start <identity>): ${chores.value.map((c) => c.subject).join(", ")}`);
    const pending = questions(ws.db, "pending").length;
    if (pending) say(`${pending} question(s) wait for a human (canon human pending)`);
    // Decisions left proposed for long, oldest first; like the questions, only where no change is claimed (BR-2476, BR-2024).
    const mainDocs = mainCorpus(ws);
    if (mainDocs.ok) for (const line of proposedNotice(ws.primary, ws.config.main, mainDocs.value)) say(line);
    // Open review findings project-wide, counted (BR-2437).
    const findings = findingsCount(ws.db);
    if (findings) say(findings);
    // Suspect references project-wide, counted (BR-2429).
    for (const line of suspectNotice(ws.root, corpusOf(ws).corpus, ws.config.linksSince)) say(line);
    // The owner's order of open changes on main and on change branches main lacks yet, the same list and marks as
    // canon change list, so an agent without a task takes the first unclaimed one (BR-2149, BR-2291, D-20, D-50).
    const onMain = mainCorpus(ws);
    if (!onMain.ok) return onMain;
    const backlog = backlogAt(ws.primary, ws.config.main, ws.config.types);
    if (!backlog.ok) return backlog;
    // reason: (claimed) only where `canon work start` would refuse; an expired or abandoned claim it takes over (BR-2149, BR-2100)
    // reason: every change is read once; the plans need the done and dropped ones too, the order only the open ones
    // and those done only on their branch, as listedChanges keeps them (BR-2383, BR-2294)
    const every = listedChanges(ws, onMain.value, backlog.value, () => true);
    if (!every.ok) return every;
    // reason: another session's half-done branch is said, never fatal: brief must still list everything else (BR-2292)
    for (const u of every.value.unreadable) say(`Unreadable change file, not listed: ${u}`);
    // Plans with steps ready to start, one line each, so a coordinator sees what to dispatch (BR-2383).
    const stalled = stalledDelegations(ws);
    if (!stalled.ok) say(`Cannot tell stalled delegations: ${stalled.error.message}`);
    for (const p of planStatuses(onMain.value, every.value.listed.map((l) => ({ change: l.change, onMain: l.onBranch.length === 0 })), new Set(stalled.ok ? stalled.value.map((s) => s.subject) : []))) {
      const line = briefLine(p);
      if (line) say(line);
    }
    const open = every.value.listed.filter((l) => l.change.status === "open" || (l.onBranch.length > 0 && l.change.status === "done"));
    const shown = (l: (typeof open)[number]) => {
      const marks = marksOf(l, false);
      return marks.length ? `${l.change.id} (${marks.join(", ")})` : l.change.id;
    };
    // reason: a change waiting for its dependencies is not offered to take; it is listed apart with what it waits for (BR-2564)
    const ready = open.filter((l) => l.waiting.length === 0);
    const waiting = open.filter((l) => l.waiting.length > 0);
    if (ready.length) say(`Open changes in the owner's order (canon change list); with no task, take the first unclaimed, not ambiguous one: ${ready.map(shown).join(", ")}`);
    if (waiting.length) say(`Waiting for dependencies, not ready to start: ${waiting.map(shown).join(", ")}`);
    // The main session's due list and, in Claude Code, the standing watch; a worker runs headless and has neither (BR-2529, D-136).
    if (!isWorker(ws.actor)) for (const line of dueSection(ws, env)) say(line);
  }
  // The schema editors read for canon/config.yaml, from this canon; a failure is said, never fatal (BR-2176).
  const schema = writeSchemaFile(ws.root);
  if (!schema.ok) say(schema.error.message);
  const background = backgroundNotice(settleBackgroundHooks(ws.db, ws.actor));
  if (background) say(background);
  noticeUpdates(ws, say);
  return ok(undefined);
}

export const sessionCommands: DomainCommands = {
  commands: [
    entry("brief", 20, brief),
    entry("start", 10, startCmd, "work"),
    entry("start", 10, choreStartCmd, "chore"),
    entry("stop", 40, stopCmd, "work"),
    entry("status", 50, status, "work"),
    entry("clean", 80, cleanCmd, "work"),
  ],
};
