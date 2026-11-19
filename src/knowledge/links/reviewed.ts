import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../kernel/git.ts";
import type { Corpus, Rule, Decision } from "../documents/model.ts";
import { fingerprintOf, indexOf, isReferrer, namedBy, type Link } from "./links.ts";

/**
 * References confirmed by a finished review (BR-2539, D-137): when the review after a landing finishes, every live
 * document naming a document that landing changed was in the review's scope (BR-2009), so its reference counts as
 * reviewed at the named document's new fingerprint. Kept as `link.reviewed` events in the coordination database.
 */

const key = (from: string, to: string, fingerprint: string) => `${from}>${to}>${fingerprint}`;

/** The coordination database of the repository at `root`, read-only, or undefined when there is none yet. */
function coordDb(root: string): Database | undefined {
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common.ok) return undefined;
  const path = join(common.value, "canon", "state.db");
  if (!existsSync(path)) return undefined;
  try {
    return new Database(path, { readonly: true });
  } catch {
    return undefined;
  }
}

/** Every reviewed reference, as `from>to>fingerprint` (BR-2539). */
export function reviewedKeys(root: string): ReadonlySet<string> {
  const db = coordDb(root);
  if (!db) return new Set();
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()) return new Set();
    const rows = db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'link.reviewed'").all();
    return new Set(rows.map((r) => {
      const d = JSON.parse(r.detail) as { from: string; to: string; fingerprint: string };
      return key(d.from, d.to, d.fingerprint);
    }));
  } finally {
    db.close();
  }
}

/** `links` with a suspect reference no longer suspect when a finished review saw it at the named document's current text (BR-2539). */
export function withReviewed(links: readonly Link[], corpus: Corpus, reviewed: ReadonlySet<string>): Link[] {
  if (reviewed.size === 0) return [...links];
  const byId = indexOf(corpus);
  return links.map((l) => {
    if (!l.suspect) return l;
    const to = byId.get(l.to);
    if (!to || (to.kind !== "rule" && to.kind !== "decision")) return l;
    return reviewed.has(key(l.from, l.to, fingerprintOf(to as Rule | Decision))) ? { ...l, suspect: false } : l;
  });
}

const reviewedDoc = (d: { kind: string }) => d.kind === "rule" || d.kind === "decision";

/**
 * The `link.reviewed` records one finished review implies: for each rule or decision whose fingerprint differs between
 * `before` and `after`, each live document in `after` naming it (BR-2539). `sameTop` keeps only referrers that are rules
 * in the named rule's top-level domain, for reviews from before the scope covered every referrer (backfill).
 */
export function reviewedBy(before: Corpus, after: Corpus, sameTop = false): { from: string; to: string; fingerprint: string }[] {
  const was = new Map(before.docs.filter(reviewedDoc).map((d) => [d.id, fingerprintOf(d as Rule | Decision)]));
  const byId = indexOf(after);
  const changed = new Map(after.docs.filter(reviewedDoc).flatMap((d) => {
    const fp = fingerprintOf(d as Rule | Decision);
    return was.get(d.id) === fp ? [] : [[d.id, fp] as const];
  }));
  if (changed.size === 0) return [];
  const top = (d: { kind: string; domain?: string }) => (d.kind === "rule" ? (d.domain ?? "").split("/")[0] : undefined);
  const out: { from: string; to: string; fingerprint: string }[] = [];
  for (const from of after.docs.filter(isReferrer)) {
    for (const to of namedBy(after, from, byId)) {
      const fp = changed.get(to);
      if (fp === undefined) continue;
      if (sameTop) {
        const t = byId.get(to);
        if (from.kind !== "rule" || !t || top(from as { kind: string; domain?: string }) !== top(t as { kind: string; domain?: string })) continue;
      }
      out.push({ from: from.id, to, fingerprint: fp });
    }
  }
  return out;
}
