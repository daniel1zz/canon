import { fencedLines, type Corpus, type Quality } from "../documents/model.ts";

/**
 * The product's aspects (`canon/quality/README.md`, BR-2556, D-146) and how far quality standards cover them (BR-2557),
 * with the reminder lines the overview and the brief print (BR-2558). Which aspect a standard belongs to is written only
 * on the standard (`aspect`), so the list holds names and the owner's decisions, never ids.
 */

export const ASPECTS_SECTION = "## 方面";

/** The owner's decision on an aspect: it does not apply, or it is deferred, with the owner's words or a question number. */
export interface AspectDecision {
  readonly kind: "not_applicable" | "deferred";
  readonly reason: string;
}

export interface Aspect {
  readonly name: string;
  /** 1-based line in the README. */
  readonly line: number;
  readonly decision?: AspectDecision;
}

export interface AspectList {
  /** Where the list is or would be: `canon/<quality dir>/README.md`. */
  readonly path: string;
  readonly exists: boolean;
  readonly aspects: readonly Aspect[];
  /** What does not fit BR-2556, each with its line when there is one. */
  readonly problems: readonly { readonly line?: number; readonly message: string }[];
}

const DECISION_WORDS: Readonly<Record<string, AspectDecision["kind"]>> = { 不适用: "not_applicable", 推迟: "deferred" };
export const DECISION_LABEL: Readonly<Record<AspectDecision["kind"], string>> = { not_applicable: "不适用", deferred: "推迟" };
/** The owner's words in 「」 or “”, not empty, or a canon human question number (BR-2556). */
const OWNER_EVIDENCE = /「\s*[^」\s][^」]*」|“\s*[^”\s][^”]*”|#\d+/;
/** A list item at the start of the line: an indented one continues the item above (BR-2556). */
const ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Where the aspect list lives for this corpus's types. */
export function aspectsPath(corpus: Corpus): string {
  const dir = corpus.types.find((t) => t.name === "quality")?.dir ?? "quality";
  return `canon/${dir}/README.md`;
}

/** The aspect list as BR-2556 reads it; empty, without problems, when the README does not exist. */
export function aspectList(corpus: Corpus): AspectList {
  const path = aspectsPath(corpus);
  const readme = corpus.qualityReadme;
  if (!readme) return { path, exists: false, aspects: [], problems: [] };
  const lines = readme.text.split("\n");
  const fenced = fencedLines(lines);
  const start = lines.findIndex((l, i) => !fenced[i] && l.trim() === ASPECTS_SECTION);
  if (start < 0) return { path: readme.path, exists: true, aspects: [], problems: [{ message: `has no \`${ASPECTS_SECTION}\` section listing the product's aspects (BR-2556)` }] };
  const aspects: Aspect[] = [];
  const problems: { line?: number; message: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (fenced[i]) continue;
    const raw = lines[i]!;
    if (/^#{1,2}\s/.test(raw)) break;
    const item = ITEM.exec(raw);
    if (!item) continue;
    const line = i + 1;
    const named = /^\*\*([^*]*)\*\*(.*)$/.exec(item[1]!.trim());
    const name = named?.[1]!.trim() ?? "";
    if (!named || name === "") {
      problems.push({ line, message: "an aspect is written `- **<aspect>**`, optionally followed by `：` and text (BR-2556)" });
      continue;
    }
    if (aspects.some((a) => a.name === name)) {
      problems.push({ line, message: `aspect ${name} is listed twice (BR-2556)` });
      continue;
    }
    const text = named[2]!.trim().replace(/^[：:]\s*/, "");
    const d = /^(不适用|推迟)[：:]\s*(.*)$/s.exec(text);
    if (!d) {
      aspects.push({ name, line });
      continue;
    }
    const reason = d[2]!.trim();
    if (!OWNER_EVIDENCE.test(reason)) {
      problems.push({ line, message: `aspect ${name} is marked ${d[1]} without the owner's words (in 「」 or “”) or a canon human question number (#n) (BR-2556)` });
      continue;
    }
    aspects.push({ name, line, decision: { kind: DECISION_WORDS[d[1]!]!, reason } });
  }
  return { path: readme.path, exists: true, aspects, problems };
}

const byNumber = (a: { id: string }, b: { id: string }) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]);

/** Quality standards in force: draft or active (BR-2552), by number. */
export function currentStandards(corpus: Corpus): Quality[] {
  return corpus.docs.filter((d): d is Quality => d.kind === "quality" && d.status !== "retired").sort(byNumber);
}

export type AspectState = "covered" | "not_applicable" | "deferred" | "uncovered";

export interface AspectView {
  readonly aspect: Aspect;
  readonly state: AspectState;
  /** The standards in force that belong to it, by number. */
  readonly standards: readonly Quality[];
}

export interface Coverage {
  readonly list: AspectList;
  readonly views: readonly AspectView[];
  /** Standards in force whose aspect the list does not hold. */
  readonly unlisted: readonly Quality[];
  readonly current: readonly Quality[];
}

/** Each listed aspect's state (BR-2557): the owner's decision first, then whether a standard in force belongs to it. */
export function coverage(corpus: Corpus): Coverage {
  const list = aspectList(corpus);
  const current = currentStandards(corpus);
  const views = list.aspects.map((aspect) => {
    const standards = current.filter((q) => q.aspect === aspect.name);
    const state: AspectState = aspect.decision ? aspect.decision.kind : standards.length > 0 ? "covered" : "uncovered";
    return { aspect, state, standards };
  });
  const names = new Set(list.aspects.map((a) => a.name));
  return { list, views, unlisted: current.filter((q) => !names.has(q.aspect)), current };
}

/** What the reminders say (BR-2558). */
export interface QualitySummary {
  readonly standards: number;
  readonly drafts: number;
  readonly uncovered: readonly string[];
  /** No standard in force, no aspect uncovered and no owner's decision: nothing has been set yet. */
  readonly none: boolean;
}

export function qualitySummary(corpus: Corpus): QualitySummary {
  const c = coverage(corpus);
  const uncovered = c.views.filter((v) => v.state === "uncovered").map((v) => v.aspect.name);
  const decided = c.list.aspects.some((a) => a.decision !== undefined);
  return { standards: c.current.length, drafts: c.current.filter((q) => q.status === "draft").length, uncovered, none: uncovered.length === 0 && c.current.length === 0 && !decided };
}

/** The overview's quality line, printed every time (BR-2558). */
export function overviewQualityLine(s: QualitySummary): string {
  if (s.none) return "质量标准：还没有（canon/quality）。用 canon-product 按产品类型调研同类产品，列出方面、写 Q-n";
  const head = `质量标准 ${s.standards} 条，其中 draft ${s.drafts} 条（负责人未确认）`;
  return s.uncovered.length > 0 ? `${head}；未覆盖的方面：${s.uncovered.join("、")}（canon quality status；用 canon-product 补上）` : `${head}；方面都有着落`;
}

/** How many uncovered aspects the brief names (BR-2558). */
const BRIEF_SHOWN = 5;

/** The brief's quality line, only when there is something to remind of (BR-2558); without its two-space indent. */
export function briefQualityLine(s: QualitySummary): string | undefined {
  if (s.none) return "quality: no quality standards yet (canon/quality): research them with the canon-product skill";
  if (s.uncovered.length === 0) return undefined;
  const more = s.uncovered.length > BRIEF_SHOWN ? `, and ${s.uncovered.length - BRIEF_SHOWN} more` : "";
  return `quality: aspects not covered: ${s.uncovered.slice(0, BRIEF_SHOWN).join(", ")}${more} (canon quality status; canon-product skill)`;
}
