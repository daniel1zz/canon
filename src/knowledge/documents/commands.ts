import { basename } from "node:path";
import { defineCommand } from "citty";
import { corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import type { Doc, Kind } from "./model.ts";
import { readBacklog } from "./backlog.ts";
import { listedChanges, marksOf } from "../../work/session/inflight.ts";
import type { readCorpus } from "./read.ts";
import { technicalLayerWord, technicalNameAdvice } from "./domain-names.ts";
import { createDoc, createDomain, setMeta } from "./write.ts";
import { refuseOnGuardedMain } from "./guarded.ts";
import { findDoc } from "../query/query.ts";
import { planStatuses, progressMark, stepsMark } from "../plans/status.ts";

/** `canon rule`, `decision`, `change`, `note`, `doc`: creating, listing and setting the status of documents. */

function newDocCommand(kind: string, extra: Record<string, { type: "string"; description: string; required?: boolean }> = {}, description = `Create a ${kind} (allocates its id; edit the file afterwards)`) {
  return defineCommand({
    meta: { description },
    args: { title: { type: "string", required: true, description: "Title" }, body: { type: "string", description: "Body text (default: a template)" }, ...extra },
    run({ args }) {
      const ws = workspace();
      const { corpus } = corpusOf(ws);
      const a = args as Record<string, unknown>;
      refuseOnGuardedMain(ws, kind === "" ? String(a["type"]) : kind, String(a["title"]));
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
      const { corpus } = corpusOf(ws);
      const docs = corpus.docs.filter((d) => d.kind === kind && (kind !== "extra" || (d.kind === "extra" && d.type === args.type)));
      const live = (d: (typeof docs)[number]) => kind === "extra" || args.all || !("status" in d) || d.status === undefined || ["active", "accepted", "proposed", "open"].includes(d.status);
      const rows = docs
        .filter(live)
        .filter((d) => !args.domain || (d.kind === "rule" && (d.domain === args.domain || d.domain.startsWith(`${args.domain}/`))))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })); // SP-2 before SP-10 (BR-2061)
      if (kind === "change") {
        // Changes come in the owner's order (canon/backlog.md), started ones next, and include those that so far exist
        // only on their change branch, so the list the guide points to holds released work too (BR-2148, BR-2291, D-50).
        // reason: read once with every change: progress counts the done ones too, which the list itself leaves out;
        // the list keeps what listedChanges would keep with `live`, a change done only on its branch included (BR-2384, BR-2294)
        const { listed: every, unreadable } = must(listedChanges(ws, corpus, readBacklog(ws.root, ws.config.types), () => true));
        const listed = every.filter((l) => live(l.change) || (l.onBranch.length > 0 && l.change.status === "done"));
        const progress = new Map(planStatuses(corpus, every.map((l) => ({ change: l.change, onMain: l.onBranch.length === 0 }))).map((p) => [p.change.id, p]));
        if (args.json) {
          json(listed.map(({ change: { body: _b, ...r }, onBranch, handoff, claimed }) => ({
            ...r,
            ...(progress.has(r.id) ? { plan_progress: { total: progress.get(r.id)!.steps.length, done: progress.get(r.id)!.counts.done, percent: progress.get(r.id)!.percent } } : {}),
            on_branch: onBranch,
            handoff: handoff ? { next: handoff.next, actor: handoff.actor, updated_at: handoff.updated_at } : null,
            claimed,
          })));
        } else {
          for (const l of listed) {
            const plan = progress.get(l.change.id);
            const marks = [...marksOf(l, true), ...[stepsMark(l.change), plan && progressMark(plan)].filter((m): m is string => Boolean(m))];
            say(`${l.change.id.padEnd(8)} ${l.change.status.padEnd(10)} ${l.change.title}${marks.length ? `  (${marks.join("; ")})` : ""}`);
          }
          if (listed.length === 0 && unreadable.length === 0) say("(no changes)");
        }
        // reason: the rest is listed first; an unreadable branch file is said on stderr and fails the command (BR-2292)
        if (unreadable.length) fail({ code: "io", message: unreadable.map((u) => `unreadable change file: ${u}`).join("\n") });
        return;
      }
      if (args.json) return json(rows.map(({ body: _b, ...r }) => r));
      for (const d of rows) say(`${d.id.padEnd(8)} ${("status" in d && d.status ? d.status : "").padEnd(10)} ${d.title}`);
      if (rows.length === 0) say(`(no ${kind}s)`);
    },
  });
}

/**
 * Sets a document's status. `validate` runs before anything is written, so a refused change leaves no trace. With
 * `idempotent`, a document already in `status` is left alone: nothing written, no event, `<id> already <status>`.
 */
function setStatus(id: string, kind: Kind, status: string, validate?: (corpus: ReturnType<typeof readCorpus>["corpus"], doc: Doc) => void, opts: { idempotent?: boolean } = {}) {
  const ws = workspace();
  const { corpus } = corpusOf(ws);
  const doc = findDoc(corpus, id);
  if (!doc || doc.kind !== kind) fail({ code: "not_found", message: `${id} is not a ${kind}` });
  validate?.(corpus, doc);
  if (opts.idempotent && "status" in doc && doc.status === status) {
    say(`${doc.id} already ${status}`);
    return { ws, corpus, doc };
  }
  must(setMeta(ws.root, doc, { status }, "status" in doc ? doc.status : undefined));
  ws.db.event(ws.actor, `${kind}.status`, doc.id, { status });
  say(`${doc.id} → ${status} (${doc.path}; commit it with your change)`);
  return { ws, corpus, doc };
}

/** Above this many direct rules, `canon rule domains` suggests subdomains (BR-2114). */
const SPLIT_HINT = 25;

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
      // reason: retiring twice changes nothing, so it writes nothing and records no second event (BR-2028)
      run: ({ args }) => void setStatus(String(args.id), "rule", "retired", undefined, { idempotent: true }),
    }),
    domain: defineCommand({
      meta: { description: "Create a domain (canon/rules/<name>/README.md) or a subdomain (<domain>/<name>); only a top-level domain without code_root names its code (--code)" },
      args: { name: { type: "positional", required: true }, code: { type: "string", description: "Comma-separated code directories (top-level domain, no code_root)" }, description: { type: "string" } },
      run({ args }) {
        const ws = workspace();
        if (args.code !== undefined && list(args.code).length === 0) fail({ code: "invalid", message: "--code needs at least one directory" });
        say(must(createDomain(ws.root, String(args.name), list(args.code), typeof args.description === "string" ? args.description : "", ws.config.codeRoot)));
        // reason: a hint, not a refusal: the name may be right for this business, the exit code stays 0 (BR-2317)
        const word = technicalLayerWord(String(args.name));
        if (word !== undefined) say(`hint: ${technicalNameAdvice(String(args.name), word)}`);
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
          const word = technicalLayerWord(d.name);
          // reason: said next to the domain until it is renamed; `canon check` says it as a note too (BR-2318)
          const named = word !== undefined ? `  (named after a technical layer: \`${word}\`; name domains by business capability)` : "";
          say(`${`${"  ".repeat(d.name.split("/").length - 1)}${d.name}`.padEnd(24)} ${String(n).padStart(4)} rules  ${d.code.length ? d.code.join(", ") : `(code through ${d.name.split("/")[0]})`}${hint}${named}`);
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
        // reason: a decision whose `supersedes` has the wrong shape is not in the corpus, so accept would say "not found" instead of naming the field (BR-2027)
        const named = (path: string) => basename(path).replace(/\.md$/, "").split("-").slice(0, 2).join("-") === String(args.id);
        const malformed = corpusOf(workspace()).problems.find((q) => q.message.startsWith("`supersedes`") && named(q.path));
        if (malformed) fail({ code: "refused", message: `${malformed.path}: ${malformed.message}` });
        // Every target is checked before anything is written, so a bad id in a list changes no file (BR-2027).
        const superseded = (corpus: ReturnType<typeof readCorpus>["corpus"], doc: Doc) => {
          if (doc.kind !== "decision") return [];
          return doc.supersedes.map((target) => {
            // reason: a decision cannot replace itself; accepting it would leave it superseded (BR-2027)
            if (target === doc.id) fail({ code: "invalid", message: `${doc.id} supersedes itself; fix \`supersedes\` in ${doc.path}` });
            const old = findDoc(corpus, target);
            if (!old || old.kind !== "decision") fail({ code: "not_found", message: `${doc.id} supersedes ${target}, which is not a decision` });
            return old;
          });
        };
        const { ws, corpus, doc } = setStatus(String(args.id), "decision", "accepted", (c, d) => void superseded(c, d));
        for (const old of superseded(corpus, doc)) {
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
    new: newDocCommand(
      "change",
      { rules: { type: "string", description: "Comma-separated rule ids it adds, edits or retires" } },
      "Create a change file only (allocates its id; edit the file afterwards). Refused where main is checked out and guarded, since the file could not be committed there: use `canon work start --title` instead (BR-2409)",
    ),
    list: listCommand("change", "List open changes in the owner's order (canon/backlog.md, then the rest by id; --all for done and dropped)"),
    drop: defineCommand({
      meta: { description: "Mark a change dropped (work will not happen)" },
      args: { id: { type: "positional", required: true } },
      run: ({ args }) =>
        void setStatus(String(args.id), "change", "dropped", (_c, d) => {
          // reason: a done change's work happened; marking it dropped would rewrite that fact (BR-2041)
          if (d.kind === "change" && d.status !== "open") fail({ code: "invalid", message: `${d.id} is ${d.status}, not open; only an open change can be dropped` });
        }),
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

export const documentCommands: DomainCommands = {
  commands: [entry("rule", 70, rule), entry("decision", 80, decision), entry("change", 90, change), entry("note", 100, note), entry("doc", 110, doc)],
};
