#!/usr/bin/env bun
import { defineCommand, renderUsage, runCommand } from "citty";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace, type Workspace } from "../work/workspace.ts";
import { check } from "../knowledge/check/check.ts";
import { testFilesFor } from "../knowledge/check/tests.ts";
import { activeQueue } from "../work/land/queue.ts";
import { answer, answeredBy, ask, questions } from "../work/humans/questions.ts";
import { claimOfWorktree, claims } from "../work/claims/claims.ts";
import { handoffs } from "../work/session/handoffs.ts";
import type { CanonError, Result } from "../kernel/result.ts";
import type { Change, Doc, Kind } from "../knowledge/documents/model.ts";
import { BACKLOG_FILE, inBacklogOrder, parseBacklog, readBacklog } from "../knowledge/documents/backlog.ts";
import { openNotes, renderNote } from "../knowledge/review/notes.ts";
import { amendedBy, contextFor, findDoc, isIdQuery, rawText, referencedIds, renderContext, renderSearch, search } from "../knowledge/query/query.ts";
import { readCorpus } from "../knowledge/documents/read.ts";
import { createDoc, createDomain, setMeta } from "../knowledge/documents/write.ts";
import { git } from "../kernel/git.ts";
import { overlapsOf } from "../work/session/overlap.ts";
import { AFTER_LAND_WAIT_MS, backgroundNotice, batchState, renderAfterLand, settleBackgroundHooks, waitBackgroundHooks } from "../config/hooks.ts";
import { skillsSource, type InstallReport } from "./install/install.ts";
import { WORKFLOW_GUIDE } from "./guide.ts";
import { resolve, takesMany, unknownArgument } from "./strict.ts";
import { assetsStatus, installAssets, updateNotice, updateProject } from "./install/update.ts";
import { computeStats, renderSearchStats, renderSharedShare, renderStats, searchStats, sharedShare } from "../work/stats/stats.ts";
import { eventsSince, lastEventId, parseSince, renderEvents, renderWindow, windowSummary } from "../work/stats/window.ts";
import { drop } from "../work/drop/drop.ts";
import { issueStatus, renderIssues } from "../work/issues/issues.ts";
import { clean, mainCorpus, start, stop } from "../work/session/session.ts";
import { land } from "../work/land/land.ts";

/**
 * Exit codes — one meaning each, so an agent can branch on them (BR-2022, D-4):
 *   0 ok · 1 refused by an outcome check · 2 usage / invalid input / bad config · 3 not found
 *   4 the environment failed (git, filesystem, coordination DB) · 5 conflict: claimed, already answered, already exists
 *   70 a bug in canon · 75 queue timeout (retry later) · 143 / 130 a lander stopped by SIGTERM / SIGINT (128 + signal, BR-2099)
 */
const EXIT = { ok: 0, refused: 1, usage: 2, notFound: 3, env: 4, conflict: 5, internal: 70, timeout: 75 } as const;

const EXIT_OF: Record<CanonError["code"], number> = { invalid: EXIT.usage, not_found: EXIT.notFound, conflict: EXIT.conflict, refused: EXIT.refused, io: EXIT.env };

function fail(e: CanonError): never {
  console.error(`canon: ${e.message}`);
  process.exit(EXIT_OF[e.code]);
}

function must<T>(r: Result<T>): T {
  if (!r.ok) fail(r.error);
  return r.value;
}

function workspace(): Workspace {
  return must(openWorkspace(process.cwd()));
}

/** The corpus of this worktree, read with the project's declared types. */
const corpusOf = (ws: Workspace) => readCorpus(ws.root, ws.config.types, ws.config);

const list = (v: unknown): string[] => (typeof v === "string" && v.trim() !== "" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const say = (line: string) => console.log(line);
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));

// ---------------------------------------------------------------- knowledge

function newDocCommand(kind: string, extra: Record<string, { type: "string"; description: string; required?: boolean }> = {}) {
  return defineCommand({
    meta: { description: `Create a ${kind} (allocates its id; edit the file afterwards)` },
    args: { title: { type: "string", required: true, description: "Title" }, body: { type: "string", description: "Body text (default: a template)" }, ...extra },
    run({ args }) {
      const ws = workspace();
      const { corpus } = corpusOf(ws);
      const a = args as Record<string, unknown>;
      const path = must(
        createDoc(ws.root, corpus, ws.db, ws.actor, {
          kind: kind === "" ? String(a["type"]) : kind,
          title: String(a["title"]),
          ...(typeof a["body"] === "string" ? { body: a["body"] } : {}),
          ...(typeof a["domain"] === "string" ? { domain: a["domain"] } : {}),
          ...(typeof a["untested"] === "string" ? { untested: a["untested"] } : {}),
          ...(typeof a["supersedes"] === "string" ? { supersedes: a["supersedes"] } : {}),
          ...(kind === "change" ? { rules: list(a["rules"]) } : {}),
        }, ws.config.templates),
      );
      say(path);
    },
  });
}

function listCommand(kind: Kind, describe: string) {
  return defineCommand({
    meta: { description: describe },
    args: {
      all: { type: "boolean", description: "Include retired / superseded / done / dropped" },
      domain: { type: "string", description: "Rules of one domain" },
      type: { type: "string", description: "canon doc list: the declared type" },
      json: { type: "boolean" },
    },
    run({ args }) {
      const ws = workspace();
      if (kind === "extra") {
        const declared = ws.config.types.filter((t) => !t.builtin).map((t) => t.name).join(", ") || "none declared";
        const type = typeof args.type === "string" ? ws.config.types.find((t) => t.name === args.type) : undefined;
        if (typeof args.type !== "string") fail({ code: "invalid", message: `--type is required (declared types: ${declared})` });
        if (!type) fail({ code: "not_found", message: `no document type ${args.type} (declared types: ${declared})` });
        if (type.builtin) fail({ code: "invalid", message: `${type.name} is built in; use \`canon ${type.name} list\`` });
      }
      const docs = corpusOf(ws).corpus.docs.filter((d) => d.kind === kind && (kind !== "extra" || (d.kind === "extra" && d.type === args.type)));
      const live = (d: (typeof docs)[number]) => kind === "extra" || args.all || !("status" in d) || d.status === undefined || ["active", "accepted", "proposed", "open"].includes(d.status);
      const rows = docs
        .filter(live)
        .filter((d) => !args.domain || (d.kind === "rule" && (d.domain === args.domain || d.domain.startsWith(`${args.domain}/`))))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })); // SP-2 before SP-10 (BR-2061)
      // Changes come in the owner's order (canon/backlog.md), unlisted ones after by id (BR-2148, D-20).
      if (kind === "change") rows.splice(0, rows.length, ...inBacklogOrder(rows, readBacklog(ws.root, ws.config.types)));
      if (args.json) return json(rows.map(({ body: _b, ...r }) => r));
      for (const d of rows) say(`${d.id.padEnd(8)} ${("status" in d && d.status ? d.status : "").padEnd(10)} ${d.title}`);
      if (rows.length === 0) say(`(no ${kind}s)`);
    },
  });
}

/** Sets a document's status. `validate` runs before anything is written, so a refused change leaves no trace. */
function setStatus(id: string, kind: Kind, status: string, validate?: (corpus: ReturnType<typeof readCorpus>["corpus"], doc: Doc) => void) {
  const ws = workspace();
  const { corpus } = corpusOf(ws);
  const doc = findDoc(corpus, id);
  if (!doc || doc.kind !== kind) fail({ code: "not_found", message: `${id} is not a ${kind}` });
  validate?.(corpus, doc);
  must(setMeta(ws.root, doc, { status }));
  ws.db.event(ws.actor, `${kind}.status`, doc.id, { status });
  say(`${doc.id} → ${status} (${doc.path}; commit it with your change)`);
  return { ws, corpus, doc };
}

const rule = defineCommand({
  meta: { description: "Rules: the current truth, one file per rule under canon/rules/<domain>/" },
  subCommands: {
    new: newDocCommand("rule", {
      domain: { type: "string", required: true, description: "Domain directory under canon/rules" },
      untested: { type: "string", description: "Reason this rule deliberately has no test" },
    }),
    list: listCommand("rule", "List active rules (--all for retired too)"),
    retire: defineCommand({
      meta: { description: "Retire a rule; its id is never reused" },
      args: { id: { type: "positional", required: true } },
      run: ({ args }) => void setStatus(String(args.id), "rule", "retired"),
    }),
    domain: defineCommand({
      meta: { description: "Create a domain (canon/rules/<name>/README.md) or a subdomain (<domain>/<name>); only a top-level domain without code_root names its code (--code)" },
      args: { name: { type: "positional", required: true }, code: { type: "string", description: "Comma-separated code directories (top-level domain, no code_root)" }, description: { type: "string" } },
      run({ args }) {
        const ws = workspace();
        if (args.code !== undefined && list(args.code).length === 0) fail({ code: "invalid", message: "--code needs at least one directory" });
        say(must(createDomain(ws.root, String(args.name), list(args.code), typeof args.description === "string" ? args.description : "", ws.config.codeRoot)));
      },
    }),
    domains: defineCommand({
      meta: { description: "List domains and their code directories" },
      run() {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        for (const d of corpus.domains) {
          const n = corpus.docs.filter((r) => r.kind === "rule" && r.domain === d.name && r.status === "active").length;
          // reason: a hint, not a check: a big domain makes `canon context` long, splitting is a judgement call (BR-2114)
          const hint = n > SPLIT_HINT ? `  (more than ${SPLIT_HINT} rules: consider subdomains, canon rule domain ${d.name}/<name>)` : "";
          say(`${`${"  ".repeat(d.name.split("/").length - 1)}${d.name}`.padEnd(24)} ${String(n).padStart(4)} rules  ${d.code.length ? d.code.join(", ") : `(code through ${d.name.split("/")[0]})`}${hint}`);
        }
      },
    }),
  },
});

/** Above this many direct rules, `canon rule domains` suggests subdomains (BR-2114). */
const SPLIT_HINT = 25;

const decision = defineCommand({
  meta: { description: "Decisions: why a non-trivial choice was made" },
  subCommands: {
    new: newDocCommand("decision", { supersedes: { type: "string", description: "Decision id this one replaces (takes effect on accept)" } }),
    list: listCommand("decision", "List proposed and accepted decisions (--all for superseded)"),
    accept: defineCommand({
      meta: { description: "Accept a decision; a decision it supersedes becomes superseded" },
      args: { id: { type: "positional", required: true } },
      run({ args }) {
        const superseded = (corpus: ReturnType<typeof readCorpus>["corpus"], doc: Doc) => {
          if (doc.kind !== "decision" || !doc.supersedes) return undefined;
          const old = findDoc(corpus, doc.supersedes);
          if (!old || old.kind !== "decision") fail({ code: "not_found", message: `${doc.id} supersedes ${doc.supersedes}, which is not a decision` });
          return old;
        };
        const { ws, corpus, doc } = setStatus(String(args.id), "decision", "accepted", (c, d) => void superseded(c, d));
        const old = superseded(corpus, doc);
        if (old) {
          must(setMeta(ws.root, old, { status: "superseded" }));
          say(`${old.id} → superseded`);
        }
      },
    }),
  },
});

const change = defineCommand({
  meta: { description: "Changes: units of intended work (start one with `canon work start --title`)" },
  subCommands: {
    new: newDocCommand("change", { rules: { type: "string", description: "Comma-separated rule ids it adds, edits or retires" } }),
    list: listCommand("change", "List open changes in the owner's order (canon/backlog.md, then the rest by id; --all for done and dropped)"),
    drop: defineCommand({
      meta: { description: "Mark a change dropped (work will not happen)" },
      args: { id: { type: "positional", required: true } },
      run: ({ args }) => void setStatus(String(args.id), "change", "dropped"),
    }),
  },
});

/** Documents of the types a project declared in canon/config.yaml (BR-2050, BR-2051). */
const doc = defineCommand({
  meta: { description: "Documents of the types declared under `types:` in canon/config.yaml" },
  subCommands: {
    new: newDocCommand("", { type: { type: "string", required: true, description: "Declared type name" } }),
    list: listCommand("extra", "List documents of one declared type (--type)"),
    status: defineCommand({
      meta: { description: "Set the status of a declared-type document to one of its declared statuses" },
      args: { id: { type: "positional", required: true }, status: { type: "positional", required: true } },
      run({ args }) {
        const ws = workspace();
        const d = findDoc(corpusOf(ws).corpus, String(args.id));
        if (!d || d.kind !== "extra") fail({ code: "not_found", message: `${args.id} is not a document of a declared type` });
        const type = ws.config.types.find((t) => t.name === d.type)!;
        if (!type.statuses?.includes(String(args.status))) fail({ code: "invalid", message: `${d.type} statuses are: ${type.statuses?.join(", ") ?? "(none)"}` });
        setStatus(d.id, "extra", String(args.status));
      },
    }),
  },
});

const note = defineCommand({
  meta: { description: "Notes: research, retros, references" },
  subCommands: { new: newDocCommand("note"), list: listCommand("note", "List notes") },
});

const show = defineCommand({
  meta: { description: "Print a document (rule, decision, change or note) by id" },
  args: { id: { type: "positional", required: true } },
  run({ args }) {
    const ws = workspace();
    const { corpus } = corpusOf(ws);
    const doc = findDoc(corpus, args.id);
    if (!doc) fail({ code: "not_found", message: `${args.id} does not exist` });
    process.stdout.write(`${doc.path}\n\n${rawText(ws.root, doc)}`);
    for (const d of amendedBy(corpus, doc.id)) say(`partly amended by ${d.id} ${d.title} (${d.path})`); // BR-2140
  },
});

const searchCmd = defineCommand({
  meta: { description: "Search titles, bodies and ids of every document" },
  args: { query: { type: "positional", required: true }, limit: { type: "string", default: "20" }, json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const corpus = corpusOf(ws).corpus;
    const hits = search(corpus, args.query, Number(args.limit));
    const full = hits.filter((h) => h.matched === h.terms).length;
    ws.db.event(ws.actor, "search", null, { query: args.query, results: hits.length, full }); // BR-2134
    if (args.json) return json(hits.map((h) => ({ id: h.doc.id, kind: h.doc.kind, title: h.doc.title, path: h.doc.path, line: h.line, matched: h.matched, terms: h.terms })));
    for (const line of renderSearch(hits, isIdQuery(corpus, args.query))) say(line);
  },
});

const context = defineCommand({
  meta: { description: "Current context for a path, domain or document: domain READMEs, every active rule (by title; --full for the text), related decisions and open changes" },
  args: {
    target: { type: "positional", required: true, description: "Repo path, domain name, or id (C-12, BR-3, D-4)" },
    full: { type: "boolean", description: "Print every rule's full text instead of its title" },
  },
  run({ args }) {
    const ws = workspace();
    const ctx = contextFor(corpusOf(ws).corpus, args.target, ws.root);
    say(renderContext(ws.root, ctx, { full: Boolean(args.full), target: args.target }));
    // Open review notes on what this context covers, shown to whoever is about to change it (BR-2146, D-21).
    const ids = [...(ctx.target && ctx.target.kind !== "change" ? [ctx.target.id] : []), ...ctx.rules.map((r) => r.id), ...ctx.decisions.map((d) => d.id)];
    const notes = openNotes(ws.db, ids);
    if (notes.length) say(`# Open review notes\n\nNot blocking and not changes of their own: handle them when you change the document they name.\n${notes.map((n) => `- ${renderNote(n)}`).join("\n")}\n`);
  },
});

const checkCmd = defineCommand({
  meta: { description: "Corpus integrity: files valid, ids unique, references resolve, rules and tests name each other" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const read = corpusOf(ws);
    const findings = check({ root: ws.root, ...read, testFiles: testFilesFor(ws.root, ws.config) });
    if (args.json) json(findings);
    else for (const f of findings) say(`${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
    if (!args.json) say(findings.length === 0 ? `ok: ${read.corpus.docs.length} documents, ${read.corpus.domains.length} domains` : `${findings.length} finding(s)`);
    process.exit(findings.length === 0 ? EXIT.ok : EXIT.refused);
  },
});

// ---------------------------------------------------------------- work

const work = defineCommand({
  meta: { description: "One change, one worktree, one agent: start → commit → land" },
  subCommands: {
    start: defineCommand({
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
    }),
    land: defineCommand({
      meta: { description: "Land this worktree's branch on main: queue → rebase → floor → canon check → main" },
      args: { finish: { type: "boolean", description: "Also close the change and release it" }, timeout: { type: "string", description: "Minutes to wait in the queue (default: land_timeout_minutes, 60)" } },
      async run({ args }) {
        const minutes = args.timeout === undefined ? undefined : Number(args.timeout);
        if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) fail({ code: "invalid", message: `--timeout must be a positive number of minutes, got ${JSON.stringify(args.timeout)}` });
        const ws = workspace();
        const timeoutMs = minutes === undefined ? ws.config.landTimeoutMs : minutes * 60_000;
        const out = await land(ws, { finish: Boolean(args.finish), timeoutMs, guide: WORKFLOW_GUIDE }, say);
        if (out.kind === "landed") return;
        if (out.kind === "timeout") {
          console.error(`canon: still ${out.ahead} landing(s) ahead after ${timeoutMs / 60_000} min; run again`);
          process.exit(EXIT.timeout);
        }
        console.error(`canon: land refused (${out.reason}): ${out.message}`);
        for (const f of out.findings ?? []) console.error(`  ${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
        if (out.reason === "claimed") process.exit(EXIT.conflict);
        process.exit(out.reason === "dirty" || out.reason === "on-main" || out.reason === "no-floor" || out.reason === "no-claim" ? EXIT.usage : EXIT.refused);
      },
    }),
    stop: defineCommand({
      meta: { description: "Hand off: record the next step for whoever continues this change" },
      args: { next: { type: "string", required: true }, note: { type: "string" }, release: { type: "boolean", description: "Release the claim too" } },
      run({ args }) {
        const ws = workspace();
        const subject = must(stop(ws, String(args.next), typeof args.note === "string" ? args.note : undefined, Boolean(args.release), say));
        say(`${subject}: handoff recorded${args.release ? ", claim released" : ""}`);
      },
    }),
    status: defineCommand({
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
    }),
    drop: defineCommand({
      meta: { description: "Drop a change's worktree, branch and claim; archives anything that would be lost to refs/canon/archive first" },
      args: { change: { type: "positional", required: true } },
      run({ args }) {
        const ws = workspace();
        must(drop(ws, String(args.change), say));
        const onMain = mainCorpus(ws);
        const doc = onMain.ok ? findDoc(onMain.value, String(args.change)) : undefined;
        if (doc?.kind === "change" && doc.status === "open") say(`${doc.id} is still open on ${ws.config.main}; mark it with \`canon change drop ${doc.id}\` in a change if the work will not happen`);
      },
    }),
    "after-land": defineCommand({
      meta: { description: `Did the latest landing's background after_land commands finish, with what exit codes, and what did code review say; --wait blocks until they finish (default ${AFTER_LAND_WAIT_MS / 60_000} min). Exit 0 all exited 0, 1 one failed, 75 still running, 3 none, 4 log missing` },
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
        const change = typeof args.change === "string" && args.change ? args.change : undefined;
        const timeoutMs = minutes === undefined ? AFTER_LAND_WAIT_MS : minutes * 60_000;
        const b = args.wait ? await waitBackgroundHooks(ws.db, ws.actor, change, timeoutMs) : settleBackgroundHooks(ws.db, ws.actor, change);
        if (!b) fail({ code: "not_found", message: change ? `no landing of ${change} ran background after_land commands` : "no landing has run background after_land commands" });
        const st = batchState(b);
        if (args.json) json({ ...b, state: st });
        else {
          say(renderAfterLand(b));
          if (args.wait && st === "running") say(`still running after ${timeoutMs / 60_000} min; run canon work after-land --wait again`);
        }
        process.exit({ ok: EXIT.ok, failed: EXIT.refused, running: EXIT.timeout, unknown: EXIT.env }[st]);
      },
    }),
    clean: takesMany(defineCommand({
      meta: { description: "Remove worktrees that are clean and fully landed; list the rest with the reason they stay. Name changes to remove only theirs" },
      args: { changes: { type: "positional", required: false, description: "Only these changes' worktrees (C-n ...)" } },
      run({ args }) {
        const ws = workspace();
        const r = must(clean(ws, say, args._.map(String)));
        for (const k of r.kept) say(`kept ${k}`);
      },
    })),
  },
});

// ---------------------------------------------------------------- humans

const human = defineCommand({
  meta: { description: "Questions only a human can answer (direction and reserved decisions)" },
  subCommands: {
    ask: defineCommand({
      meta: { description: "Ask the human; work that does not depend on the answer continues" },
      args: { question: { type: "positional", required: true }, option: { type: "string", description: "Comma-separated options" }, change: { type: "string" } },
      run({ args }) {
        const ws = workspace();
        const id = ask(ws.db, ws.actor, typeof args.change === "string" ? args.change : (claimOfWorktree(ws.db, ws.root)?.subject ?? null), String(args.question), list(args.option));
        say(`question #${id} recorded; \`canon human pending\` shows it`);
      },
    }),
    pending: defineCommand({
      meta: { description: "Questions waiting for an answer" },
      args: { all: { type: "boolean" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const qs = questions(ws.db, args.all ? "all" : "pending");
        if (args.json) return json(qs);
        for (const q of qs) say(`#${q.id} [${q.subject ?? "-"}] ${q.question}${q.options.length ? `  (${q.options.join(" | ")})` : ""}${q.answer ? `\n    → ${q.answer} (${answeredBy(q)})` : ""}`);
        if (qs.length === 0) say("(nothing waiting)");
      },
    }),
    answer: defineCommand({
      meta: { description: "Answer a question: a human at a terminal, or an agent passing on the human's own words with --relayed" },
      args: {
        id: { type: "positional", required: true },
        text: { type: "positional", required: true },
        relayed: { type: "string", description: "Agent only: the human's own words this answer passes on (recorded as a relay)" },
      },
      run({ args }) {
        const relayed = typeof args.relayed === "string" ? args.relayed : undefined;
        if (relayed === undefined && !process.stdin.isTTY) {
          fail({ code: "invalid", message: 'answer at a terminal, or as an agent relay the human\'s words with --relayed "<what they said>"' });
        }
        const ws = workspace();
        must(answer(ws.db, Number(args.id), String(args.text), ws.actor, relayed));
        say(`#${args.id} answered${relayed ? ` (relayed by ${ws.actor})` : ""}`);
      },
    }),
  },
});

// ---------------------------------------------------------------- project

const init = defineCommand({
  meta: { description: "Create the canon/ layout in this repository" },
  args: { floor: { type: "string", description: "Command that must pass before anything lands, e.g. \"bun run typecheck && bun test\"" } },
  run({ args }) {
    const root = must(git(process.cwd(), "rev-parse", "--show-toplevel"));
    // Skills first: a missing source (BR-2082) or an edited skill copy (BR-2081) refuses before anything else is written.
    reportInstall(must(installAssets(root, must(skillsSource()), false)));
    const files: Record<string, string> = {
      "canon/product.md": "---\ntitle: 产品\n---\n# 产品\n\n## 目的\n\n## 使用者\n\n## 承诺\n\n## 不做的事\n",
      "canon/config.yaml": `main: main\nfloor: ${JSON.stringify(args.floor ?? "")}\n`,
    };
    for (const [p, text] of Object.entries(files)) {
      const full = join(root, p);
      if (existsSync(full)) say(`exists ${p}`);
      else {
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, text);
        say(`created ${p}`);
      }
    }
    for (const dir of ["rules", "decisions", "changes", "notes"]) mkdirSync(join(root, "canon", dir), { recursive: true });
    if (!args.floor) say("set `floor` in canon/config.yaml before landing anything");
  },
});

function reportInstall(r: InstallReport & { hook: boolean; guard: boolean }) {
  for (const f of r.written) say(`skill ${f}`);
  for (const f of r.removed) say(`removed skill file ${f}`);
  for (const f of r.kept) say(`kept skill ${f} (edited in this project; canon has no newer version)`);
  if (r.hook) say("hooks: .claude/settings.json brought up to date (canon brief at session start; entries canon withdrew removed)");
  if (r.guard) say("git hook: main moves only through canon work land (reference-transaction; not tracked, nothing to commit)");
  const tracked = r.written.length + r.removed.length > 0 || r.hook;
  say(tracked ? "canon project files installed; commit them with the project" : r.guard ? "canon project files installed" : "canon project files: up to date");
}

/** Installs canon's project files (skills, session hook) into this tree, as `canon init` does (D-9, D-10). */
const install = defineCommand({
  meta: { description: "Install canon's project files (skills, session-start hook, the git hook that keeps main moving only through canon work land) into this tree; files edited here are not overwritten without --force" },
  args: { force: { type: "boolean", description: "Overwrite skill files that were edited in this project" } },
  run({ args }) {
    const root = must(git(process.cwd(), "rev-parse", "--show-toplevel"));
    reportInstall(must(installAssets(root, must(skillsSource()), Boolean(args.force))));
  },
});

/** Discovery is automatic (brief, work start); updating happens only when someone asks for it (D-10). */
const update = defineCommand({
  meta: { description: "Update canon's project files to this canon's version as its own landed change; --check only reports" },
  args: {
    check: { type: "boolean", description: "Only report what is out of date; exit 1 when something is" },
    force: { type: "boolean", description: "Overwrite skill files that were edited in this project" },
  },
  async run({ args }) {
    const ws = workspace();
    const source = must(skillsSource());
    if (args.check) {
      const st = must(assetsStatus(ws.root, source));
      if (st.current) return say(`canon project files: up to date (version ${st.version})`);
      say(`canon project files are out of date (version ${st.version}):`);
      for (const o of st.outdated) say(`  ${o}${st.edited.some((e) => o === `skill ${e}`) ? "  (edited in this project)" : ""}`);
      process.exit(EXIT.refused);
    }
    const out = must(await updateProject(ws, source, Boolean(args.force), ws.config.landTimeoutMs, say));
    if (out.kind === "current") return say(`canon project files: up to date (version ${out.version})`);
    if (out.kind === "guard") return say(`git hook installed: main moves only through canon work land; canon project files are now up to date (version ${out.version})`);
    if (out.kind === "landed") return say(`updated to ${out.version} in ${out.change}, landed ${out.sha.slice(0, 9)}`);
    console.error(`canon: the update ${out.change} did not land: ${out.message}`);
    process.exit(EXIT.refused);
  },
});
/** The update notice (BR-2085); a missing skills source is reported on the same line, never hidden. */
function noticeUpdates(ws: Workspace, out: (line: string) => void) {
  const source = skillsSource();
  if (!source.ok) return out(`canon project files: cannot check for updates (${source.error.message})`);
  const st = assetsStatus(ws.root, source.value);
  if (!st.ok) return out(`canon project files: cannot check for updates (${st.error.message})`);
  const n = updateNotice(st.value);
  if (n) out(n);
}

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
  const background = backgroundNotice(settleBackgroundHooks(ws.db, ws.actor));
  if (background) say(background);
  noticeUpdates(ws, say);
}

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
    const share = sharedShare(ws.root, ws.config);
    if (share) say(`\n${renderSharedShare(share)}`);
    const searches = searchStats(ws.db, since ?? 0, until);
    if (searches.searches > 0) say(`\n${renderSearchStats(searches)}`);
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

/** Open GitHub issues and the commits on main that name them as fixed; read only (BR-2168, BR-2170). */
const issues = defineCommand({
  meta: { description: "List the project's open GitHub issues (through gh, read only) and whether a commit on main names each as fixed" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const list = must(issueStatus(ws));
    if (args.json) return json(list);
    for (const line of renderIssues(list, ws.config.main)) say(line);
  },
});

const main = defineCommand({
  meta: { name: "canon", description: "Shared memory and coordination for a project built by many concurrent AI sessions" },
  subCommands: { init, brief, search: searchCmd, context, check: checkCmd, show, rule, decision, change, note, doc, work, human, stats, events, install, update, issues },
});

/**
 * citty's runMain exits 1 on every error; canon keeps 1 for check refusals, so usage errors exit 2 and
 * unexpected exceptions (bugs) exit 70 (D-4). Help prints usage to stdout and exits 0, before any argument check.
 */
async function run(): Promise<void> {
  const raw = process.argv.slice(2);
  const at = resolve(main, raw);
  if (raw.includes("--help") || raw.includes("-h")) {
    // reason: printed with console.log, not citty's runMain: consola is silent under a test runner, so help could not be tested.
    // Its backticks are markup consola would have turned into colour.
    // reason: citty names a command without meta.name after process.argv[1], which is "/$bunfs/root/canon" in the compiled
    // binary and the script path under bun; give it the words that named the command instead (BR-2101).
    const leaf = { ...at.cmd, meta: { ...((at.cmd.meta ?? {}) as object), name: at.path.at(-1) ?? "canon" } };
    const parent = at.path.length > 0 ? { meta: { name: ["canon", ...at.path.slice(0, -1)].join(" ") } } : undefined;
    console.log(`${(await renderUsage(leaf, parent)).replaceAll("`", "")}\n`);
    return;
  }
  // Before anything runs: an argument the command does not declare is a usage error, never ignored (BR-2097).
  const levels = [...at.before, ...(Object.keys(at.cmd.subCommands ?? {}).length === 0 ? [{ cmd: at.cmd, path: at.path, args: at.rest }] : [])];
  for (const l of levels) {
    const name = ["canon", ...l.path].join(" ");
    const problem = unknownArgument(l.cmd, name, l.args);
    if (problem) {
      console.error(`canon: ${problem} (see \`${name} --help\`)`);
      process.exit(EXIT.usage);
    }
  }
  try {
    await runCommand(main, { rawArgs: raw });
  } catch (e) {
    if (e instanceof Error && e.name === "CLIError") {
      console.error(`canon: ${e.message} (see \`${["canon", ...at.path].join(" ")} --help\`)`);
      process.exit(EXIT.usage);
    }
    console.error(`canon: internal error (a bug in canon): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(EXIT.internal);
  }
}

await run();
