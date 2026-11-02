#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace, type Workspace } from "../app/workspace.ts";
import { check } from "../check/check.ts";
import { testFilesFor } from "../check/tests.ts";
import { activeQueue, answer, ask, claimOfWorktree, claims, handoffs, questions } from "../coord/state.ts";
import type { CanonError, Result } from "../kernel/result.ts";
import type { Doc, Kind } from "../knowledge/model.ts";
import { contextFor, findDoc, rawText, renderContext, search } from "../knowledge/query.ts";
import { readCorpus } from "../knowledge/read.ts";
import { createDoc, createDomain, setMeta } from "../knowledge/write.ts";
import { git } from "../repo/git.ts";
import { clean, land, start, stop } from "../work/work.ts";

/**
 * Exit codes — one meaning each, so an agent can branch on them:
 *   0 ok · 1 refused by an outcome check (floor, canon check, conflict on land) · 2 usage / invalid input
 *   3 not found · 5 conflict: claimed by another worktree, already answered, already exists · 75 queue timeout (retry later)
 */
const EXIT = { ok: 0, refused: 1, usage: 2, notFound: 3, conflict: 5, timeout: 75 } as const;

function fail(e: CanonError): never {
  console.error(`canon: ${e.message}`);
  process.exit(e.code === "invalid" ? EXIT.usage : e.code === "not_found" ? EXIT.notFound : e.code === "conflict" ? EXIT.conflict : EXIT.refused);
}

function must<T>(r: Result<T>): T {
  if (!r.ok) fail(r.error);
  return r.value;
}

function workspace(): Workspace {
  return must(openWorkspace(process.cwd()));
}

/** The corpus of this worktree, read with the project's declared types. */
const corpusOf = (ws: Workspace) => readCorpus(ws.root, ws.config.types);

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
      const rows = docs.filter(live).filter((d) => !args.domain || (d.kind === "rule" && d.domain === args.domain));
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
      meta: { description: "Create a domain: canon/rules/<name>/README.md with the code directories it governs" },
      args: { name: { type: "positional", required: true }, code: { type: "string", required: true, description: "Comma-separated code directories" }, description: { type: "string" } },
      run({ args }) {
        const ws = workspace();
        say(must(createDomain(ws.root, String(args.name), list(args.code), typeof args.description === "string" ? args.description : "")));
      },
    }),
    domains: defineCommand({
      meta: { description: "List domains and their code directories" },
      run() {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        for (const d of corpus.domains) {
          const n = corpus.docs.filter((r) => r.kind === "rule" && r.domain === d.name && r.status === "active").length;
          say(`${d.name.padEnd(20)} ${String(n).padStart(4)} rules  ${d.code.join(", ")}`);
        }
      },
    }),
  },
});

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
    list: listCommand("change", "List open changes (--all for done and dropped)"),
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
    const doc = findDoc(corpusOf(ws).corpus, args.id);
    if (!doc) fail({ code: "not_found", message: `${args.id} does not exist` });
    process.stdout.write(`${doc.path}\n\n${rawText(ws.root, doc)}`);
  },
});

const searchCmd = defineCommand({
  meta: { description: "Search titles, bodies and ids of every document" },
  args: { query: { type: "positional", required: true }, limit: { type: "string", default: "20" }, json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const hits = search(corpusOf(ws).corpus, args.query, Number(args.limit));
    if (args.json) return json(hits.map((h) => ({ id: h.doc.id, kind: h.doc.kind, title: h.doc.title, path: h.doc.path, line: h.line })));
    for (const h of hits) say(`${h.doc.id.padEnd(8)} ${h.doc.title}\n         ${h.line}`);
    if (hits.length === 0) say("(no match)");
  },
});

const context = defineCommand({
  meta: { description: "Whole current context for a path, domain or document: domain READMEs, every active rule, related decisions and open changes" },
  args: { target: { type: "positional", required: true, description: "Repo path, domain name, or id (C-12, BR-3, D-4)" } },
  run({ args }) {
    const ws = workspace();
    say(renderContext(ws.root, contextFor(corpusOf(ws).corpus, args.target)));
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
        const out = await land(ws, { finish: Boolean(args.finish), timeoutMs }, say);
        if (out.kind === "landed") return;
        if (out.kind === "timeout") {
          console.error(`canon: still ${out.ahead} landing(s) ahead after ${timeoutMs / 60_000} min; run again`);
          process.exit(EXIT.timeout);
        }
        console.error(`canon: land refused (${out.reason}): ${out.message}`);
        for (const f of out.findings ?? []) console.error(`  ${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
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
    clean: defineCommand({
      meta: { description: "Remove worktrees that are clean and fully landed; list the rest with the reason they stay" },
      run() {
        const ws = workspace();
        const r = must(clean(ws, say));
        for (const k of r.kept) say(`kept ${k}`);
      },
    }),
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
        for (const q of qs) say(`#${q.id} [${q.subject ?? "-"}] ${q.question}${q.options.length ? `  (${q.options.join(" | ")})` : ""}${q.answer ? `\n    → ${q.answer} (${q.answered_by})` : ""}`);
        if (qs.length === 0) say("(nothing waiting)");
      },
    }),
    answer: defineCommand({
      meta: { description: "Answer a question. Only from an interactive terminal: an agent cannot answer for the human" },
      args: { id: { type: "positional", required: true }, text: { type: "positional", required: true } },
      run({ args }) {
        if (!process.stdin.isTTY) fail({ code: "invalid", message: "answers are typed by a human at a terminal; this session has no TTY" });
        const ws = workspace();
        must(answer(ws.db, Number(args.id), String(args.text), ws.actor));
        say(`#${args.id} answered`);
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

const brief = defineCommand({
  meta: { description: "Session start: this worktree's change and handoff, and what else is in flight (printed by the session-start hook)" },
  run() {
    const ws = workspace();
    const mine = claimOfWorktree(ws.db, ws.root);
    const hs = handoffs(ws.db);
    const pending = questions(ws.db, "pending").length;
    if (mine) {
      say(`You are in ${mine.subject} (${ws.root}). Read it: canon show ${mine.subject}; context: canon context ${mine.subject}`);
      const h = hs.find((x) => x.subject === mine.subject);
      if (h) say(`Handoff from ${h.actor} at ${h.updated_at}: next — ${h.next}${h.note ? `\n${h.note}` : ""}`);
    }
    const others = hs.filter((h) => h.subject !== mine?.subject);
    if (others.length) say(`Unfinished changes with handoffs: ${others.map((h) => h.subject).join(", ")} (canon work status)`);
    if (pending) say(`${pending} question(s) wait for a human (canon human pending)`);
  },
});

const main = defineCommand({
  meta: { name: "canon", description: "Shared memory and coordination for a project built by many concurrent AI sessions" },
  subCommands: { init, brief, search: searchCmd, context, check: checkCmd, show, rule, decision, change, note, doc, work, human },
});

runMain(main);
