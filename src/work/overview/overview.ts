import { git } from "../../kernel/git.ts";
import { stalledDelegations, stalledLine, type StalledDelegation } from "../delegation/stall.ts";
import { ok, type Result } from "../../kernel/result.ts";
import { goalChangesBetween } from "../../knowledge/releases/goal-landing.ts";
import { backlogAt } from "../../knowledge/documents/backlog.ts";
import type { Advances, Change, Corpus, Feature, Release } from "../../knowledge/documents/model.ts";
import { planStatuses, summaryLine as planLine, type PlanStatus } from "../../knowledge/plans/status.ts";
import { CRITERION_LABEL, criteriaCountLine, criteriaOf, type Criterion } from "../../knowledge/releases/criteria.ts";
import { releaseStatuses, summaryLine as releaseLine, type ReleaseStatus } from "../../knowledge/releases/status.ts";
import { releaseScope } from "../../knowledge/releases/features.ts";
import { briefQualityLine, overviewQualityLine, qualitySummary, type QualitySummary } from "../../knowledge/quality/aspects.ts";
import { openFindings, type OpenFinding } from "../../knowledge/review/findings/findings.ts";
import { executionStates } from "../execution/state.ts";
import { questions, type Question } from "../humans/questions.ts";
import { listedChanges, marksOf, type ListedChange } from "../session/inflight.ts";
import { mainCorpus } from "../session/session.ts";
import { isChore } from "../session/subject.ts";
import type { Workspace } from "../workspace.ts";

/** `canon overview` (BR-2505, D-129): the whole progress from the current release down, each part computed by its own domain. */

/** How many changes of the owner's order, and how many landings, the overview names (BR-2505). */
const BACKLOG_SHOWN = 5;
const LANDED_SHOWN = 5;

export interface Landed {
  readonly id: string;
  readonly title: string | undefined;
  /** The `land.ok` event's time, ISO. */
  readonly at: string;
  /** Its `advances` on main (BR-2517); undefined when it names none or its file is not there. */
  readonly advances: Advances | undefined;
}

/** A criterion with the changes whose `advances` name it, the highest numbers first (BR-2505, BR-2517). */
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
  /** Its rule counts; left out of the brief, which cannot afford computing every rule's execution state (BR-2506). */
  readonly status: ReleaseStatus | undefined;
  readonly criteria: readonly CriterionView[];
  /** The features it lists that exist and are not dropped, in its order (BR-2505), then those of releases merged into it (BR-2521). */
  readonly features: readonly FeatureView[];
  /** The dropped releases merged into it, with their own criteria (BR-2521). */
  readonly merged: readonly { readonly doc: Release; readonly criteria: readonly CriterionView[] }[];
}

export interface Overview {
  /** The releases in progress (BR-2505): every active one, else the lowest planned one; empty when none. */
  readonly releases: readonly CurrentRelease[];
  readonly plans: readonly PlanStatus[];
  readonly waiting: { readonly questions: readonly Question[]; readonly findings: readonly OpenFinding[]; readonly criteria: readonly { readonly doc: string; readonly text: string }[]; readonly stalled: readonly StalledDelegation[] };
  readonly backlog: readonly ListedChange[];
  readonly backlogMore: number;
  /** Open changes naming neither a release nor a feature: the scope AI sessions chose themselves, all of them (BR-2505, D-148). */
  readonly currentBatch: readonly ListedChange[];
  readonly landed: readonly Landed[];
  /** Commits on main of the last GOAL_DAYS days that changed the goal, newest first (BR-2505, BR-2510). */
  readonly goalChanges: readonly GoalCommit[];
  /** How far quality standards cover the product's aspects on main (BR-2558). */
  readonly quality: QualitySummary;
}

export interface GoalCommit {
  readonly sha: string;
  readonly subject: string;
  readonly changes: readonly string[];
}

/** How far back the overview and the brief show changes to the goal (BR-2505, BR-2506). */
const GOAL_DAYS = 7;

/** main's commits of the last GOAL_DAYS days that changed a release's or feature's goal, worked out from git each time (BR-2510). */
function goalCommits(ws: Workspace): GoalCommit[] {
  const dirs = ["release", "feature"].map((n) => ws.config.types.find((t) => t.name === n)).filter((t) => t !== undefined).map((t) => `canon/${t.dir}`);
  const log = git(ws.primary, "log", ws.config.main, `--since=${GOAL_DAYS}.days`, "--format=%H%x09%s", "--", ...dirs);
  if (!log.ok || log.value.trim() === "") return [];
  const out: GoalCommit[] = [];
  for (const line of log.value.trim().split("\n")) {
    const [sha, subject] = line.split("\t") as [string, string];
    // reason: a root commit has no parent to compare with; everything in it is the first goal, not a change to one
    if (!git(ws.primary, "rev-parse", "--verify", "--quiet", `${sha}^`).ok) continue;
    const paths = git(ws.primary, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", `${sha}^`, sha, "--", ...dirs);
    const changes = goalChangesBetween(ws.primary, `${sha}^`, sha, paths.ok && paths.value !== "" ? paths.value.split("\n") : [], ws.config.types);
    if (changes.length > 0) out.push({ sha, subject, changes });
  }
  return out;
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

/** How many changes advancing a criterion the overview names (BR-2505). */
const ADVANCED_SHOWN = 3;

/**
 * The releases `picks` with their own criteria and their features' (dropped ones left out), each criterion with the
 * changes on main advancing it (BR-2505); `statuses` gives the rule counts when computed.
 */
export function releaseViews(corpus: Corpus, picks: readonly { doc: Release; fallback: boolean }[], statuses: readonly ReleaseStatus[] = []): CurrentRelease[] {
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status !== "dropped").sort((a, b) => number(b.id) - number(a.id));
  const view = (docId: string, body: string): CriterionView[] =>
    criteriaOf(body, corpus.types).map((c) => ({
      ...c,
      advancedBy: c.id === undefined ? [] : changes.filter((ch) => ch.advances?.kind === "criteria" && ch.advances.refs.includes(`${docId}/${c.id}`)).slice(0, ADVANCED_SHOWN).map((ch) => ch.id),
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

/** Everything the overview shows, read from main's documents and the coordination state. */
export function overview(ws: Workspace, opts: { readonly ruleCounts: boolean }): Result<Overview> {
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  const backlog = backlogAt(ws.primary, ws.config.main, ws.config.types);
  if (!backlog.ok) return backlog;
  // reason: read once with every change, as the brief does: plans count done ones too, the order only open ones (BR-2373, BR-2149)
  const every = listedChanges(ws, corpus.value, backlog.value, () => true);
  if (!every.ok) return every;
  const current = releasesInProgress(corpus.value);
  const statuses = current.length > 0 && opts.ruleCounts ? releaseStatuses(corpus.value, executionStates(ws.root, corpus.value, ws.config.floorTiming)) : [];
  const releases = releaseViews(corpus.value, current, statuses);
  const owner = releases.flatMap((r) => [
    ...r.criteria.filter((c) => c.state === "owner").map((c) => ({ doc: r.doc.id, text: c.text })),
    ...[...r.features, ...r.merged].flatMap((f) => f.criteria.filter((c) => c.state === "owner").map((c) => ({ doc: f.doc.id, text: c.text }))),
  ]);
  const open = every.value.listed.filter((l) => l.change.status === "open" || (l.onBranch.length > 0 && l.change.status === "done"));
  // reason: a delegation nobody works on waits for its design owner, so it is listed with what waits for the owner (BR-2522, #255)
  const stalled = stalledDelegations(ws);
  if (!stalled.ok) return stalled;
  return ok({
    releases,
    plans: planStatuses(corpus.value, every.value.listed.map((l) => ({ change: l.change, onMain: l.onBranch.length === 0 })), new Set(stalled.value.map((s) => s.subject))),
    waiting: {
      questions: questions(ws.db, "pending"),
      findings: openFindings(ws.db).filter((f) => f.tier === "C"),
      criteria: owner,
      stalled: stalled.value,
    },
    backlog: open.slice(0, BACKLOG_SHOWN),
    backlogMore: Math.max(0, open.length - BACKLOG_SHOWN),
    // reason: no progress is computed for it; it is listed so the owner sees what AI sessions chose to deliver (BR-2505, P7)
    currentBatch: open.filter((l) => l.change.status === "open" && l.change.release === undefined && l.change.feature === undefined),
    landed: landed(ws, corpus.value),
    goalChanges: goalCommits(ws),
    quality: qualitySummary(corpus.value),
  });
}

/** The latest landings of changes, newest first, chores left out (BR-2505). */
export function landed(ws: Workspace, corpus: Corpus): Landed[] {
  const rows = ws.db.db.query<{ ts: string; subject: string | null }, []>("SELECT ts, subject FROM events WHERE kind = 'land.ok' ORDER BY id DESC").all();
  const out: Landed[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (out.length >= LANDED_SHOWN) break;
    if (!r.subject || isChore(r.subject) || seen.has(r.subject)) continue;
    seen.add(r.subject);
    const doc = corpus.docs.find((d) => d.id === r.subject);
    out.push({ id: r.subject, title: doc?.title, at: r.ts, advances: doc?.kind === "change" ? doc.advances : undefined });
  }
  return out;
}

/** A release without its rule counts: id, status, title, as `canon release status` starts its line (BR-2506). */
export const headLine = (r: Release) => `${r.id}  ${r.status}  ${r.title}`;
const FALLBACK = "(没有 active 的版本，取编号最小的 planned；正在做的版本把 status 改成 active)";

const firstLine = (s: string) => s.split("\n")[0]!.trim();
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** One criterion's line (BR-2505): state, id, text, evidence, the changes advancing it. */
const criterionLine = (c: CriterionView) =>
  `[${CRITERION_LABEL[c.state]}] ${c.id !== undefined ? `${c.id} ` : ""}${c.text}${c.evidence.length > 0 ? `  证据：${c.evidence.join(", ")}` : ""}${c.advancedBy.length > 0 ? `  推进：${c.advancedBy.join(", ")}` : ""}`;

/** All criteria of a release in progress: its own and its features' (BR-2506). */
export const allCriteria = (r: CurrentRelease): Criterion[] => [...r.criteria, ...r.features.flatMap((f) => f.criteria), ...r.merged.flatMap((m) => m.criteria)];

/** What a landed change says it advanced (BR-2505, BR-2517). */
const advancesMark = (a: Advances | undefined) => (a === undefined ? "  （没写 advances）" : a.kind === "none" ? `  （不推进：${a.reason}）` : `  → ${a.refs.join(", ")}`);

const questionLine = (q: Question) => `问题 #${q.id} ${firstLine(q.question)}`;
const findingLine = (f: OpenFinding) => `意见 #${f.id} ${f.ids.length > 0 ? f.ids.join(", ") : "-"}: ${firstLine(f.text)}`;

/** The heading of the open changes in no release or feature (BR-2505). */
export const CURRENT_BATCH = "## 当前这一批（没挂版本或模块，AI 会话自己定的）";

/** The six sections of `canon overview` (BR-2505). */
export function overviewLines(o: Overview): string[] {
  const out: string[] = ["## 当前版本"];
  if (o.releases.length === 0) out.push("(no release in progress)");
  for (const r of o.releases) {
    out.push(r.status ? releaseLine(r.status) : headLine(r.doc));
    if (r.fallback) out.push(FALLBACK);
    out.push(criteriaCountLine(r.criteria), ...r.criteria.map((c) => `  ${criterionLine(c)}`));
    for (const f of r.features) out.push(`  模块 ${f.doc.id} ${f.doc.title}  ${criteriaCountLine(f.criteria)}`, ...f.criteria.map((c) => `    ${criterionLine(c)}`));
    for (const m of r.merged) out.push(`  并入 ${m.doc.id} ${m.doc.title}  ${criteriaCountLine(m.criteria)}`, ...m.criteria.map((c) => `    ${criterionLine(c)}`));
  }
  // reason: one line after the releases every time, a reminder when nothing is set or an aspect is uncovered (BR-2505, BR-2558)
  out.push(overviewQualityLine(o.quality));
  if (o.goalChanges.length > 0) {
    out.push(`最近 ${GOAL_DAYS} 天的目标改动：`);
    for (const g of o.goalChanges) out.push(`  ${g.sha.slice(0, 9)} ${g.subject}`, ...g.changes.map((c) => `    ${c}`));
  }
  out.push("", "## 计划", ...(o.plans.length > 0 ? o.plans.map(planLine) : ["(no plans)"]));
  const waiting = [...o.waiting.questions.map(questionLine), ...o.waiting.findings.map(findingLine), ...o.waiting.criteria.map((c) => `成功标准 ${c.doc}: ${c.text}`), ...o.waiting.stalled.map(stalledLine)];
  out.push("", "## 等负责人", ...(waiting.length > 0 ? waiting : ["(nothing)"]));
  out.push("", "## 待办顺序");
  if (o.backlog.length === 0) out.push("(none)");
  for (const l of o.backlog) {
    const marks = marksOf(l, false);
    out.push(`${l.change.id} ${l.change.title}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`);
  }
  if (o.backlogMore > 0) out.push(`… 还有 ${o.backlogMore} 个（canon change list）`);
  out.push("", CURRENT_BATCH, ...(o.currentBatch.length > 0 ? o.currentBatch.map((l) => `${l.change.id} ${l.change.title}`) : ["(none)"]));
  out.push("", "## 最近合入", ...(o.landed.length > 0 ? o.landed.map((l) => `${l.id}${l.title ? ` ${l.title}` : ""} ${minute(l.at)}${advancesMark(l.advances)}`) : ["(none)"]));
  return out;
}

const criterionJson = (c: CriterionView) => ({ id: c.id ?? null, text: c.text, state: c.state, evidence: c.evidence, advanced_by: c.advancedBy });

/** The `--json` form (BR-2505). */
export function overviewJson(o: Overview): Record<string, unknown> {
  return {
    releases: o.releases.map((r) => ({
      id: r.doc.id,
      title: r.doc.title,
      status: r.doc.status,
      fallback: r.fallback,
      ...(r.status ? { counts: r.status.counts } : {}),
      criteria: r.criteria.map(criterionJson),
      features: r.features.map((f) => ({ id: f.doc.id, title: f.doc.title, criteria: f.criteria.map(criterionJson) })),
      merged: r.merged.map((m) => ({ id: m.doc.id, title: m.doc.title, criteria: m.criteria.map(criterionJson) })),
    })),
    plans: o.plans.map((p) => ({ id: p.change.id, title: p.change.title, total: p.steps.length, done: p.counts.done, percent: p.percent })),
    waiting: {
      questions: o.waiting.questions.map((q) => ({ id: q.id, question: q.question })),
      findings: o.waiting.findings.map((f) => ({ id: f.id, ids: f.ids, text: f.text })),
      criteria: o.waiting.criteria.map((c) => ({ doc: c.doc, text: c.text })),
      stalled: o.waiting.stalled,
    },
    backlog: o.backlog.map((l) => ({ id: l.change.id, title: l.change.title, marks: marksOf(l, false) })),
    backlog_more: o.backlogMore,
    current_batch: o.currentBatch.map((l) => ({ id: l.change.id, title: l.change.title })),
    landed: o.landed.map((l) => ({ id: l.id, title: l.title ?? null, at: l.at, advances: l.advances === undefined ? null : l.advances.kind === "none" ? { none: l.advances.reason } : l.advances.refs })),
    goal_changes: o.goalChanges.map((g) => ({ sha: g.sha, subject: g.subject, changes: g.changes })),
    quality: { standards: o.quality.standards, drafts: o.quality.drafts, uncovered: o.quality.uncovered, none: o.quality.none },
  };
}

/** The brief's summary of the first three sections, where no change is claimed (BR-2506). */
export function briefSummary(o: Overview): string[] {
  const notDone = o.plans.filter((p) => p.counts.done < p.steps.length);
  const { questions: q, findings: f, criteria: c, stalled: st } = o.waiting;
  const quality = briefQualityLine(o.quality);
  // reason: with nothing to say the brief stays the bare guide (BR-2024, BR-2506)
  if (o.releases.length === 0 && notDone.length === 0 && q.length + f.length + c.length + st.length === 0 && o.goalChanges.length === 0 && quality === undefined) return [];
  const out = ["Overall progress (canon overview):"];
  for (const r of o.releases) out.push(`  ${headLine(r.doc)}  ${criteriaCountLine(allCriteria(r))}${r.fallback ? "  (no release is active: the lowest planned one)" : ""}`);
  if (o.releases.length === 0) out.push("  no release in progress");
  if (notDone.length > 0) out.push(`  plans not done: ${notDone.map((p) => `${p.change.id} ${p.counts.done}/${p.steps.length} (${p.percent}%)`).join(", ")}`);
  if (o.goalChanges.length > 0) out.push(`  goal changed in the last ${GOAL_DAYS} days: ${o.goalChanges.map((g) => g.sha.slice(0, 9)).join(", ")} (canon overview)`);
  if (q.length + f.length + c.length > 0) out.push(`  waiting for the owner: ${q.length} question(s), ${f.length} tier-C finding(s), ${c.length} criterion(s)`);
  if (st.length > 0) out.push(`  stalled delegations: ${st.map((s) => s.subject).join(", ")} (canon work status)`);
  // reason: only a reminder, short because every session reads it (BR-2506, BR-2558, D-139)
  if (quality !== undefined) out.push(`  ${quality}`);
  return out;
}
