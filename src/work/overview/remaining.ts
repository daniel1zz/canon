import { changeStates, isClosed, stateMark } from "../../knowledge/changes/state.ts";
import type { Corpus, Decision } from "../../knowledge/documents/model.ts";
import { openFindings } from "../../knowledge/review/findings/findings.ts";
import { ok, type Result } from "../../kernel/result.ts";
import { executionStates, STATE_LABEL } from "../execution/state.ts";
import { questions } from "../humans/questions.ts";
import { mainCorpus } from "../session/session.ts";
import type { Workspace } from "../workspace.ts";

/**
 * `canon work remaining` (BR-2629, #298): every unfinished item canon knows, by source, in one place, so a report of
 * what is left does not depend on which commands a session remembers to combine. Read from main and the coordination
 * database each time; nothing is stored.
 */
export interface Remaining {
  readonly changes: readonly { readonly id: string; readonly title: string; readonly state: string }[];
  readonly rules: { readonly planned: readonly string[]; readonly waiting: readonly string[]; readonly rerun: readonly string[] };
  readonly findings: readonly { readonly id: number; readonly tier: string | null; readonly criterion: string; readonly ids: readonly string[]; readonly text: string }[];
  readonly questions: readonly { readonly id: number; readonly subject: string | null; readonly question: string }[];
  readonly decisions: readonly { readonly id: string; readonly title: string }[];
}

const number = (id: string): number => Number(id.split("-")[1]);
/** Whether `text` names `id` as a whole id (D-1 is not D-12). */
const names = (text: string, id: string): boolean => new RegExp(`(^|[^A-Za-z0-9-])${id}(?![0-9])`).test(text);

/** BR-2629: the accepted decisions no rule (not retired) and no change names, in its text or its confirmed references. */
export function unreferencedDecisions(corpus: Corpus): Decision[] {
  const citing = corpus.docs.filter((d) => (d.kind === "rule" && d.status !== "retired") || d.kind === "change");
  return corpus.docs
    .filter((d): d is Decision => d.kind === "decision" && d.status === "accepted")
    .filter((d) => !citing.some((c) => names(c.body, d.id) || names(c.title, d.id) || Object.hasOwn(("links" in c && c.links) || {}, d.id)))
    .sort((a, b) => number(a.id) - number(b.id));
}

export function remaining(ws: Workspace): Result<Remaining> {
  const main = mainCorpus(ws);
  if (!main.ok) return main;
  const corpus = main.value;
  const states = changeStates(ws, { corpus, delegatable: false });
  if (!states.ok) return states;
  const exec = executionStates(ws.root, corpus, ws.config.floorTiming);
  const by = (k: "planned" | "waiting" | "rerun") => [...exec].filter(([, s]) => s.kind === k).map(([id]) => id).sort((a, b) => number(a) - number(b));
  return ok({
    changes: states.value.states.filter((s) => !isClosed(s)).map((s) => ({ id: s.id, title: s.change?.title ?? "", state: stateMark(s) })),
    rules: { planned: by("planned"), waiting: by("waiting"), rerun: by("rerun") },
    findings: openFindings(ws.db).map((f) => ({ id: f.id, tier: f.tier, criterion: f.criterion, ids: f.ids, text: f.text })),
    questions: questions(ws.db, "pending").map((q) => ({ id: q.id, subject: q.subject, question: q.question })),
    decisions: unreferencedDecisions(corpus).map((d) => ({ id: d.id, title: d.title })),
  });
}

const clip = (s: string, n = 100): string => { const one = s.replace(/\s+/g, " ").trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };

/** The text `canon work remaining` prints: one section per source, a count in each heading, `(none)` when empty. */
export function remainingLines(r: Remaining): string[] {
  const out: string[] = [];
  const section = (title: string, n: number, lines: readonly string[]) => { out.push(`${out.length > 0 ? "\n" : ""}## ${title}（${n}）`); out.push(...(lines.length > 0 ? lines : ["(none)"])); };
  section("没关闭的变更", r.changes.length, r.changes.map((c) => `${c.id} ${c.title}  ${c.state}`));
  const ruleCount = r.rules.planned.length + r.rules.waiting.length + r.rules.rerun.length;
  section("没通过的规则（全部，不只当前版本）", ruleCount, ([["planned", r.rules.planned], ["waiting", r.rules.waiting], ["rerun", r.rules.rerun]] as const).filter(([, ids]) => ids.length > 0).map(([k, ids]) => `${STATE_LABEL[k]} ${ids.length}：${ids.join(", ")}`));
  section("没关的评审意见", r.findings.length, r.findings.map((f) => `#${f.id} [${f.tier ?? "untriaged"}] [${f.criterion}] ${f.ids.join(", ") || "-"}: ${clip(f.text)}`));
  section("待回答的问题", r.questions.length, r.questions.map((q) => `#${q.id} [${q.subject ?? "-"}] ${clip(q.question)}`));
  section("没有规则或变更引用的已接受决定", r.decisions.length, r.decisions.map((d) => `${d.id} ${d.title}`));
  out.push("", "项目的 issue 不在 canon 里：用项目自己的 issue 工具查。");
  return out;
}
