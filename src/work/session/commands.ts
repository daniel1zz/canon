import { defineCommand } from "citty";
import { writeSchemaFile } from "../../invocation/reference/reference.ts";
import { AS_ARG, corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { takesMany } from "../../invocation/strict.ts";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { noticeUpdates } from "../../install/commands.ts";
import { backgroundNotice, settleBackgroundHooks } from "../hooks/hooks.ts";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { backlogAt } from "../../knowledge/documents/backlog.ts";
import { findDoc, referencedIds } from "../../knowledge/query/query.ts";
import { openNotes, renderNote } from "../../knowledge/review/notes.ts";
import { claimOfWorktree, claimsWithState, type ClaimState } from "../claims/claims.ts";
import { questions } from "../humans/questions.ts";
import { activeQueue, keptPlaces } from "../land/queue/queue.ts";
import { attemptIn, describeAttempt, goneLanders, openAttempts } from "../land/queue/interrupted.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";
import { handoffs } from "./handoffs.ts";
import { listedChanges, marksOf } from "./inflight.ts";
import { overlapsOf } from "./overlap.ts";
import { clean, LESSON_REMINDER, mainCorpus, start, stop } from "./session.ts";
import { redMainNotice, startFixMain } from "../watch/redmain.ts";
import { ensureWatcher, untestedNotice } from "../watch/watch.ts";
import { startTrailingReview, unreviewedNotice } from "../../knowledge/review/code-review-batch.ts";
import { unpushedNotice } from "../remote/remote.ts";

/** `canon brief` and `canon work start`, `stop`, `status`, `clean`: a session and its change's worktree. */

const startCmd = defineCommand({
  meta: { description: "Start a change in its own worktree: `--title` for a new one, or an existing change id" },
  args: {
    change: { type: "positional", required: false },
    title: { type: "string" },
    rules: { type: "string", description: "Rule ids the new change touches" },
    "fix-main": { type: "boolean", description: "Open the one change that fixes main's failing background floor (floor_timing: after, BR-2221)" },
    ...AS_ARG,
  },
  run({ args }) {
    const ws = workspace(args.as);
    const fixMain = Boolean(args["fix-main"]);
    if (fixMain && (args.change || args.title || args.rules)) fail({ code: "invalid", message: "--fix-main opens its own change; give no change id, --title or --rules with it" });
    if (!fixMain && !args.change && !args.title) fail({ code: "invalid", message: "give a change id, --title for a new change, or --fix-main" });
    const target = typeof args.change === "string" && args.change ? { change: args.change } : { title: String(args.title), rules: list(args.rules) };
    const s = must(fixMain ? startFixMain(ws, say) : start(ws, target, say));
    noticeUpdates(ws, say);
    say(`cd ${s.worktree}`);
  },
});

const stopCmd = defineCommand({
  meta: { description: "Hand off: record the next step for whoever continues this change" },
  args: { next: { type: "string", required: true }, note: { type: "string" }, release: { type: "boolean", description: "Release the claim too" }, ...AS_ARG },
  run({ args }) {
    const ws = workspace(args.as);
    const subject = must(stop(ws, String(args.next), typeof args.note === "string" ? args.note : undefined, Boolean(args.release), say));
    say(`${subject}: handoff recorded${args.release ? ", claim released" : ""}`);
    say(LESSON_REMINDER);
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
    const data = { ...(untested.length > 0 ? { untested } : {}), ...(unreviewed.length > 0 ? { unreviewed } : {}), claims: claimsWithState(ws.db), queue: activeQueue(ws.db).map((q) => ({ ...q, lander_gone: gone.has(q.id) })), landings: openAttempts(ws.db, ws.config.main), resolving: keptPlaces(ws.db), handoffs: handoffs(ws.db), questions: questions(ws.db, "pending") };
    if (args.json) return json(data);
    for (const line of [...untested, ...unreviewed]) say(line);
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
    say("Handoffs:");
    for (const h of data.handoffs) say(`  ${h.subject.padEnd(8)} next: ${h.next}  (${h.actor}, ${h.updated_at})`);
    say(`Questions waiting for a human: ${data.questions.length}`);
  },
});

/** How `canon work status` marks a claim that no longer binds (BR-2192). */
const STALE: Record<ClaimState, string> = { live: "", expired: "  (expired: lease ended)", "holder-gone": "  (expired: session process exited)" };

const cleanCmd = takesMany(defineCommand({
  meta: { description: "Remove worktrees that are clean and fully landed; list the rest with the reason they stay. Name changes to remove only theirs" },
  args: { changes: { type: "positional", required: false, description: "Only these changes' worktrees (C-n ...)" } },
  run({ args }) {
    const ws = workspace();
    const r = must(clean(ws, say, args._.map(String)));
    for (const k of r.kept) say(`kept ${k}`);
  },
}));

const brief = defineCommand({
  meta: { description: "Session start: how to work in a canon project, in a change's worktree that change and its handoff, elsewhere what is in flight (printed by the session-start hook)" },
  run() {
    // reason: the guide comes before anything that can fail, and failures are also said on stdout, which is what a
    // session-start hook shows the model; without it a session would know nothing about canon (BR-2090)
    say(WORKFLOW_GUIDE);
    const failed = (what: string) =>
      say(`canon brief failed: ${what}\nFix this, then run canon brief again. Until then work as the guide above says; do not edit the main branch directly.`);
    const opened = openWorkspace(process.cwd());
    if (!opened.ok) {
      failed(opened.error.message);
      fail(opened.error);
    }
    let state: Result<void>;
    try {
      state = briefState(opened.value);
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

/** What `canon brief` says after the guide: in a claimed worktree only its own change; elsewhere the handoffs and questions; then the update notice. */
function briefState(ws: Workspace): Result<void> {
  const mine = claimOfWorktree(ws.db, ws.root);
  const hs = handoffs(ws.db);
  // A failing main comes first, in every worktree (BR-2220); then the background floor starts if main's latest commit needs it (BR-2219).
  for (const line of redMainNotice(ws.db, mine?.subject)) say(line);
  ensureWatcher(ws, say);
  for (const line of [...untestedNotice(ws), ...unreviewedNotice(ws)]) say(line);
  // The last batch of a burst has no later landing to review it (BR-2316).
  startTrailingReview(ws, say);
  if (mine) {
    say(`You are in ${mine.subject} (${ws.root}). Read it: canon show ${mine.subject}; context: canon context ${mine.subject}`);
    const h = hs.find((x) => x.subject === mine.subject);
    if (h) say(`Handoff from ${h.actor} at ${h.updated_at}: next — ${h.next}${h.note ? `\n${h.note}` : ""}`);
    // The last landing from this worktree, when it was killed before it recorded a result (BR-2310).
    const landing = attemptIn(ws.db, ws.config.main, ws.root);
    if (landing?.state === "interrupted") for (const line of describeAttempt(landing)) say(line);
    const overlaps = overlapsOf(ws, ws.root);
    for (const u of overlaps.unreadable) say(`Overlap check failed: ${u}`);
    for (const o of overlaps.found) say(`Overlap: ${o.change} also changes ${o.files.join(", ")}`);
    // Open review notes on the rules and decisions this change names, handled in this change if it touches them (BR-2147).
    const own = findDoc(corpusOf(ws).corpus, mine.subject);
    if (own) for (const n of openNotes(ws.db, [...referencedIds(own, ws.config.types)].filter((id) => id !== own.id))) say(`Open review note on ${renderNote(n)}`);
  } else {
    // reason: other sessions' handoffs and the question queue are shown only where no change is claimed; injected
    // into a change's session they draw it into work that is not its own (BR-2024)
    // Commits on main the remote lacks, counted locally; like the handoffs, only where no change is claimed (BR-2261, BR-2024).
    for (const line of unpushedNotice(ws)) say(line);
    if (hs.length) say(`Unfinished changes with handoffs: ${hs.map((h) => h.subject).join(", ")} (canon work status)`);
    const pending = questions(ws.db, "pending").length;
    if (pending) say(`${pending} question(s) wait for a human (canon human pending)`);
    // The owner's order of open changes on main and on change branches main lacks yet, the same list and marks as
    // canon change list, so an agent without a task takes the first unclaimed one (BR-2149, BR-2291, D-20, D-50).
    const onMain = mainCorpus(ws);
    if (!onMain.ok) return onMain;
    const backlog = backlogAt(ws.primary, ws.config.main, ws.config.types);
    if (!backlog.ok) return backlog;
    // reason: (claimed) only where `canon work start` would refuse; an expired or abandoned claim it takes over (BR-2149, BR-2100)
    const open = listedChanges(ws, onMain.value, backlog.value, (c) => c.status === "open");
    if (!open.ok) return open;
    // reason: another session's half-done branch is said, never fatal: brief must still list everything else (BR-2292)
    for (const u of open.value.unreadable) say(`Unreadable change file, not listed: ${u}`);
    if (open.value.listed.length) {
      const order = open.value.listed.map((l) => {
        const marks = marksOf(l, false);
        return marks.length ? `${l.change.id} (${marks.join(", ")})` : l.change.id;
      });
      say(`Open changes in the owner's order (canon change list); with no task, take the first unclaimed, not ambiguous one: ${order.join(", ")}`);
    }
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
    entry("stop", 40, stopCmd, "work"),
    entry("status", 50, status, "work"),
    entry("clean", 80, cleanCmd, "work"),
  ],
};
