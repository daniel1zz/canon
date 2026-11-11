import { ok, type Result } from "../../kernel/result.ts";
import type { Corpus, Decision, Rule } from "../documents/model.ts";
import { indexOf, isReferrer, namedBy, sortIds } from "./links.ts";
import { docsAt } from "./start.ts";

/** One referring document and the whole `links` it gets: its kept records plus the new ones (BR-2425). */
export interface Stamp {
  readonly doc: Rule | Decision;
  readonly links: Record<string, string>;
  /** The named ids recorded by this landing. */
  readonly added: readonly string[];
}

/**
 * BR-2440: the records a landing writes for the references its change added. `corpus` is the rebased tree; `fork` is
 * where the change's branch left main and `before` the branch before the rebase. A reference counts as added when the
 * referring document names it at `before` and did not at `fork`; its record is the named document's fingerprint at
 * `before`, what the author read, so a named document main changed meanwhile shows as suspect after the landing.
 * A reference that already has a record keeps it.
 */
export function addedReferenceStamps(root: string, corpus: Corpus, fork: string, before: string): Result<Stamp[]> {
  const then = docsAt(root, corpus.types, fork);
  if (!then.ok) return then;
  const read = docsAt(root, corpus.types, before);
  if (!read.ok) return read;
  const byId = indexOf(corpus);
  const out: Stamp[] = [];
  for (const id of sortIds(corpus.docs.filter(isReferrer).map((d) => d.id))) {
    const doc = byId.get(id) as Rule | Decision;
    const named = namedBy(corpus, doc, byId);
    const written = read.value.get(id);
    const added: [string, string][] = [];
    for (const to of named) {
      if (doc.links?.[to] !== undefined || !written?.refs.has(to) || then.value.get(id)?.refs.has(to)) continue;
      // reason: a named document the branch did not have came from main; the author never read it, so no record (stays suspect)
      const seen = read.value.get(to);
      if (seen !== undefined) added.push([to, seen.fingerprint]);
    }
    if (added.length === 0) continue;
    // reason: keys the prose no longer names go, as canon links confirm drops them (BR-2425, BR-2426)
    const kept = Object.entries(doc.links ?? {}).filter(([k]) => named.includes(k));
    const next = Object.fromEntries([...kept, ...added]);
    out.push({ doc, links: Object.fromEntries(sortIds(Object.keys(next)).map((k) => [k, next[k]!])), added: added.map(([k]) => k) });
  }
  return ok(out);
}
