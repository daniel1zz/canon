import { git } from "../../kernel/git.ts";
import type { Corpus, Domain } from "../documents/model.ts";
import { inAChange } from "./business.ts";

/**
 * A new domain is a division of the baseline, which is a choice with real alternatives: it must be written down as a
 * decision, where the options it rejects say why an existing domain was not reused (BR-2446, D-98).
 */

export interface DomainFinding {
  readonly path: string;
  readonly message: string;
}

/** The domain paths that exist at `ref`, by their README. */
function domainsAt(root: string, ref: string): ReadonlySet<string> {
  const out = new Set<string>();
  const tree = git(root, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", ref, "--", "canon/rules");
  if (!tree.ok) return out;
  for (const p of tree.value.split("\n")) {
    if (p.startsWith("canon/rules/") && p.endsWith("/README.md")) out.add(p.slice("canon/rules/".length, -"/README.md".length));
  }
  return out;
}

/** True when `text` names this exact domain path: `billing` is not named by `billing/refunds`, nor the other way round. */
function names(text: string, domain: string): boolean {
  return new RegExp(String.raw`(?<![/\w-])${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![/\w-])`).test(text);
}

/**
 * `domain-no-decision` for every domain this work adds that no current decision names (BR-2446). Domains that were
 * already there are never reported, so nothing has to be migrated; outside a change there is no work to compare with.
 */
export function domainDecisionFindings(root: string, corpus: Corpus, baseRefs: readonly string[] | undefined): readonly DomainFinding[] {
  if (baseRefs === undefined || baseRefs.length === 0 || !inAChange(root)) return [];
  const before = new Set(baseRefs.flatMap((r) => [...domainsAt(root, r)]));
  const added = corpus.domains.filter((d: Domain) => !before.has(d.name));
  if (added.length === 0) return [];
  // reason: a superseded decision no longer says why this domain exists, so it does not count (BR-2446)
  const current = corpus.docs.filter((d) => d.kind === "decision" && (d.status === "accepted" || d.status === "proposed"));
  return added
    .filter((d) => !current.some((doc) => names(doc.body, d.name)))
    .map((d) => ({
      path: d.path,
      message: `domain ${d.name} is new, but no accepted or proposed decision names it: record why this domain exists and why no existing domain was reused (canon decision new), then name \`${d.name}\` in it (BR-2446)`,
    }));
}
