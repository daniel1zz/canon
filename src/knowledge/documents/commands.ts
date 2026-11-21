import { basename } from "node:path";
import { endOnDrop } from "../../work/delegation/records.ts";
import { applyCmd, proposeCmd } from "../../work/delegation/commands.ts";
import { defineCommand } from "citty";
import { corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import type { Doc, Kind } from "./model.ts";
import { readBacklog } from "./backlog.ts";
import { changeStates, isClosed, marksOf, stateJson } from "../changes/state.ts";
import { TIER_WIDTH, tierLabel } from "../../work/priority/store.ts";
import { DEFAULT_TIER } from "../../work/priority/tiers.ts";
import type { readCorpus } from "./read.ts";
import { technicalLayerWord, technicalNameAdvice } from "./domain-names.ts";
import { contractLines } from "../domains/business.ts";
import { domainLines } from "../domains/list.ts";
import { createDoc, createDomain, setField, setMeta } from "./write.ts";
import { refuseOnGuardedMain } from "./guarded.ts";
import { findDoc } from "../query/query.ts";
import { waitingJson } from "../changes/deps.ts";
import { closeCmd, graphCmd, LINK_ARGS, linkCmd, newLinks } from "../changes/commands.ts";
import { mainCorpus } from "../../work/session/session.ts";

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
      // reason: the links are checked before an id is allocated, so a refused change leaves no number or file (BR-2562)
      const links = kind === "change" && String(a["title"]).trim() !== "" ? newLinks(ws, a, corpus) : undefined;
      // reason: the domain's whole boundary is read at the moment a new rule would otherwise repeat part of it (BR-2432, D-96)
      if (kind === "rule" && typeof a["domain"] === "string") for (const line of contractLines(corpus, a["domain"])) say(line);
      const path = must(
        createDoc(ws.root, corpus, ws.db, ws.actor, {
          kind: kind === "" ? String(a["type"]) : kind,
          title: String(a["title"]),
          ...(typeof a["body"] === "string" ? { body: a["body"] } : {}),
          ...(typeof a["domain"] === "string" ? { domain: a["domain"] } : {}),
          ...(typeof a["untested"] === "string" ? { untested: a["untested"] } : {}),
          ...(typeof a["supersedes"] === "string" ? { supersedes: a["supersedes"] } : {}),
          ...(kind === "change" ? { rules: list(a["rules"]), ...(links ? { links } : {}) } : {}),
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
        // reason: the list keeps what listedChanges would keep with `live`, a change done only on its branch included (BR-2294)
        // reason: dependencies are satisfied by what landed on main, not by this checkout's older copy of it (BR-2564, D-149)
        // reason: every change's state comes from the one place that computes it (BR-2571, BR-2572, D-151)
        const { states: every, unreadable } = must(changeStates(ws, { corpus, backlog: readBacklog(ws.root, ws.config.types) }));
        // reason: --all adds the changes only the coordination data has, a branch-only change dropped since among them (BR-2572)
        const listed = every.filter((s) => (s.change ? live(s.change) || (s.onBranch.length > 0 && s.change.status === "done") : Boolean(args.all)));
        if (args.json) {
          json(listed.map((s) => {
            const { body: _b, ...r } = s.change ?? { id: s.id, title: null, status: null, body: "" };
            const handoff = s.handoff;
            return {
              ...r,
              on_branch: s.onBranch,
              handoff: handoff ? { next: handoff.next, reason: handoff.reason ?? "unrecorded", on: handoff.on, actor: handoff.actor, updated_at: handoff.updated_at } : null,
              claimed: s.flags.claimed,
              waiting_for: waitingJson(s.waiting),
              ...stateJson(s),
              // reason: a closed change's tier has no effect, so it has none here (BR-2603, D-155)
              priority: isClosed(s) ? null : (s.priority?.tier ?? DEFAULT_TIER),
              priority_by: isClosed(s) ? null : (s.priority?.by ?? null),
            };
          }));
        } else {
          for (const s of listed) {
            const marks = marksOf(s, true);
            // reason: every open change says its tier, and who set it when one is set (BR-2603); it is a column of its own, so the parentheses still start with the state (BR-2572)
            const tier = (isClosed(s) ? "" : tierLabel(s.priority)).padEnd(TIER_WIDTH);
            say(`${s.id.padEnd(8)} ${(s.change?.status ?? "").padEnd(10)} ${tier}  ${s.change?.title ?? "(no file)"}  (${marks.join("; ")})`);
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

const rule = defineCommand({
  meta: { description: "Rules: the current truth, one file per rule under canon/rules/<domain>/" },
  subCommands: {
    new: newDocCommand("rule", {
      domain: { type: "string", required: true, description: "Domain directory under canon/rules" },
      untested: { type: "string", description: "Reason this rule deliberately has no test" },
    }),
    list: listCommand("rule", "List active rules (--all for retired too)"),
    propose: proposeCmd,
    apply: applyCmd,
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
        refuseOnGuardedMain(ws, "domain README", String(args.name));
        // reason: a new domain is only right when no existing one covers it; the list is read at the moment it would otherwise be duplicated (BR-2115, D-98)
        say("domains that already exist — a new one is for a business none of them covers; a decision must say why this one exists:");
        for (const line of domainLines(corpusOf(ws).corpus)) say(line);
        say(must(createDomain(ws.root, String(args.name), list(args.code), typeof args.description === "string" ? args.description : "", ws.config.codeRoot)));
        // reason: a hint, not a refusal: the name may be right for this business, the exit code stays 0 (BR-2317)
        const word = technicalLayerWord(String(args.name));
        if (word !== undefined) say(`hint: ${technicalNameAdvice(String(args.name), word)}`);
      },
    }),
    domains: defineCommand({
      meta: { description: "List domains, their code directories and the businesses they list" },
      run() {
        const ws = workspace();
        for (const line of domainLines(corpusOf(ws).corpus)) say(line);
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
      { rules: { type: "string", description: "Comma-separated rule ids it adds, edits or retires" }, ...LINK_ARGS },
      "Create a change ahead of time: its file only, open, no worktree (allocates its id; it lands with the change you are in, then canon work start <C-n> starts it). Refused where main is checked out and guarded, since the file could not be committed there: use `canon work start --title` instead (BR-2409, BR-2562)",
    ),
    link: linkCmd,
    graph: graphCmd,
    close: closeCmd,
    list: listCommand("change", "List open changes by priority tier (P0 first, canon priority set), each tier in the owner's order (canon/backlog.md, then the rest by id; --all for done and dropped)"),
    drop: defineCommand({
      meta: { description: "Mark a change dropped (work will not happen)" },
      args: { id: { type: "positional", required: true } },
      run({ args }) {
        const { ws, doc } = setStatus(String(args.id), "change", "dropped", (_c, d) => {
          // reason: a done change's work happened; marking it dropped would rewrite that fact (BR-2041)
          if (d.kind === "change" && d.status !== "open") fail({ code: "invalid", message: `${d.id} is ${d.status}, not open; only an open change can be dropped` });
        });
        // reason: a dropped change is nobody's work any more, so its delegation ends with it (BR-2574, D-151)
        if (endOnDrop(ws.db, ws.actor, doc.id, "canon change drop")) say(`${doc.id}: its delegation ended`);
      },
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
    set: defineCommand({
      meta: { description: "Set one declared front-matter field of a document to a value its type's declaration allows (--clear removes an optional one); in this worktree, not committed" },
      args: { id: { type: "positional", required: true }, field: { type: "positional", required: true }, value: { type: "positional", required: false }, clear: { type: "boolean", description: "Remove an optional field" } },
      run({ args }) {
        const ws = workspace();
        const r = setField(ws.root, corpusOf(ws).corpus, String(args.id), String(args.field), args.clear ? undefined : args.value === undefined ? null : String(args.value));
        if (!r.ok) fail(r.error);
        if (r.value.changed) ws.db.event(ws.actor, "doc.set", r.value.id, { field: r.value.field, before: r.value.before ?? null, after: r.value.after ?? null });
        say(r.value.changed ? `${r.value.id}: ${r.value.field} set${r.value.after === undefined ? " (removed)" : ` to ${JSON.stringify(r.value.after)}`} in ${r.value.path}; commit it with your work` : `${r.value.id}: ${r.value.field} is already that; no change`);
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
