import type { Change, Corpus, Feature, Release, Rule } from "../documents/model.ts";
import type { Finding } from "../check/check.ts";

/** A release is made of the features it lists (D-130); these say which rules belong to it through them. */

/** Whether `rule` belongs to `release`: tagged with it, or attached to a feature it lists (BR-2509). */
export function inRelease(rule: Pick<Rule, "release" | "feature">, release: Pick<Release, "id" | "features">): boolean {
  return rule.release === release.id || (rule.feature !== undefined && release.features.includes(rule.feature));
}

/** The releases a rule belongs to, by number. */
export function releasesOf(corpus: Corpus, rule: Rule): Release[] {
  return corpus.docs.filter((d): d is Release => d.kind === "release" && inRelease(rule, d)).sort((a, b) => num(a.id) - num(b.id));
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
      else if (into.status === "dropped") out.push({ path: r.path, rule: "release-composition", message: `${r.id} went into ${into.id}, which is dropped too: name the release its work went to` });
    }
    if (!open(r)) continue;
    for (const f of r.features) {
      if (features.get(f)?.status === "dropped") out.push({ path: r.path, rule: "release-composition", message: `${r.id} lists ${f}, which is dropped: take it out of \`features\`` });
      const others = releases.filter((o) => o.id !== r.id && open(o) && o.features.includes(f));
      if (others.length > 0) out.push({ path: r.path, rule: "release-composition", message: `${r.id} lists ${f}, which ${others.map((o) => o.id).join(", ")} also lists: a feature is in one release that is not shipped or dropped` });
    }
  }
  const hint = (id: string) => {
    const into = byId.get(id)?.mergedInto;
    return into ? `; it went into ${into}: tag ${into} instead` : "";
  };
  for (const d of corpus.docs) {
    if (d.kind === "rule" && d.status !== "retired") {
      if (d.release !== undefined && byId.get(d.release)?.status === "dropped") out.push({ path: d.path, rule: "release-dropped", message: `${d.id} is tagged ${d.release}, which is dropped${hint(d.release)}` });
      if (d.feature !== undefined && features.get(d.feature)?.status === "dropped") out.push({ path: d.path, rule: "release-dropped", message: `${d.id} is attached to ${d.feature}, which is dropped: attach it to another feature, or retire it` });
    }
    if (d.kind === "change" && d.status === "open" && d.release !== undefined && byId.get(d.release)?.status === "dropped") {
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
      const n = rules.filter((rule) => inRelease(rule, r) && passed.has(rule.id)).length;
      return n > 0 ? [`hint release-planned: ${r.id} is planned, but ${n} rule(s) tagged with it have pass records: mark the release in progress with canon release start ${r.id}`] : [];
    });
}
