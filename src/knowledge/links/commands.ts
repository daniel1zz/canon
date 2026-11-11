import { defineCommand } from "citty";
import { guardedMainCheckout } from "../../install/githook.ts";
import { corpusOf, entry, EXIT, fail, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Corpus, Decision, Rule } from "../documents/model.ts";
import { setMeta } from "../documents/write.ts";
import { linksOf } from "./start.ts";
import { fingerprintOf, indexOf, isReferrer, namedBy, sortIds, suspectWhy, type Link } from "./links.ts";

/** `canon links list` and `canon links confirm`: suspect references and their confirmation (BR-2427, BR-2425). */

/** BR-2427's lines: one per suspect reference, then the count. */
export function listLines(links: readonly Link[]): string[] {
  const suspect = links.filter((l) => l.suspect);
  if (suspect.length === 0) return ["no suspect references"];
  return [
    ...suspect.map((l) => `${l.from} -> ${l.to}: ${suspectWhy(l)}`),
    `${suspect.length} suspect reference(s) in ${new Set(suspect.map((l) => l.from)).size} document(s); re-read the named document, fix the referring one if needed, then: canon links confirm <referring> <named>`,
  ];
}

const list = defineCommand({
  meta: { description: "List every suspect reference: a rule or decision names one whose behaviour changed since it was confirmed or since links_since, or that was never confirmed" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const links = must(linksOf(ws.root, corpusOf(ws).corpus, ws.config.linksSince));
    if (args.json) json(links.filter((l) => l.suspect).map((l) => ({ from: l.from, to: l.to, basis: l.basis, since: l.since ?? null })));
    else for (const line of listLines(links)) say(line);
    // reason: suspects are said, never refused; only acceptance requires none (BR-2427, D-89)
    process.exit(EXIT.ok);
  },
});

/** What `confirm` would write into the referring document's `links`, or why it cannot (BR-2425). */
export function confirmation(corpus: Corpus, links: readonly Link[], from: string, to: string): Result<{ doc: Rule | Decision; links: Record<string, string> } | undefined> {
  const byId = indexOf(corpus);
  const doc = byId.get(from.toUpperCase());
  if (!doc) return err("not_found", `${from} does not exist`);
  if (doc.kind !== "rule" && doc.kind !== "decision") return err("invalid", `${doc.id} is a ${doc.kind}: only rules and decisions have tracked references (BR-2423)`);
  if (!isReferrer(doc)) return err("invalid", `${doc.id} is ${doc.status}: its references are not tracked (BR-2423)`);
  const target = byId.get(to.toUpperCase());
  if (!target) return err("not_found", `${to} does not exist`);
  const named = namedBy(corpus, doc, byId);
  if (!named.includes(target.id)) return err("not_found", `${doc.id} does not name ${target.id} in its text (outside backticks and code blocks)`);
  const link = links.find((l) => l.from === doc.id && l.to === target.id);
  if (!link?.suspect) return ok(undefined);
  const kept = Object.entries(doc.links ?? {}).filter(([id]) => named.includes(id));
  const next = Object.fromEntries([...kept, [target.id, fingerprintOf(target as Rule | Decision)]]);
  return ok({ doc, links: Object.fromEntries(sortIds(Object.keys(next)).map((id) => [id, next[id]!])) });
}

const confirm = defineCommand({
  meta: { description: "Confirm a reference after re-reading the document it names: record that document's current fingerprint in the referring one's links" },
  args: {
    from: { type: "positional", required: true, description: "The referring rule or decision" },
    to: { type: "positional", required: true, description: "The rule or decision it names" },
  },
  run({ args }) {
    const ws = workspace();
    const corpus = corpusOf(ws).corpus;
    // reason: a file written on the guarded main could not be committed and would block every landing (BR-2425, BR-2409)
    if (must(guardedMainCheckout(ws.root, ws.config.main))) {
      fail({ code: "refused", message: `this checkout has ${ws.config.main} checked out and ${ws.config.main} moves only through canon work land; nothing was written. Confirm inside a change's worktree: canon work start <C-n> (or --title "<what>"), cd into the path it prints, and run this command there.` });
    }
    const links = must(linksOf(ws.root, corpus, ws.config.linksSince));
    const found = must(confirmation(corpus, links, String(args.from), String(args.to)));
    const from = String(args.from).toUpperCase();
    const to = String(args.to).toUpperCase();
    if (found === undefined) {
      say(`${from} -> ${to} is not suspect; nothing written`);
      return;
    }
    must(setMeta(ws.root, found.doc, { links: found.links }));
    say(`confirmed ${from} -> ${to} (${found.links[to]})`);
  },
});

const links = defineCommand({
  meta: { description: "References between rules and decisions: list the suspect ones, confirm one after re-reading what it names" },
  subCommands: { list, confirm },
});

export const linksCommands: DomainCommands = { commands: [entry("links", 45, links)] };
