import { createHash } from "node:crypto";
import { behaviourHash } from "../documents/behaviour.ts";
import { stripCode, type Corpus, type Decision, type Doc, type Rule } from "../documents/model.ts";
import { section } from "../documents/templates.ts";
import { idsIn, type DocType } from "../documents/types.ts";

/**
 * References between rules and decisions, read only from their prose, and which of them are suspect: the named
 * document's fingerprint differs from its record, from the starting commit's, or it was never confirmed (BR-2423, D-90, D-95).
 */

export const DECISION_SECTION = "## 决定";

/** The kinds a reference can name and come from. */
export type LinkKind = "rule" | "decision";

/** The statuses that take a document out of the tracked ones: a retired rule, a superseded decision (BR-2423). */
const UNTRACKED: Readonly<Record<LinkKind, string>> = { rule: "retired", decision: "superseded" };

/**
 * BR-2423: a rule's fingerprint is its behaviour hash (BR-2236); a decision's is the hash of its `## 决定` section. A
 * retired rule or a superseded decision has its status in the fingerprint too, so retiring it is a change.
 */
export function fingerprint(kind: LinkKind, body: string, status?: string): string {
  const behaviour = kind === "rule" ? behaviourHash(body) : sectionHash(body);
  if (status !== UNTRACKED[kind]) return behaviour;
  return createHash("sha256").update(`${behaviour}\nstatus: ${status}`).digest("hex").slice(0, 16);
}

function sectionHash(body: string): string {
  const text = (section(body, DECISION_SECTION) ?? "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`决定\n${text}`).digest("hex").slice(0, 16);
}

/** A document's fingerprint as it is in the corpus (BR-2423). */
export const fingerprintOf = (d: Rule | Decision): string => fingerprint(d.kind, d.body, d.status);

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

/** One rule or decision as it is in a commit's tree: its fingerprint and every id its prose names (BR-2424). */
export interface DocAt {
  readonly fingerprint: string;
  readonly refs: ReadonlySet<string>;
}

/** The starting commit `links_since` names, with the rules and decisions of its tree (BR-2424). */
export interface Start {
  readonly commit: string;
  readonly docs: ReadonlyMap<string, DocAt>;
}

/**
 * What a reference is compared with: its record in `links` (BR-2425); else, when the referring document named it at
 * the starting commit, the named one there (BR-2424); else nothing, so it is suspect until confirmed.
 */
export type Basis = "confirmed" | "start" | "new";

export interface Link {
  readonly from: string;
  readonly to: string;
  readonly suspect: boolean;
  readonly basis: Basis;
  /** The starting commit; undefined only in a repository without a commit. */
  readonly since: string | undefined;
}

/**
 * Every reference of the corpus (BR-2423), with whether it is suspect (BR-2424, BR-2425), sorted by referring then
 * named id. `start` is undefined only in a repository without a commit, where an unconfirmed reference is not suspect.
 */
export function computeLinks(corpus: Corpus, start: Start | undefined): Link[] {
  const byId = indexOf(corpus);
  const prints = new Map<string, string>();
  const printOf = (d: Rule | Decision): string => {
    if (!prints.has(d.id)) prints.set(d.id, fingerprintOf(d));
    return prints.get(d.id)!;
  };
  const out: Link[] = [];
  for (const id of sortIds(corpus.docs.filter(isReferrer).map((d) => d.id))) {
    const from = byId.get(id) as Rule | Decision;
    for (const to of namedBy(corpus, from, byId)) {
      const now = printOf(byId.get(to) as Rule | Decision);
      const stamp = from.links?.[to];
      const since = start?.commit;
      // reason: a record decides alone; editing the referring document is no review of what it names (BR-2425, D-95)
      if (stamp !== undefined) {
        out.push({ from: from.id, to, suspect: now !== stamp, basis: "confirmed", since });
        continue;
      }
      const then = start?.docs.get(to);
      if (start === undefined || (start.docs.get(from.id)?.refs.has(to) && then !== undefined)) {
        out.push({ from: from.id, to, suspect: then !== undefined && now !== then.fingerprint, basis: "start", since });
        continue;
      }
      out.push({ from: from.id, to, suspect: true, basis: "new", since });
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

export const short = (commit: string | undefined): string => (commit === undefined ? "the first commit" : commit.slice(0, 7));

/** Why a suspect reference is suspect, the same words wherever it is shown (BR-2427, BR-2428, BR-2429). */
export function suspectWhy(l: Link): string {
  if (l.basis === "confirmed") return `${l.to} changed since it was confirmed`;
  if (l.basis === "start") return `${l.to} changed since ${short(l.since)}`;
  return `${l.to} named after ${short(l.since)} and never confirmed`;
}

/** The advice that follows a suspect reference wherever it is shown (BR-2428, BR-2429). */
export const confirmHint = (l: Link): string => `${suspectWhy(l)}; canon links confirm ${l.from} ${l.to}`;

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
