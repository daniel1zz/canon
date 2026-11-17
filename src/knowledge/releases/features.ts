import type { Change, Corpus, Feature, Release, Rule } from "../documents/model.ts";
import type { Finding } from "../check/check.ts";
import { criteriaOf } from "./criteria.ts";

/** A release is made of the features it lists (D-130); these say which rules belong to it through them. */

/**
 * What a release is made of (BR-2509, BR-2521): its own id with the dropped releases that went into it (following
 * `merged_into` through dropped releases), and every feature any of them lists.
 */
export interface ReleaseScope {
  readonly ids: ReadonlySet<string>;
  /** The dropped releases that went into it, by number. */
  readonly merged: readonly Release[];
  readonly features: ReadonlySet<string>;
}

/** Where a release's work ends up: itself unless dropped; a dropped one's `merged_into`, followed while dropped; undefined when dropped with nowhere to go (BR-2521). */
export function landsIn(corpus: Corpus, id: string): string | undefined {
  const seen = new Set<string>();
  let at = id;
  for (;;) {
    if (seen.has(at)) return undefined;
    seen.add(at);
    const r = corpus.docs.find((d): d is Release => d.kind === "release" && d.id === at);
    if (!r) return undefined;
    if (r.status !== "dropped") return r.id;
    if (r.mergedInto === undefined) return undefined;
    at = r.mergedInto;
  }
}

export function releaseScope(corpus: Corpus, release: Release): ReleaseScope {
  // reason: a release merged into another brings its rules, plans, features and criteria along, so nothing is retagged by hand (BR-2521)
  const merged = release.status === "dropped" ? [] : corpus.docs.filter((d): d is Release => d.kind === "release" && d.id !== release.id && d.status === "dropped" && landsIn(corpus, d.id) === release.id).sort((a, b) => num(a.id) - num(b.id));
  return { ids: new Set([release.id, ...merged.map((m) => m.id)]), merged, features: new Set([release, ...merged].flatMap((r) => r.features)) };
}

/** Whether `rule` belongs to the release `scope` describes: tagged with it or a release merged into it, or attached to one of its features (BR-2509, BR-2521). */
export function inRelease(rule: Pick<Rule, "release" | "feature">, scope: ReleaseScope): boolean {
  return (rule.release !== undefined && scope.ids.has(rule.release)) || (rule.feature !== undefined && scope.features.has(rule.feature));
}

/** The releases whose `features` list `feature`, by number (BR-2507). */
export function releasesListing(corpus: Corpus, feature: string): Release[] {
  return corpus.docs.filter((d): d is Release => d.kind === "release" && d.features.includes(feature)).sort((a, b) => num(a.id) - num(b.id));
}

const num = (id: string) => Number(id.split("-")[1]);

/** A release that still counts as planned work: neither shipped nor dropped (BR-2512). */
const open = (r: Release) => r.status !== "shipped" && r.status !== "dropped";

/** `canon check`'s composition and dropped-reference findings (BR-2512). */
export function compositionFindings(corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const releases = corpus.docs.filter((d): d is Release => d.kind === "release");
  const features = new Map(corpus.docs.filter((d): d is Feature => d.kind === "feature").map((f) => [f.id, f]));
  const byId = new Map(releases.map((r) => [r.id, r]));
  for (const r of releases) {
    for (const f of r.features) if (!features.has(f)) out.push({ path: r.path, rule: "ref-dangling", message: `${r.id} \`features\` names ${f}, which does not exist` });
    if (r.mergedInto !== undefined) {
      const into = byId.get(r.mergedInto);
      if (!into) out.push({ path: r.path, rule: "ref-dangling", message: `${r.id} \`merged_into\` names ${r.mergedInto}, which does not exist` });
      // reason: a chain of merges is fine as long as it ends in a release still being built (BR-2512, BR-2521)
      else if (landsIn(corpus, r.id) === undefined) out.push({ path: r.path, rule: "release-composition", message: `${r.id} went into ${into.id}, but following merged_into from there reaches no release that is not dropped: name the release its work went to` });
    }
    if (!open(r)) continue;
    // reason: a release merged into this one brings its features, so they count here too (BR-2521)
    for (const f of releaseScope(corpus, r).features) {
      if (features.get(f)?.status === "dropped") out.push({ path: r.path, rule: "release-composition", message: `${r.id} lists ${f}, which is dropped: take it out of \`features\`` });
      const others = releases.filter((o) => o.id !== r.id && open(o) && releaseScope(corpus, o).features.has(f));
      if (others.length > 0) out.push({ path: r.path, rule: "release-composition", message: `${r.id} lists ${f}, which ${others.map((o) => o.id).join(", ")} also lists: a feature is in one release that is not shipped or dropped` });
    }
  }
  const hint = (id: string) => {
    const into = byId.get(id)?.mergedInto;
    return into ? `; it went into ${into}: tag ${into} instead` : "";
  };
  for (const d of corpus.docs) {
    if (d.kind === "rule" && d.status !== "retired") {
      // reason: a release merged into another hands its rules over; only one dropped with nowhere to go leaves them stranded (BR-2512, BR-2521)
      if (d.release !== undefined && byId.get(d.release)?.status === "dropped" && landsIn(corpus, d.release) === undefined) out.push({ path: d.path, rule: "release-dropped", message: `${d.id} is tagged ${d.release}, which is dropped${hint(d.release)}` });
      if (d.feature !== undefined && features.get(d.feature)?.status === "dropped") out.push({ path: d.path, rule: "release-dropped", message: `${d.id} is attached to ${d.feature}, which is dropped: attach it to another feature, or retire it` });
    }
    if (d.kind === "change" && d.status === "open" && d.release !== undefined && byId.get(d.release)?.status === "dropped" && landsIn(corpus, d.release) === undefined) {
      out.push({ path: d.path, rule: "release-dropped", message: `${d.id}'s plan is tagged ${d.release}, which is dropped${hint(d.release)}` });
    }
  }
  return out;
}

/** The `canon check` hints for planned releases whose rules already passed (BR-2514). */
export function plannedHints(corpus: Corpus): string[] {
  const passed = new Set(corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "done").flatMap((c) => Object.keys(c.passes)));
  const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status !== "retired");
  return corpus.docs
    .filter((d): d is Release => d.kind === "release" && d.status === "planned")
    .sort((a, b) => num(a.id) - num(b.id))
    .flatMap((r) => {
      const scope = releaseScope(corpus, r);
      const n = rules.filter((rule) => inRelease(rule, scope) && passed.has(rule.id)).length;
      return n > 0 ? [`hint release-planned: ${r.id} is planned, but ${n} rule(s) tagged with it have pass records: mark the release in progress with canon release start ${r.id}`] : [];
    });
}

/** The success criteria of every release and feature document, by document id (BR-2504). */
export function criteriaByDoc(corpus: Corpus): Map<string, ReturnType<typeof criteriaOf>> {
  return new Map(corpus.docs.filter((d) => d.kind === "release" || d.kind === "feature").map((d) => [d.id, criteriaOf(d.body, corpus.types)]));
}

/** Duplicate criterion ids in one document (BR-2516) and `advances` of open changes naming no criterion (BR-2517). */
export function criteriaFindings(corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const byDoc = criteriaByDoc(corpus);
  for (const [id, criteria] of byDoc) {
    const seen = new Set<string>();
    const doubled = new Set<string>();
    for (const c of criteria) if (c.id !== undefined) (seen.has(c.id) ? doubled : seen).add(c.id);
    const doc = corpus.docs.find((d) => d.id === id)!;
    for (const d of doubled) out.push({ path: doc.path, rule: "file-invalid", message: `${id} has success criterion ${d} more than once: each id names one criterion of the document (BR-2516)` });
  }
  // reason: a done or dropped change is history; criteria moved or removed later do not make it wrong (BR-2517)
  for (const c of corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "open")) {
    if (c.advances?.kind !== "criteria") continue;
    for (const ref of c.advances.refs) {
      const [doc, sid] = ref.split("/") as [string, string];
      const criteria = byDoc.get(doc);
      if (!criteria) out.push({ path: c.path, rule: "ref-dangling", message: `${c.id} \`advances\` names ${ref}, but ${doc} is no release or feature` });
      else if (!criteria.some((x) => x.id === sid)) out.push({ path: c.path, rule: "ref-dangling", message: `${c.id} \`advances\` names ${ref}, but ${doc} has no success criterion ${sid}` });
    }
  }
  return out;
}

/** What a landing says about the change's `advances` (BR-2517); nothing for a chore or a change that names criteria. */
export function advancesNotice(change: Change | undefined): string | undefined {
  if (!change) return undefined;
  if (change.advances === undefined) return `advances: ${change.id} names no success criterion it advances (advances: [R-n/S<k>] or "none: <reason>" in its front matter)`;
  return change.advances.kind === "none" ? `advances: ${change.id} advances no success criterion: ${change.advances.reason}` : undefined;
}
