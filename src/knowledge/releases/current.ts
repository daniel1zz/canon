import type { Change, Corpus, Feature, Release } from "../documents/model.ts";
import { criteriaOf, type Criterion } from "./criteria.ts";
import { releaseScope } from "./features.ts";
import type { ReleaseStatus, Workload } from "./status.ts";

/**
 * The releases in progress and their success criteria (BR-2505, BR-2521): what `canon overview`, the agenda's owner group
 * (BR-2527) and goal mode (BR-2518) read, each from main's documents.
 */

/** A criterion with the changes whose `advances` name it, the highest numbers first (BR-2517). */
export interface CriterionView extends Criterion {
  readonly advancedBy: readonly string[];
}

export interface FeatureView {
  readonly doc: Feature;
  readonly criteria: readonly CriterionView[];
}

export interface CurrentRelease {
  readonly doc: Release;
  /** No release is active: the lowest-numbered planned one stands in (BR-2505). */
  readonly fallback: boolean;
  /** Its rule counts; left out where computing every rule's execution state costs too much (BR-2506). */
  readonly status: ReleaseStatus | undefined;
  readonly criteria: readonly CriterionView[];
  /** The features it lists that exist and are not dropped, in its order, then those of releases merged into it (BR-2521). */
  readonly features: readonly FeatureView[];
  /** The dropped releases merged into it, with their own criteria (BR-2521). */
  readonly merged: readonly { readonly doc: Release; readonly criteria: readonly CriterionView[] }[];
  /** The workload of its linked changes (BR-2328, BR-2570). */
  readonly work?: Workload;
}

const number = (id: string) => Number(id.split("-")[1]);

/** The releases in progress (BR-2505): every active one by number, else the lowest-numbered planned one. */
export function releasesInProgress(corpus: Corpus): { doc: Release; fallback: boolean }[] {
  const of = (status: string) => corpus.docs.filter((d): d is Release => d.kind === "release" && d.status === status).sort((a, b) => number(a.id) - number(b.id));
  const active = of("active");
  if (active.length > 0) return active.map((doc) => ({ doc, fallback: false }));
  const planned = of("planned")[0];
  return planned ? [{ doc: planned, fallback: true }] : [];
}

/** How many changes advancing a criterion are named (BR-2519). */
const ADVANCED_SHOWN = 3;

/** The releases `picks` with their own criteria and their features' (dropped ones left out); `statuses` gives the rule counts when computed. */
export function releaseViews(corpus: Corpus, picks: readonly { doc: Release; fallback: boolean }[], statuses: readonly ReleaseStatus[] = []): CurrentRelease[] {
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status !== "dropped").sort((a, b) => number(b.id) - number(a.id));
  const view = (docId: string, body: string): CriterionView[] =>
    criteriaOf(body, corpus.types).map((c) => ({
      ...c,
      advancedBy: changes.filter((ch) => ch.advances?.kind === "criteria" && ch.advances.refs.includes(`${docId}/${c.id}`)).slice(0, ADVANCED_SHOWN).map((ch) => ch.id),
    }));
  return picks.map(({ doc, fallback }) => {
    const scope = releaseScope(corpus, doc);
    return {
      doc,
      fallback,
      status: statuses.find((s) => s.release.id === doc.id),
      criteria: view(doc.id, doc.body),
      features: [...scope.features]
        .map((f) => corpus.docs.find((d): d is Feature => d.kind === "feature" && d.id === f))
        .filter((f): f is Feature => f !== undefined && f.status !== "dropped")
        .map((f) => ({ doc: f, criteria: view(f.id, f.body) })),
      merged: scope.merged.map((m) => ({ doc: m, criteria: view(m.id, m.body) })),
    };
  });
}

/** All criteria of a release in progress, with the document each belongs to: its own, its features', those merged into it (BR-2505, BR-2521). */
export const criteriaWithDoc = (r: CurrentRelease): { doc: string; c: CriterionView }[] => [
  ...r.criteria.map((c) => ({ doc: r.doc.id, c })),
  ...r.features.flatMap((f) => f.criteria.map((c) => ({ doc: f.doc.id, c }))),
  ...r.merged.flatMap((m) => m.criteria.map((c) => ({ doc: m.doc.id, c }))),
];

/** All criteria of a release in progress (BR-2506). */
export const allCriteria = (r: CurrentRelease): Criterion[] => criteriaWithDoc(r).map((x) => x.c);

/** A release without its rule counts: id, status, title (BR-2505's status line). */
export const headLine = (r: Release) => `${r.id}  ${r.status}  ${r.title}`;
