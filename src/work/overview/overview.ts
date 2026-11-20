import { git } from "../../kernel/git.ts";
import { changeStates, hasFile, isClosed, stateMark, type Filed } from "../../knowledge/changes/state.ts";
import { waitingMark } from "../../knowledge/changes/deps.ts";
import { ok, type Result } from "../../kernel/result.ts";
import { goalChangesBetween } from "../../knowledge/releases/goal-landing.ts";
import type { Advances, Change, Corpus } from "../../knowledge/documents/model.ts";
import { CRITERION_LABEL, criteriaCountLine } from "../../knowledge/releases/criteria.ts";
import { allCriteria, criteriaWithDoc, headLine, releasesInProgress, releaseViews, type CurrentRelease } from "../../knowledge/releases/current.ts";
import { releaseStatuses } from "../../knowledge/releases/status.ts";
import { STATE_LABEL, STATE_ORDER } from "../execution/state.ts";
import { standings, verdictLine, verdictSummary } from "../../knowledge/quality/verdicts.ts";
import { briefQualityLine, overviewQualityLine, qualitySummary, type QualitySummary } from "../../knowledge/quality/aspects.ts";
import { executionStates } from "../execution/state.ts";
import { agenda, agendaJson, summaryLines, type Agenda } from "../reminders/agenda.ts";
import { mainCorpus } from "../session/session.ts";
import { isChore } from "../session/subject.ts";
import type { Workspace } from "../workspace.ts";

/**
 * `canon overview` (BR-2505, D-129, D-151 part 4): the current state only. The current release with its criteria, the
 * agenda (work/reminders), the changes in progress or waiting, and an outline of the history; `--history` gives the
 * detail. Each part is computed by its own domain; this one only picks and orders.
 */

/** How many landings the outline and the detail name, and the most changes in progress or waiting listed (BR-2505). */
const LANDED_OUTLINE = 3;
export const LANDED_DETAIL = 10;
const CHANGES_SHOWN = 15;
/** The most ids the current batch line names (BR-2505). */
const BATCH_SHOWN = 12;
/** How far back the goal changes go (BR-2505, BR-2506). */
const GOAL_DAYS = 7;
/** The primary states listed under `## 正在做和在等` (BR-2505); stalled, refused, awaiting close and ready ones are on the agenda. */
const IN_FLIGHT: ReadonlySet<string> = new Set(["in-queue", "in-progress", "delegated", "handed-off", "waiting-owner", "waiting-deps"]);

export interface Landed {
  readonly id: string;
  readonly title: string | undefined;
  /** The `land.ok` event's time, ISO. */
  readonly at: string;
  /** Its `advances` on main (BR-2517); undefined when it names none or its file is not there. */
  readonly advances: Advances | undefined;
}

export interface GoalCommit {
  readonly sha: string;
  readonly subject: string;
  readonly changes: readonly string[];
}

export interface Overview {
  /** The releases in progress (BR-2505): every active one, else the lowest planned one; empty when none. */
  readonly releases: readonly CurrentRelease[];
  readonly quality: QualitySummary;
  /** The verdict states of the standards in force (BR-2590), or why they could not be worked out; undefined where not asked for or there is no standard. */
  readonly verdicts: ReturnType<typeof verdictSummary> | string | undefined;
  /** The agenda, or why it could not be worked out; undefined where it was not asked for (the brief). */
  readonly agenda: Agenda | string | undefined;
  readonly changes: readonly Filed[];
  readonly changesMore: number;
  /** The current batch (BR-2505, D-148): every open change, on main or only on its branch, naming neither a release nor a feature. */
  readonly batch: readonly Filed[];
  readonly goalCommits: readonly GoalCommit[];
  readonly landed: readonly Landed[];
}

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

/** The goal changes counted by the release or feature they are in, by id (BR-2505's outline). */
export function goalCounts(commits: readonly GoalCommit[]): { doc: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const g of commits) for (const c of g.changes) {
    const doc = /^([A-Za-z]+-\d+)/.exec(c)?.[1];
    if (doc) counts.set(doc, (counts.get(doc) ?? 0) + 1);
  }
  // reason: by kind, then by number, so R-2 comes before R-12
  return [...counts].sort(([a], [b]) => a.split("-")[0]!.localeCompare(b.split("-")[0]!) || Number(a.split("-")[1]) - Number(b.split("-")[1])).map(([doc, count]) => ({ doc, count }));
}

/** Everything the overview shows, read from main's documents and the coordination state; `agenda: false` for the brief, which prints the agenda itself. */
export function overview(ws: Workspace, opts: { readonly ruleCounts: boolean; readonly agenda?: boolean; readonly landed?: number }): Result<Overview> {
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  const current = releasesInProgress(corpus.value);
  const statuses = current.length > 0 && opts.ruleCounts ? releaseStatuses(corpus.value, executionStates(ws.root, corpus.value, ws.config.floorTiming)) : [];
  const releases = releaseViews(corpus.value, current, statuses);
  let changes: Filed[] = [];
  let batch: Filed[] = [];
  let a: Agenda | string | undefined;
  if (opts.agenda !== false) {
    // reason: every change's state from the one place that computes it, read once with the agenda (BR-2571, D-151)
    const got = agenda(ws);
    a = got.ok ? got.value : got.error.message;
    let states = got.ok ? got.value.states : undefined;
    if (!states) {
      const every = changeStates(ws, { corpus: corpus.value, delegatable: false });
      if (!every.ok) return every;
      states = every.value.states;
    }
    changes = states.filter(hasFile).filter((s) => IN_FLIGHT.has(s.state));
    // reason: the same states, so the batch is never a second computation of which changes are open (BR-2505, D-149)
    batch = states.filter(hasFile).filter((s) => !isClosed(s) && s.change.release === undefined && s.change.feature === undefined);
  }
  const summary = qualitySummary(corpus.value);
  let verdicts: Overview["verdicts"];
  if (opts.agenda !== false && summary.standards > 0) {
    const s = standings(ws, corpus.value);
    verdicts = s.ok ? verdictSummary(s.value) : s.error.message;
  }
  return ok({
    releases,
    quality: summary,
    verdicts,
    agenda: a,
    changes: changes.slice(0, CHANGES_SHOWN),
    changesMore: Math.max(0, changes.length - CHANGES_SHOWN),
    batch,
    goalCommits: goalCommits(ws),
    landed: landed(ws, corpus.value, opts.landed ?? LANDED_OUTLINE),
  });
}

/**
 * The latest landings, newest first (BR-2505): a change's own, and a chore's under the light change main has for it
 * (BR-2458); other chores are left out.
 */
export function landed(ws: Workspace, corpus: Corpus, n: number = LANDED_OUTLINE): Landed[] {
  const rows = ws.db.db.query<{ ts: string; subject: string | null }, []>("SELECT ts, subject FROM events WHERE kind = 'land.ok' ORDER BY id DESC").all();
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change");
  const out: Landed[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (out.length >= n) break;
    if (!r.subject) continue;
    // reason: a light change has a C number once its chore landed; the landing is listed under it (BR-2505, BR-2458)
    const doc = isChore(r.subject) ? changes.find((c) => c.chore === r.subject) : changes.find((c) => c.id === r.subject);
    if (isChore(r.subject) && !doc) continue;
    const id = doc?.id ?? r.subject;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: doc?.title, at: r.ts, advances: doc?.advances });
  }
  return out;
}

const FALLBACK = "(没有 active 的版本，取编号最小的 planned；正在做的版本把 status 改成 active)";
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** A criterion's first sentence: up to the first 。！？, or all of it (BR-2505). */
export const firstSentence = (text: string): string => /^.*?[。！？]/.exec(text)?.[0] ?? text;

/** The rule-count line of a release in progress (BR-2505). */
function rulesLine(r: CurrentRelease): string | undefined {
  if (!r.status) return undefined;
  const total = STATE_ORDER.reduce((n, k) => n + r.status!.counts[k], 0);
  return `规则 ${total} 条：${STATE_ORDER.map((k) => `${STATE_LABEL[k]} ${r.status!.counts[k]}`).join("  ")}`;
}

/** What a landed change says it advanced (BR-2505, BR-2517). */
const advancesMark = (a: Advances | undefined) => (a === undefined ? "  （没写 advances）" : a.kind === "none" ? `  （不推进：${a.reason}）` : `  → ${a.refs.join(", ")}`);

/** The current batch in one line (BR-2505): the count and up to BATCH_SHOWN ids, or none. */
function batchLine(batch: readonly Filed[]): string {
  const head = "当前这一批（没挂版本或模块）：";
  if (batch.length === 0) return `${head}没有`;
  const ids = batch.slice(0, BATCH_SHOWN).map((s) => s.id);
  if (batch.length > BATCH_SHOWN) ids.push(`… +${batch.length - BATCH_SHOWN}`);
  return `${head}${batch.length} 个：${ids.join(", ")}`;
}

/** The four sections of `canon overview` (BR-2505). */
export function overviewLines(o: Overview): string[] {
  const out: string[] = ["## 当前版本"];
  if (o.releases.length === 0) out.push("(no release in progress)");
  for (const r of o.releases) {
    out.push(headLine(r.doc));
    if (r.fallback) out.push(FALLBACK);
    const rules = rulesLine(r);
    if (rules) out.push(rules);
    out.push(criteriaCountLine(allCriteria(r)));
    // reason: merged releases are one summary line; their criteria are counted above, not listed (BR-2505, BR-2521)
    for (const { doc, c } of criteriaWithDoc(r).filter((x) => !r.merged.some((m) => m.doc.id === x.doc))) out.push(`  [${CRITERION_LABEL[c.state]}] ${doc}/${c.id} ${firstSentence(c.text)}`);
    if (r.merged.length > 0) out.push(`并入 ${r.merged.length} 个版本：${r.merged.map((m) => m.doc.id).join(", ")}  ${criteriaCountLine(r.merged.flatMap((m) => m.criteria))}`);
  }
  // reason: one line after the releases every time, a reminder when nothing is set or an aspect is uncovered (BR-2505, BR-2558)
  out.push(overviewQualityLine(o.quality));
  if (typeof o.verdicts === "string") out.push(`质量判定 unavailable: ${o.verdicts}`);
  else if (o.verdicts) out.push(verdictLine(o.verdicts));
  out.push("", "## 议程");
  if (typeof o.agenda === "string") out.push(`agenda unavailable: ${o.agenda}`);
  else {
    const lines = o.agenda ? summaryLines(o.agenda) : [];
    out.push(...(lines.length > 0 ? lines : ["(nothing)"]));
  }
  out.push("", "## 正在做和在等");
  if (o.changes.length === 0) out.push("(none)");
  for (const s of o.changes) out.push(`${s.id} ${s.change.title}  ${s.state === "waiting-deps" ? `waiting-deps: ${waitingMark(s.waiting)?.replace(/^waiting for /, "") ?? ""}` : stateMark(s)}`);
  if (o.changesMore > 0) out.push(`… 还有 ${o.changesMore} 个（canon change list）`);
  out.push(batchLine(o.batch));
  out.push("", "## 历史");
  const counts = goalCounts(o.goalCommits);
  if (counts.length > 0) out.push(`最近 ${GOAL_DAYS} 天的目标改动：${counts.map((c) => `${c.doc} ${c.count} 处`).join("，")}`);
  for (const l of o.landed) out.push(`${l.id}${l.title ? ` ${l.title}` : ""}  ${minute(l.at)}`);
  out.push("细节：canon overview --history");
  return out;
}

/** `canon overview --history` (BR-2505): the goal changes in full and the latest landings with what they advanced. */
export function historyLines(o: Overview): string[] {
  const out = [`## 最近 ${GOAL_DAYS} 天的目标改动`];
  if (o.goalCommits.length === 0) out.push("(none)");
  for (const g of o.goalCommits) out.push(`${g.sha.slice(0, 9)} ${g.subject}`, ...g.changes.map((c) => `  ${c}`));
  out.push("", "## 最近合入", ...(o.landed.length > 0 ? o.landed.map((l) => `${l.id}${l.title ? ` ${l.title}` : ""} ${minute(l.at)}${advancesMark(l.advances)}`) : ["(none)"]));
  return out;
}

const counted = (criteria: readonly { state: string }[]) => Object.fromEntries(["met", "unmet", "owner", "unproven"].map((k) => [k, criteria.filter((c) => c.state === k).length]));

/** The `--json` form (BR-2505). */
export function overviewJson(o: Overview): Record<string, unknown> {
  return {
    releases: o.releases.map((r) => ({
      id: r.doc.id,
      title: r.doc.title,
      status: r.doc.status,
      fallback: r.fallback,
      rules: r.status ? r.status.counts : null,
      criteria: criteriaWithDoc(r).filter((x) => !r.merged.some((m) => m.doc.id === x.doc)).map(({ doc, c }) => ({ doc, id: c.id, text: c.text, state: c.state })),
      merged: { ids: r.merged.map((m) => m.doc.id), criteria: counted(r.merged.flatMap((m) => m.criteria)) },
    })),
    quality: { standards: o.quality.standards, drafts: o.quality.drafts, uncovered: o.quality.uncovered, none: o.quality.none, ...(o.verdicts && typeof o.verdicts !== "string" ? { verdicts: o.verdicts } : {}) },
    agenda: typeof o.agenda === "object" ? agendaJson(o.agenda) : { error: o.agenda ?? null },
    changes: o.changes.map((s) => ({ id: s.id, title: s.change.title, state: s.state, mark: stateMark(s) })),
    changes_more: o.changesMore,
    current_batch: o.batch.map((s) => ({ id: s.id, title: s.change.title })),
    goal_changes: goalCounts(o.goalCommits),
    landed: o.landed.map((l) => ({ id: l.id, title: l.title ?? null, at: l.at })),
  };
}

/** The `--history --json` form (BR-2505). */
export function historyJson(o: Overview): Record<string, unknown> {
  return {
    goal_commits: o.goalCommits.map((g) => ({ sha: g.sha, subject: g.subject, changes: g.changes })),
    landed: o.landed.map((l) => ({ id: l.id, title: l.title ?? null, at: l.at, advances: l.advances === undefined ? null : l.advances.kind === "none" ? { none: l.advances.reason } : l.advances.refs })),
  };
}

/** The brief's progress summary, where no change is claimed (BR-2506): the releases in progress, recent goal changes, quality. */
export function briefSummary(o: Overview): string[] {
  const quality = briefQualityLine(o.quality);
  // reason: with nothing to say the brief stays the bare guide (BR-2024, BR-2506)
  if (o.releases.length === 0 && o.goalCommits.length === 0 && quality === undefined) return [];
  const out = ["Overall progress (canon overview):"];
  for (const r of o.releases) out.push(`  ${headLine(r.doc)}  ${criteriaCountLine(allCriteria(r))}${r.fallback ? "  (no release is active: the lowest planned one)" : ""}`);
  if (o.releases.length === 0) out.push("  no release in progress");
  if (o.goalCommits.length > 0) out.push(`  goal changed in the last ${GOAL_DAYS} days: ${o.goalCommits.map((g) => g.sha.slice(0, 9)).join(", ")} (canon overview --history)`);
  // reason: only a reminder, short because every session reads it (BR-2506, BR-2558, D-139)
  if (quality !== undefined) out.push(`  ${quality}`);
  return out;
}
