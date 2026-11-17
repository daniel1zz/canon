import { ok, type Result } from "../../kernel/result.ts";
import { backlogAt } from "../../knowledge/documents/backlog.ts";
import type { Corpus, Release } from "../../knowledge/documents/model.ts";
import { planStatuses, summaryLine as planLine, type PlanStatus } from "../../knowledge/plans/status.ts";
import { CRITERION_LABEL, criteriaCountLine, criteriaOf, type Criterion } from "../../knowledge/releases/criteria.ts";
import { releaseStatuses, summaryLine as releaseLine, type ReleaseStatus } from "../../knowledge/releases/status.ts";
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
}

export interface CurrentRelease {
  readonly doc: Release;
  /** No release is active: the lowest-numbered planned one stands in (BR-2505). */
  readonly fallback: boolean;
  /** Its rule counts; left out of the brief, which cannot afford computing every rule's execution state (BR-2506). */
  readonly status: ReleaseStatus | undefined;
  readonly criteria: readonly Criterion[];
}

export interface Overview {
  readonly release: CurrentRelease | undefined;
  readonly plans: readonly PlanStatus[];
  readonly waiting: { readonly questions: readonly Question[]; readonly findings: readonly OpenFinding[]; readonly criteria: readonly Criterion[] };
  readonly backlog: readonly ListedChange[];
  readonly backlogMore: number;
  readonly landed: readonly Landed[];
}

const number = (id: string) => Number(id.split("-")[1]);

/** The current release (BR-2505): the lowest-numbered active one, else the lowest-numbered planned one. */
export function currentRelease(corpus: Corpus): { doc: Release; fallback: boolean } | undefined {
  const lowest = (status: string) => corpus.docs.filter((d): d is Release => d.kind === "release" && d.status === status).sort((a, b) => number(a.id) - number(b.id))[0];
  const active = lowest("active");
  if (active) return { doc: active, fallback: false };
  const planned = lowest("planned");
  return planned ? { doc: planned, fallback: true } : undefined;
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
  const current = currentRelease(corpus.value);
  const criteria = current ? criteriaOf(current.doc.body, ws.config.types) : [];
  const status = current && opts.ruleCounts ? releaseStatuses(corpus.value, executionStates(ws.root, corpus.value, ws.config.floorTiming)).find((s) => s.release.id === current.doc.id) : undefined;
  const open = every.value.listed.filter((l) => l.change.status === "open" || (l.onBranch.length > 0 && l.change.status === "done"));
  return ok({
    release: current ? { ...current, status, criteria } : undefined,
    plans: planStatuses(corpus.value, every.value.listed.map((l) => ({ change: l.change, onMain: l.onBranch.length === 0 }))),
    waiting: {
      questions: questions(ws.db, "pending"),
      findings: openFindings(ws.db).filter((f) => f.tier === "C"),
      criteria: criteria.filter((c) => c.state === "owner"),
    },
    backlog: open.slice(0, BACKLOG_SHOWN),
    backlogMore: Math.max(0, open.length - BACKLOG_SHOWN),
    landed: landed(ws, corpus.value),
  });
}

/** The latest landings of changes, newest first, chores left out (BR-2505). */
function landed(ws: Workspace, corpus: Corpus): Landed[] {
  const rows = ws.db.db.query<{ ts: string; subject: string | null }, []>("SELECT ts, subject FROM events WHERE kind = 'land.ok' ORDER BY id DESC").all();
  const out: Landed[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (out.length >= LANDED_SHOWN) break;
    if (!r.subject || isChore(r.subject) || seen.has(r.subject)) continue;
    seen.add(r.subject);
    out.push({ id: r.subject, title: corpus.docs.find((d) => d.id === r.subject)?.title, at: r.ts });
  }
  return out;
}

/** A release without its rule counts: id, status, title, as `canon release status` starts its line (BR-2506). */
const headLine = (r: Release) => `${r.id}  ${r.status}  ${r.title}`;
const FALLBACK = "(没有 active 的版本，取编号最小的 planned；正在做的版本把 status 改成 active)";

const firstLine = (s: string) => s.split("\n")[0]!.trim();
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const questionLine = (q: Question) => `问题 #${q.id} ${firstLine(q.question)}`;
const findingLine = (f: OpenFinding) => `意见 #${f.id} ${f.ids.length > 0 ? f.ids.join(", ") : "-"}: ${firstLine(f.text)}`;

/** The five sections of `canon overview` (BR-2505). */
export function overviewLines(o: Overview): string[] {
  const out: string[] = ["## 当前版本"];
  if (!o.release) out.push("(no release in progress)");
  else {
    out.push(o.release.status ? releaseLine(o.release.status) : headLine(o.release.doc));
    if (o.release.fallback) out.push(FALLBACK);
    out.push(criteriaCountLine(o.release.criteria));
    for (const c of o.release.criteria) out.push(`  [${CRITERION_LABEL[c.state]}] ${c.text}${c.evidence.length > 0 ? `  证据：${c.evidence.join(", ")}` : ""}`);
  }
  out.push("", "## 计划", ...(o.plans.length > 0 ? o.plans.map(planLine) : ["(no plans)"]));
  const releaseId = o.release?.doc.id;
  const waiting = [...o.waiting.questions.map(questionLine), ...o.waiting.findings.map(findingLine), ...o.waiting.criteria.map((c) => `成功标准 ${releaseId}: ${c.text}`)];
  out.push("", "## 等负责人", ...(waiting.length > 0 ? waiting : ["(nothing)"]));
  out.push("", "## 待办顺序");
  if (o.backlog.length === 0) out.push("(none)");
  for (const l of o.backlog) {
    const marks = marksOf(l, false);
    out.push(`${l.change.id} ${l.change.title}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`);
  }
  if (o.backlogMore > 0) out.push(`… 还有 ${o.backlogMore} 个（canon change list）`);
  out.push("", "## 最近合入", ...(o.landed.length > 0 ? o.landed.map((l) => `${l.id}${l.title ? ` ${l.title}` : ""} ${minute(l.at)}`) : ["(none)"]));
  return out;
}

/** The `--json` form (BR-2505). */
export function overviewJson(o: Overview): Record<string, unknown> {
  return {
    release: o.release
      ? { id: o.release.doc.id, title: o.release.doc.title, status: o.release.doc.status, ...(o.release.status ? { counts: o.release.status.counts } : {}), criteria: o.release.criteria.map((c) => ({ text: c.text, state: c.state, evidence: c.evidence })) }
      : null,
    plans: o.plans.map((p) => ({ id: p.change.id, title: p.change.title, total: p.steps.length, done: p.counts.done, percent: p.percent })),
    waiting: {
      questions: o.waiting.questions.map((q) => ({ id: q.id, question: q.question })),
      findings: o.waiting.findings.map((f) => ({ id: f.id, ids: f.ids, text: f.text })),
      criteria: o.waiting.criteria.map((c) => ({ release: o.release?.doc.id, text: c.text })),
    },
    backlog: o.backlog.map((l) => ({ id: l.change.id, title: l.change.title, marks: marksOf(l, false) })),
    backlog_more: o.backlogMore,
    landed: o.landed.map((l) => ({ id: l.id, title: l.title ?? null, at: l.at })),
  };
}

/** The brief's summary of the first three sections, where no change is claimed (BR-2506). */
export function briefSummary(o: Overview): string[] {
  const notDone = o.plans.filter((p) => p.counts.done < p.steps.length);
  const { questions: q, findings: f, criteria: c } = o.waiting;
  // reason: with nothing to say the brief stays the bare guide (BR-2024, BR-2506)
  if (!o.release && notDone.length === 0 && q.length + f.length + c.length === 0) return [];
  const out = ["Overall progress (canon overview):"];
  if (o.release) out.push(`  ${headLine(o.release.doc)}${o.release.fallback ? "  (no release is active: the lowest planned one)" : ""}`, `  ${criteriaCountLine(o.release.criteria)}`);
  else out.push("  no release in progress");
  if (notDone.length > 0) out.push(`  plans not done: ${notDone.map((p) => `${p.change.id} ${p.counts.done}/${p.steps.length} (${p.percent}%)`).join(", ")}`);
  if (q.length + f.length + c.length > 0) out.push(`  waiting for the owner: ${q.length} question(s), ${f.length} tier-C finding(s), ${c.length} criterion(s)`);
  return out;
}
