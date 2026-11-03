import { defineCommand } from "citty";
import { corpusOf, entry, fail, json, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { openNotes, renderNote } from "../review/notes.ts";
import { amendedBy, contextFor, findDoc, isIdQuery, rawText, renderContext, renderSearch, search } from "./query.ts";

/** `canon show`, `search`, `context`: reading the corpus. */

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
    // reason: NaN or 0 would list nothing and report "no match" for a query that has hits (BR-2212, #72)
    if (!/^\d+$/.test(String(args.limit)) || Number(args.limit) <= 0) fail({ code: "invalid", message: `--limit must be a positive integer, got ${JSON.stringify(args.limit)}` });
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

export const queryCommands: DomainCommands = {
  commands: [entry("search", 30, searchCmd), entry("context", 40, context), entry("show", 60, show)],
};
