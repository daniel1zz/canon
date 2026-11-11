import { createHash } from "node:crypto";
import { behaviourHash } from "../documents/behaviour.ts";
import { stripCode, type Corpus, type Decision, type Doc, type Rule } from "../documents/model.ts";
import { section } from "../documents/templates.ts";
import { idsIn, type DocType } from "../documents/types.ts";

/**
 * References between rules and decisions, read only from their prose, and which of them are suspect: the named
 * document's fingerprint changed after the referring one was last checked against it (BR-2423, D-90, D-95).
 */

export const DECISION_SECTION = "## 决定";

/** The kinds a reference can name and come from. */
export type LinkKind = "rule" | "decision";

/** BR-2423: a rule's fingerprint is its behaviour hash (BR-2236); a decision's is the hash of its `## 决定` section. */
export function fingerprint(kind: LinkKind, body: string): string {
  if (kind === "rule") return behaviourHash(body);
  const text = (section(body, DECISION_SECTION) ?? "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`决定\n${text}`).digest("hex").slice(0, 16);
}

export const isLinkable = (d: Doc): d is Rule | Decision => d.kind === "rule" || d.kind === "decision";

/** A rule not retired or a decision not superseded: the documents whose references are tracked (BR-2423). */
export const isReferrer = (d: Doc): boolean => (d.kind === "rule" && d.status !== "retired") || (d.kind === "decision" && d.status !== "superseded");

/** Every id the prose names outside code, except the document's own (BR-2423); not yet filtered to rules and decisions. */
export function proseIds(types: readonly DocType[], id: string, body: string): Set<string> {
  const ids = idsIn(types, stripCode(body));
  ids.delete(id);
  return ids;
}

/** The rules and decisions a document's prose names (BR-2423), sorted by id. */
export function namedBy(corpus: Corpus, doc: Doc, byId: ReadonlyMap<string, Doc> = indexOf(corpus)): string[] {
  return sortIds([...proseIds(corpus.types, doc.id, doc.body)].filter((id) => {
    const target = byId.get(id);
    return target !== undefined && isLinkable(target);
  }));
}

export const indexOf = (corpus: Corpus): Map<string, Doc> => new Map(corpus.docs.map((d) => [d.id, d]));

/** Ids by prefix, then by number: BR-9 before BR-10 (BR-2427). */
export function sortIds(ids: readonly string[]): string[] {
  const key = (id: string) => {
    const at = id.lastIndexOf("-");
    return [id.slice(0, at), Number(id.slice(at + 1))] as const;
  };
  return [...ids].sort((a, b) => {
    const [pa, na] = key(a);
    const [pb, nb] = key(b);
    return pa === pb ? na - nb : pa < pb ? -1 : 1;
  });
}

/** Where the history says a referring document was last checked against the one it names (BR-2424). */
export interface Baseline {
  /** The named document's fingerprint then. */
  readonly fingerprint: string;
  /** The full commit id, or undefined when it is the working tree. */
  readonly commit: string | undefined;
}

/** Answers BR-2424 for a reference; undefined when the history does not know the pair (never for a reference in the corpus it was read with). */
export type BaselineOf = (from: string, to: string) => Baseline | undefined;

export interface Link {
  readonly from: string;
  readonly to: string;
  readonly suspect: boolean;
  /** The history baseline's commit (BR-2424); undefined when it is the working tree. */
  readonly since: string | undefined;
}

/** Every reference of the corpus (BR-2423), with whether it is suspect (BR-2424, BR-2425), sorted by referring then named id. */
export function computeLinks(corpus: Corpus, baselineOf: BaselineOf): Link[] {
  const byId = indexOf(corpus);
  const prints = new Map<string, string>();
  const printOf = (d: Rule | Decision): string => {
    if (!prints.has(d.id)) prints.set(d.id, fingerprint(d.kind, d.body));
    return prints.get(d.id)!;
  };
  const out: Link[] = [];
  for (const id of sortIds(corpus.docs.filter(isReferrer).map((d) => d.id))) {
    const from = byId.get(id) as Rule | Decision;
    for (const to of namedBy(corpus, from, byId)) {
      const now = printOf(byId.get(to) as Rule | Decision);
      const base = baselineOf(from.id, to);
      // reason: the history is read together with this corpus, so a reference it does not know is a bug, not "not suspect" (fail loud)
      if (base === undefined) throw new Error(`no history baseline for ${from.id} -> ${to}`);
      // reason: either the confirmation or the history may vouch for the current version (BR-2425)
      const suspect = now !== base.fingerprint && now !== from.links?.[to];
      out.push({ from: from.id, to, suspect, since: base.commit });
    }
  }
  return out;
}

/** BR-2426: `links` keys the prose no longer names as a rule or decision. */
export function staleLinks(corpus: Corpus): { doc: Rule | Decision; id: string }[] {
  const byId = indexOf(corpus);
  const out: { doc: Rule | Decision; id: string }[] = [];
  for (const d of corpus.docs) {
    if (!isLinkable(d) || d.links === undefined) continue;
    const named = new Set(namedBy(corpus, d, byId));
    for (const id of sortIds(Object.keys(d.links))) if (!named.has(id)) out.push({ doc: d, id });
  }
  return out;
}

export const short = (commit: string | undefined): string => (commit === undefined ? "the working tree" : commit.slice(0, 7));

/** The advice that follows a suspect reference wherever it is shown (BR-2428, BR-2429). */
export const confirmHint = (l: Link): string => `${l.to} changed since ${short(l.since)}; canon links confirm ${l.from} ${l.to}`;

/**
 * BR-2428: the `# References` section of `canon context` for a rule or decision: what it names and what names it, the
 * suspect ones marked with how to confirm them.
 */
export function referenceSection(corpus: Corpus, links: readonly Link[], doc: Rule | Decision): string {
  const byId = indexOf(corpus);
  const item = (id: string, link: Link | undefined) => `- ${id} ${byId.get(id)?.title ?? ""}${link?.suspect ? ` [suspect: ${confirmHint(link)}]` : ""}`;
  const names = isReferrer(doc)
    ? links.filter((l) => l.from === doc.id).map((l) => item(l.to, l))
    : [`(not tracked: ${doc.id} is ${doc.status})`];
  const namedByOthers = sortIds(links.filter((l) => l.to === doc.id).map((l) => l.from)).map((from) => item(from, links.find((l) => l.from === from && l.to === doc.id)));
  const or = (lines: string[]) => (lines.length ? lines : ["(none)"]);
  return ["# References", "", "Names:", ...or(names), "Named by:", ...or(namedByOthers), ""].join("\n");
}
