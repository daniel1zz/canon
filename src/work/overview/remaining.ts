import { changeStates, isClosed, stateMark } from "../../knowledge/changes/state.ts";
import { git } from "../../kernel/git.ts";
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
  /** BR-2629: items of the `## 决定` sections that name no rule and no change; of decisions added in the last ITEM_DAYS days unless `all`. */
  readonly items: readonly { readonly id: string; readonly item: string }[];
  /** Whether `items` covers every accepted decision (`--all`) or the recent ones. */
  readonly allItems: boolean;
}

/** How recent a decision must be for its items to be listed without --all (BR-2629). */
export const ITEM_DAYS = 30;
/** The most items the text shows; --json has them all (BR-2629). */
export const ITEMS_SHOWN = 30;

/** The top-level items of a `## 决定` section: each list item with its continuation lines, or each paragraph. */
export function decisionItems(body: string): string[] {
  const m = /^## 决定[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  if (!m) return [];
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { const t = cur.join("\n").trim(); if (t !== "") out.push(t); cur = []; };
  let blank = false;
  for (const line of m[1]!.split("\n")) {
    if (line.trim() === "") { blank = true; continue; }
    // reason: a list item starts an item; after a blank line, only an indented line continues the one before
    if (/^(?:[-*]|\d+[.)])\s/.test(line) || (blank && !/^\s/.test(line))) flush();
    cur.push(line);
    blank = false;
  }
  flush();
  return out;
}

/** Whether an item names a rule or a change (BR-2629). */
const namesWork = (item: string): boolean => /(^|[^A-Za-z0-9-])(BR|C)-\d+(?![0-9])/.test(item);

/** The date each decision file was added on `main`, by path (one git call). */
function addedOn(root: string, main: string): Map<string, number> {
  const out = new Map<string, number>();
  const log = git(root, "log", main, "--no-renames", "--diff-filter=A", "--format=@%cI", "--name-only", "--", "canon/decisions");
  if (!log.ok) return out;
  let at = 0;
  for (const line of log.value.split("\n")) {
    if (line.startsWith("@")) at = Date.parse(line.slice(1));
    else if (line.trim() !== "" && !out.has(line.trim())) out.set(line.trim(), at);
  }
  return out;
}

/** BR-2629: the 决定 items of accepted decisions that name no rule and no change; recent decisions only unless `all`. */
export function unmappedItems(corpus: Corpus, root: string, main: string, all: boolean, now = Date.now()): { id: string; item: string }[] {
  const since = now - ITEM_DAYS * 86_400_000;
  const added = all ? undefined : addedOn(root, main);
  return corpus.docs
    .filter((d): d is Decision => d.kind === "decision" && d.status === "accepted")
    // reason: a decision main has no add date for is not on main yet, so it is not old: it is listed (BR-2629)
    .filter((d) => added === undefined || (added.get(d.path) ?? now) >= since)
    .sort((a, b) => number(a.id) - number(b.id))
    .flatMap((d) => decisionItems(d.body).filter((it) => !namesWork(it)).map((item) => ({ id: d.id, item })));
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

export function remaining(ws: Workspace, all = false): Result<Remaining> {
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
    items: unmappedItems(corpus, ws.root, ws.config.main, all),
    allItems: all,
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
  const shown = r.items.slice(0, ITEMS_SHOWN).map((i) => `${i.id}：${clip(i.item, 120)}`);
  if (r.items.length > ITEMS_SHOWN) shown.push(`… 还有 ${r.items.length - ITEMS_SHOWN} 条（canon work remaining --json${r.allItems ? " --all" : ""}）`);
  section(`决定里没写到规则或变更的条目（${r.allItems ? "全部已接受的决定" : `最近 ${ITEM_DAYS} 天加入的已接受决定，--all 看全部`}）`, r.items.length, shown);
  out.push("", "项目的 issue 不在 canon 里：用项目自己的 issue 工具查。");
  return out;
}
