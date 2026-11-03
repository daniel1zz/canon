import { defineCommand } from "citty";
import { writeSchemaFile } from "../../config/reference/reference.ts";
import { corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { takesMany } from "../../cli/strict.ts";
import { WORKFLOW_GUIDE } from "../../cli/guide.ts";
import { noticeUpdates } from "../../cli/install/commands.ts";
import { backgroundNotice, settleBackgroundHooks } from "../../config/hooks.ts";
import { git } from "../../kernel/git.ts";
import type { Change } from "../../knowledge/documents/model.ts";
import { BACKLOG_FILE, inBacklogOrder, parseBacklog } from "../../knowledge/documents/backlog.ts";
import { findDoc, referencedIds } from "../../knowledge/query/query.ts";
import { openNotes, renderNote } from "../../knowledge/review/notes.ts";
import { claimOfWorktree, claims } from "../claims/claims.ts";
import { questions } from "../humans/questions.ts";
import { activeQueue } from "../land/queue.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";
import { handoffs } from "./handoffs.ts";
import { overlapsOf } from "./overlap.ts";
import { clean, LESSON_REMINDER, mainCorpus, start, stop } from "./session.ts";

/** `canon brief` and `canon work start`, `stop`, `status`, `clean`: a session and its change's worktree. */

const startCmd = defineCommand({
  meta: { description: "Start a change in its own worktree: `--title` for a new one, or an existing change id" },
  args: { change: { type: "positional", required: false }, title: { type: "string" }, rules: { type: "string", description: "Rule ids the new change touches" } },
  run({ args }) {
    const ws = workspace();
    if (!args.change && !args.title) fail({ code: "invalid", message: "give a change id or --title for a new change" });
    const target = typeof args.change === "string" && args.change ? { change: args.change } : { title: String(args.title), rules: list(args.rules) };
    const s = must(start(ws, target, say));
    noticeUpdates(ws, say);
    say(`cd ${s.worktree}`);
  },
});

const stopCmd = defineCommand({
  meta: { description: "Hand off: record the next step for whoever continues this change" },
  args: { next: { type: "string", required: true }, note: { type: "string" }, release: { type: "boolean", description: "Release the claim too" } },
  run({ args }) {
    const ws = workspace();
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
    const data = { claims: claims(ws.db), queue: activeQueue(ws.db), handoffs: handoffs(ws.db), questions: questions(ws.db, "pending") };
    if (args.json) return json(data);
    say("Claims:");
    for (const c of data.claims) say(`  ${c.subject.padEnd(8)} ${c.actor}  ${c.holder}  until ${c.expires_at}`);
    say("Landing queue:");
    for (const q of data.queue) say(`  #${q.id} ${q.state.padEnd(8)} ${q.subject ?? "-"}  ${q.worktree}`);
    say("Handoffs:");
    for (const h of data.handoffs) say(`  ${h.subject.padEnd(8)} next: ${h.next}  (${h.actor}, ${h.updated_at})`);
    say(`Questions waiting for a human: ${data.questions.length}`);
  },
});

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
    try {
      briefState(opened.value);
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e));
      throw e;
    }
  },
});

/** The backlog as committed on main, which is where the owner's order lives (D-20). */
function mainBacklog(ws: Workspace) {
  const at = `${ws.config.main}:${BACKLOG_FILE}`;
  if (!git(ws.primary, "cat-file", "-e", at).ok) return [];
  const text = git(ws.primary, "show", at);
  if (!text.ok) throw new Error(`cannot read ${at}: ${text.error.message}`);
  return parseBacklog(text.value, ws.config.types);
}

/** What `canon brief` says after the guide: in a claimed worktree only its own change; elsewhere the handoffs and questions; then the update notice. */
function briefState(ws: Workspace) {
  const mine = claimOfWorktree(ws.db, ws.root);
  const hs = handoffs(ws.db);
  if (mine) {
    say(`You are in ${mine.subject} (${ws.root}). Read it: canon show ${mine.subject}; context: canon context ${mine.subject}`);
    const h = hs.find((x) => x.subject === mine.subject);
    if (h) say(`Handoff from ${h.actor} at ${h.updated_at}: next — ${h.next}${h.note ? `\n${h.note}` : ""}`);
    for (const o of overlapsOf(ws, ws.root)) say(`Overlap: ${o.change} also changes ${o.files.join(", ")}`);
    // Open review notes on the rules and decisions this change names, handled in this change if it touches them (BR-2147).
    const own = findDoc(corpusOf(ws).corpus, mine.subject);
    if (own) for (const n of openNotes(ws.db, [...referencedIds(own, ws.config.types)].filter((id) => id !== own.id))) say(`Open review note on ${renderNote(n)}`);
  } else {
    // reason: other sessions' handoffs and the question queue are shown only where no change is claimed; injected
    // into a change's session they draw it into work that is not its own (BR-2024)
    if (hs.length) say(`Unfinished changes with handoffs: ${hs.map((h) => h.subject).join(", ")} (canon work status)`);
    const pending = questions(ws.db, "pending").length;
    if (pending) say(`${pending} question(s) wait for a human (canon human pending)`);
    // The owner's order of open changes on main, so an agent without a task takes the first unclaimed one (BR-2149, D-20).
    const onMain = mainCorpus(ws);
    if (!onMain.ok) throw new Error(onMain.error.message);
    const open = onMain.value.docs.filter((d): d is Change => d.kind === "change" && d.status === "open");
    if (open.length) {
      const held = new Set(claims(ws.db).map((c) => c.subject));
      const order = inBacklogOrder(open, mainBacklog(ws)).map((c) => (held.has(c.id) ? `${c.id} (claimed)` : c.id));
      say(`Open changes in the owner's order (canon change list); with no task, take the first unclaimed one: ${order.join(", ")}`);
    }
  }
  // The schema editors read for canon/config.yaml, from this canon; a failure is said, never fatal (BR-2176).
  const schema = writeSchemaFile(ws.root);
  if (!schema.ok) say(schema.error.message);
  const background = backgroundNotice(settleBackgroundHooks(ws.db, ws.actor));
  if (background) say(background);
  noticeUpdates(ws, say);
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
