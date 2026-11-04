import { defineCommand } from "citty";
import { corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import type { Doc, Kind } from "./model.ts";
import { inBacklogOrder, readBacklog } from "./backlog.ts";
import type { readCorpus } from "./read.ts";
import { createDoc, createDomain, setMeta } from "./write.ts";
import { findDoc } from "../query/query.ts";

/** `canon rule`, `decision`, `change`, `note`, `doc`: creating, listing and setting the status of documents. */

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
          // reason: a decision cannot replace itself; accepting it would leave it superseded (BR-2027)
          if (doc.supersedes === doc.id) fail({ code: "invalid", message: `${doc.id} supersedes itself; fix \`supersedes\` in ${doc.path}` });
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
