import { proposedNotice } from "./proposed.ts";
import { relocate, relocationLine } from "./relocate.ts";
import { goalActor, goalOf } from "../goal/goal.ts";
import { stalledLine } from "../delegation/stall.ts";
import { changeStates, hasFile, isClosed, marksOf, type ChangeState } from "../../knowledge/changes/state.ts";
import { fstatSync, readFileSync } from "node:fs";
import { readRuntime } from "../../kernel/agent.ts";
import { recordCodexStartup } from "../agent-session.ts";
import { machineNow, startHint } from "./load.ts";
import { defineCommand } from "citty";
import { writeSchemaFile } from "../../invocation/reference/reference.ts";
import { AS_ARG, RUNTIME_ARG, corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { takesMany } from "../../invocation/strict.ts";
import { delegationNotice } from "../delegation/records.ts";
import { recordWorkerProfile } from "../delegation/designer.ts";
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
import { priorityLine } from "../priority/set.ts";
import type { Assigned } from "../priority/store.ts";
import { agenda, summary } from "../reminders/agenda.ts";
import { isWorker } from "../delegation/worker.ts";
import { attemptIn, describeAttempt, goneLanders, openAttempts } from "../land/queue/interrupted.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";
import { firstLine, handoffs, HANDOFF_REASONS, reasonText, setHandoffReason } from "./handoffs.ts";
import { reasonArg, whyOn } from "./reason.ts";
import { overlapsOf } from "./overlap.ts";
import { clean, LESSON_REMINDER, mainCorpus, start, startChore, stop } from "./session.ts";
import { CLEAN_DONE, cleanAfterLanding } from "./clean-after-land.ts";
import { choreIn, choresInFlight, isChore, normalizeSubject } from "./subject.ts";
import { redMainNotice, startFixMain } from "../watch/redmain.ts";
import { ensureWatcher, untestedNotice } from "../watch/watch.ts";
import { startTrailingReview, unreviewedNotice } from "../../knowledge/review/code-review-batch.ts";
import { failedReviewNotice } from "../../knowledge/review/landed-queue.ts";
import { unpushedNotice } from "../remote/remote.ts";
import { briefSummary, overview } from "../overview/overview.ts";
import { LINK_ARGS, newLinks } from "../../knowledge/changes/commands.ts";
import { remindNew } from "../../knowledge/changes/duplicates.ts";
import { statedArgs, statedFor, statedInput } from "../../knowledge/documents/stated.ts";

/** `canon brief` and `canon work start`, `stop`, `status`, `clean`: a session and its change's worktree. */

const startCmd = defineCommand({
  meta: { description: "Start a change in its own worktree: `--title` for a new one, or an existing change id" },
  args: {
    change: { type: "positional", required: false },
    title: { type: "string" },
    rules: { type: "string", description: "Rule ids the new change touches" },
    "fix-main": { type: "boolean", description: "Open the one change that fixes main's failing background floor (floor_timing: after, BR-2221)" },
    settles: { type: "string", description: "Open review finding numbers this change settles, comma separated (BR-2530)" },
    ...LINK_ARGS,
    ...statedArgs("change"),
    ...AS_ARG,
  },
  run({ args }) {
    const ws = workspace(args.as);
    const fixMain = Boolean(args["fix-main"]);
    const stated = statedInput("change", args as Record<string, unknown>);
    if (fixMain && (args.change || args.title || args.rules)) fail({ code: "invalid", message: "--fix-main opens its own change; give no change id, --title or --rules with it" });
    if (!fixMain && !args.change && !args.title) fail({ code: "invalid", message: "give a change id, --title for a new change, or --fix-main" });
    const linked = Object.keys(LINK_ARGS).some((k) => (args as Record<string, unknown>)[k] !== undefined);
    if (linked && (args.change || !args.title || fixMain)) fail({ code: "invalid", message: "--release, --feature, --issue and --depends go with --title for a new change; an existing change's links are edited with canon change link (BR-2562)" });
    if ((args.change || fixMain) && (stated.set.length > 0 || Object.keys(stated.flags).length > 0)) fail({ code: "invalid", message: "--set, --owner-gate and --advances go with --title for a new change; an existing change's fields are set with canon doc set (BR-2620, BR-2621)" });
    // reason: checked on main, which the new branch starts from, before an id is allocated (BR-2562)
    const links = linked ? newLinks(ws, args as Record<string, unknown>, must(mainCorpus(ws))) : undefined;
    // reason: checked on main, before an id is allocated or a branch made (BR-2620)
    const fields = !args.change && !fixMain ? must(statedFor(must(mainCorpus(ws)), "change", args as Record<string, unknown>)) : undefined;
    const target = typeof args.change === "string" && args.change ? { change: args.change } : { title: String(args.title), rules: list(args.rules), ...(links ? { links } : {}), ...(fields ? { fields } : {}) };
    const settles = list(args.settles).map((v) => v.replace(/^#/, ""));
    if (settles.some((v) => !/^[1-9]\d*$/.test(v))) fail({ code: "invalid", message: `--settles takes review finding numbers, comma separated (got ${String(args.settles)})` });
    if (fixMain && settles.length > 0) fail({ code: "invalid", message: "--fix-main opens its own change; give no --settles with it" });
    const s = must(fixMain ? startFixMain(ws, say) : start(ws, target, say, { settles: settles.map(Number) }));
    // reason: a new change is compared with the unfinished ones by title; a reminder only, after it started (BR-2656, D-171)
    if ("title" in target) remindNew(ws, s.change, target.title, say);
    for (const line of startHint(ws.db, machineNow(), { fixMain, created: s.created })) say(line);
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
  args: {
    reason: { type: "string", description: `Why you stop: ${HANDOFF_REASONS.join(", ")} (land: done, waiting to land; design: waiting for design; owner: waiting for the owner, with --on; deps: waiting on dependencies; partial: partly done) (BR-2025)` },
    on: { type: "string", description: "With --reason owner: the question it waits on (#12, asked with canon human ask --change) or a success criterion (R-2/S3)" },
    next: { type: "string", required: true },
    note: { type: "string" },
    release: { type: "boolean", description: "Release the claim too" },
    ...AS_ARG,
  },
  run({ args }) {
    const ws = workspace(args.as);
    const subject = must(stop(ws, String(args.next), typeof args.note === "string" ? args.note : undefined, Boolean(args.release), { reason: args.reason, on: args.on }, say));
    say(`${subject}: handoff recorded${args.release ? ", claim released" : ""}`);
    if (!isChore(subject)) say(LESSON_REMINDER);
  },
});

/** `canon work handoff-reason`: set the reason of an existing handoff, the way old handoffs are migrated (BR-2575, D-151). */
const handoffReasonCmd = defineCommand({
  meta: { description: "Set or change the reason of a change's existing handoff (no claim needed): how a handoff written before reasons existed is migrated" },
  args: {
    change: { type: "positional", required: true, description: "The change (C-n) whose handoff it is" },
    reason: { type: "string", description: `One of ${HANDOFF_REASONS.join(", ")} (BR-2025)` },
    on: { type: "string", description: "With --reason owner: the question (#12, asked with canon human ask --change) or success criterion (R-2/S3) it waits on" },
  },
  run({ args }) {
    const ws = workspace();
    const subject = normalizeSubject(String(args.change));
    const given = must(reasonArg(args.reason, args.on));
    if (!handoffs(ws.db).some((h) => h.subject === subject)) fail({ code: "not_found", message: `${subject} has no handoff; canon work stop --reason in its worktree records one (BR-2575)` });
    const why = must(whyOn(ws, subject, given));
    setHandoffReason(ws.db, ws.actor, subject, why);
    say(`${subject}: handoff reason ${reasonText(why)}`);
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
    // reason: stalled and closed come from the change states, computed once for both (BR-2522, BR-2497, BR-2571)
    const states = must(changeStates(ws, { delegatable: false })).states;
    const stalled = states.flatMap((s) => (s.stalled ? [s.stalled] : []));
    const closed = new Set(states.filter(isClosed).map((s) => s.id));
    const data = { chores, ...(stalled.length > 0 ? { stalled } : {}), ...(untested.length > 0 ? { untested } : {}), ...(unreviewed.length > 0 ? { unreviewed } : {}), ...(failedReviews.length > 0 ? { failed_reviews: failedReviews } : {}), claims: claimsWithState(ws.db), queue: activeQueue(ws.db).map((q) => ({ ...q, lander_gone: gone.has(q.id) })), landings: openAttempts(ws.db, ws.config.main), resolving: keptPlaces(ws.db), handoffs: handoffs(ws.db), questions: questions(ws.db, "pending"), design_requests: pendingRequests(ws.db), urgent: marks(ws.db), priorities: openPriorities(states).map((a) => ({ change: a.change, tier: a.tier, by: a.by, at: a.at, words: a.words, actor: a.actor, owner_tier: a.ownerTier, owner_words: a.ownerWords })) };
    if (args.json) return json(data);
    const delegated = ws.db.db.query<{ subject: string }, []>("SELECT subject FROM delegations ORDER BY subject").all().map((r) => r.subject).filter((s) => !closed.has(s));
    for (const subject of delegated) for (const line of delegationNotice(ws.db, subject)) say(line);
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
    // Each open change with a tier set, who set it, when and why; a closed change's tier has no effect (BR-2603).
    if (data.priorities.length > 0) say("Priorities:");
    for (const a of openPriorities(states)) say(priorityLine(a));
    say("Handoffs:");
    for (const h of data.handoffs) say(`  ${h.subject.padEnd(8)} ${reasonText(h)}: next: ${firstLine(h.next)}  (${h.actor}, ${h.updated_at})`);
    say(`Questions waiting for a human: ${data.questions.length}`);
  },
});

/** The tiers set on changes that are not closed, in the order the changes are listed (BR-2603). */
function openPriorities(states: readonly ChangeState[]): Assigned[] {
  return states.flatMap((s) => (s.priority ? [s.priority] : []));
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

/**
 * The session id of the session-start event the host gave `canon brief` on standard input (BR-2633), or undefined when
 * there is none: input from a terminal, nothing readable within a second, or an event that is not `SessionStart`.
 */
async function hostStartInput(): Promise<{ readonly session?: string; readonly open: boolean }> {
  try {
    if (process.stdin.isTTY) return { open: false };
    const kind = fstatSync(0);
    // reason: a hook's input is a pipe, a socket (Node's stdio pipes are socket pairs) or a file; a terminal or other device is never read (BR-2633)
    if (!kind.isFIFO() && !kind.isFile() && !kind.isSocket()) return { open: false };
  } catch {
    return { open: false };
  }
  const text = await Promise.race([Bun.stdin.text(), Bun.sleep(1000).then(() => undefined)]);
  // reason: a read that lost the race would keep the process alive; the brief then ends by exiting (BR-2633)
  if (text === undefined) return { open: true };
  try {
    const input: unknown = JSON.parse(text);
    if (input === null || typeof input !== "object" || !("hook_event_name" in input) || input.hook_event_name !== "SessionStart" || !("session_id" in input) || typeof input.session_id !== "string" || input.session_id.trim() === "") return { open: false };
    return { session: input.session_id.trim(), open: false };
  } catch {
    return { open: false };
  }
}

const brief = defineCommand({
  args: { ...RUNTIME_ARG, hook: { type: "boolean", description: "Read Codex startup JSON and record its session relationship" } },
  meta: { description: "Session start: how to work in a canon project, in a change's worktree that change and its handoff, elsewhere what is in flight (printed by the session-start hook)" },
  async run({ args }) {
    // reason: the guide comes before anything that can fail, and failures are also said on stdout, which is what a
    // session-start hook shows the model; without it a session would know nothing about canon (BR-2090)
    // reason: the overview line needs the project root, found before anything that can fail; outside a repository the plain guide is printed and the failure follows (BR-2090)
    const top = toplevel(process.cwd());
    say(top.ok ? guideFor(top.value) : WORKFLOW_GUIDE);
    const failed = (what: string) =>
      say(`canon brief failed: ${what}\nFix this, then run canon brief again. Until then work as the guide above says; do not edit the main branch directly.`);
    let env = process.env;
    let codexStart: { id: string; child?: string } | undefined;
    // reason: Claude Code's session-start hook gives the start event on standard input; read before anything else, only from a pipe or a file, and never waited on for long (BR-2633)
    const started = args.hook ? { open: false } : await hostStartInput();
    if (args.hook) {
      const runtime = readRuntime(args.runtime);
      if (!runtime.ok || runtime.value !== "codex") {
        const error = { code: "invalid" as const, message: "canon brief --hook requires --runtime codex" };
        failed(error.message);
        fail(error);
      }
      const registered = recordCodexStartup(process.cwd(), readFileSync(0, "utf8"), process.env["CANON_ACTOR"]);
      if (!registered.ok) { failed(registered.error.message); fail(registered.error); }
      codexStart = registered.value;
      env = { ...process.env, CODEX_SESSION_ID: registered.value.id, CODEX_THREAD_ID: registered.value.child ?? registered.value.id };
    }
    const opened = openWorkspace(process.cwd(), undefined, env);
    if (!opened.ok) {
      failed(opened.error.message);
      fail(opened.error);
    }
    // reason: the profile of a worker session is written by the host's session-start event and by nothing else (BR-2633, D-162)
    const profiled = args.hook && codexStart ? recordWorkerProfile(opened.value.db, "codex", codexStart.id, env, undefined) : started.session !== undefined ? recordWorkerProfile(opened.value.db, "claude", started.session, env) : ok(false);
    if (!profiled.ok) {
      failed(profiled.error.message);
      fail(profiled.error);
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
    if (started.open) process.exit(0);
  },
});

/** The text of the Monitor hint `canon brief` prints in a Claude Code main session (BR-2529). */
export const MONITOR_HINT = "Keep canon work watch running under Monitor (timeout 30 min); when it expires, re-arm with --since <the last event number it printed>.";

/** BR-2529: the agenda summary when the agenda is not empty; the Monitor hint whenever the session runs in Claude Code. */
function agendaSection(ws: Workspace, env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  const a = agenda(ws);
  if (!a.ok) out.push(`Cannot work out the agenda: ${a.error.message}`);
  else out.push(...summary(a.value));
  if (env["CLAUDECODE"] === "1") out.push(MONITOR_HINT);
  return out;
}

/** What `canon brief` says after the guide: in a claimed worktree only its own change; elsewhere the handoffs and questions; then the update notice. */
function briefState(ws: Workspace, env: Readonly<Record<string, string | undefined>> = process.env): Result<void> {
  // reason: a moved repository's recorded paths are fixed before anything below reads them, the claim of this worktree first (BR-2649)
  const moved = relocate(ws);
  if (moved) say(relocationLine(moved, ws));
  const claimed = claimOfWorktree(ws.db, ws.root);
  const chore = choreIn(ws);
  if (!chore.ok) return chore;
  if (claimed && chore.value && claimed.subject !== chore.value) return err("conflict", "worktree and claim identity disagree");
  const mine = claimed ?? (chore.value ? { subject: chore.value } : undefined);
  const hs = handoffs(ws.db);
  // A failing main comes first, in every worktree (BR-2220); then the background floor starts if main's latest commit needs it (BR-2219).
  for (const line of redMainNotice(ws.db, mine?.subject, ws.actor)) say(line);
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
    if (h) say(`Handoff from ${h.actor} at ${h.updated_at} (${reasonText(h)}): next — ${h.next}${h.note ? `\n${h.note}` : ""}`);
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
    const progress = overview(ws, { ruleCounts: false, agenda: false });
    if (progress.ok) {
      for (const line of briefSummary(progress.value)) say(line);
      // reason: goal mode is the session's to turn on (D-132); the brief is where a session learns it exists, once a release is in progress (BR-2506)
      const goalSession = goalActor();
      if (progress.value.releases.some((r) => !r.fallback) && goalSession.ok && goalSession.value && !goalOf(ws.db, goalSession.value)) say("  goal mode is off for this session: canon goal start keeps it working toward these success criteria (canon goal stop ends it)");
    } else say(`Overall progress unavailable: ${progress.error.message}`);
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
    // reason: every change is read once, with its state from the one place that computes it; the order lists only the
    // open ones and those done only on their branch (BR-2294, BR-2571)
    const every = changeStates(ws, { corpus: onMain.value, backlog: backlog.value, delegatable: false });
    if (!every.ok) return every;
    // reason: another session's half-done branch is said, never fatal: brief must still list everything else (BR-2292)
    for (const u of every.value.unreadable) say(`Unreadable change file, not listed: ${u}`);
    const filed = every.value.states.filter(hasFile);
    const open = filed.filter((s) => s.change.status === "open" || (s.onBranch.length > 0 && s.change.status === "done"));
    const shown = (s: ChangeState) => {
      const marks = marksOf(s, false);
      return marks.length ? `${s.id} (${marks.join(", ")})` : s.id;
    };
    // reason: a change waiting for its dependencies or the owner, or whose work is already on main, is not offered to
    // take; each is listed apart with what it waits for (BR-2564, BR-2571)
    const apart = new Set(["waiting-deps", "waiting-owner", "awaiting-close"]);
    const ready = open.filter((s) => !apart.has(s.state));
    const of = (state: string) => open.filter((s) => s.state === state);
    if (ready.length) say(`Open changes in the owner's order (canon change list); with no task, take the first unclaimed, not ambiguous one: ${ready.map(shown).join(", ")}`);
    if (of("waiting-deps").length) say(`Waiting for dependencies, not ready to start: ${of("waiting-deps").map(shown).join(", ")}`);
    const owed = of("waiting-owner").map((s) => `${s.id} (${[...s.ownerQuestions.map((n) => `#${n}`), ...s.waiting.filter((w) => w.state === "owner").map((w) => w.id)].join(", ")})`);
    if (owed.length) say(`Waiting for the owner, not ready to start (ask them; canon human pending): ${owed.join(", ")}`);
    const onMainAlready = of("awaiting-close").map((s) => s.id);
    if (onMainAlready.length) say(`Work already on main, close it instead of starting it (canon change close <C-n> --commit <commit>): ${onMainAlready.join(", ")}`);
    // The main session's agenda summary and, in Claude Code, the standing watch; a worker runs headless and has neither (BR-2529, D-151).
    if (!isWorker(ws.actor)) for (const line of agendaSection(ws, env)) say(line);
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
    entry("handoff-reason", 41, handoffReasonCmd, "work"),
    entry("status", 50, status, "work"),
    entry("clean", 80, cleanCmd, "work"),
  ],
};
