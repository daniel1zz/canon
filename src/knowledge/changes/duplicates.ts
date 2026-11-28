import { git } from "../../kernel/git.ts";
import type { Workspace } from "../../work/workspace.ts";
import type { Change, Corpus } from "../documents/model.ts";
import { tokens } from "../query/bigrams.ts";
import { changeStates, hasFile, isClosed, type ChangeState } from "./state.ts";
import { latestAnswers, pairKey, reminders } from "./duplicate-events.ts";

/**
 * The duplicate reminder (D-148 step D, D-171): when a change is created its title is compared with the unfinished
 * changes' titles (BR-2656); when it lands, what it changed with what they wrote down (BR-2657). Both only remind
 * (D-139). Each reminded pair is a `duplicate.remind` event; the session's answer is a `duplicate.answer` (BR-2658).
 */

/** At or above this relatedness, rounded to two decimals, a title is listed (BR-2656, D-171). */
export const TITLE_THRESHOLD = 0.4;
/** At most this many related titles are listed (BR-2656). */
export const TITLE_LIMIT = 3;
/** At most this many shared paths are written in one landing reminder (BR-2657). */
const PATHS_SHOWN = 5;

const LONE_HAN = /^\p{Script=Han}$/u;

/** A title's distinct words for relatedness: D-90's tokens without lone Han characters (D-171: 的, 步 carry no topic). */
export function titleTokens(title: string): Set<string> {
  return new Set(tokens(title).filter((t) => !LONE_HAN.test(t)));
}

export interface TitleMatch {
  readonly id: string;
  readonly title: string;
  /** Rounded to two decimals. */
  readonly score: number;
  /** The shared words, heaviest first. */
  readonly shared: readonly string[];
}

/**
 * The candidates whose titles are related to `title` (BR-2656): weighted Dice over `titleTokens`, each word weighted by
 * its idf over `all` (every change title), kept at or above the threshold, highest first (ties by id), at most 3.
 */
export function relatedTitles(title: string, candidates: readonly { id: string; title: string }[], all: readonly string[]): TitleMatch[] {
  const df = new Map<string, number>();
  for (const t of all) for (const w of titleTokens(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = all.length;
  const weight = (w: string) => { const d = df.get(w) ?? 0; return Math.log(1 + (n - d + 0.5) / (d + 0.5)); };
  const mine = titleTokens(title);
  const mineWeight = [...mine].reduce((s, w) => s + weight(w), 0);
  const out: TitleMatch[] = [];
  for (const c of candidates) {
    const theirs = titleTokens(c.title);
    const total = mineWeight + [...theirs].reduce((s, w) => s + weight(w), 0);
    if (total === 0) continue;
    const shared = [...mine].filter((w) => theirs.has(w)).sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
    const score = Math.round(((2 * shared.reduce((s, w) => s + weight(w), 0)) / total) * 100) / 100;
    if (score >= TITLE_THRESHOLD) out.push({ id: c.id, title: c.title, score, shared });
  }
  const num = (id: string) => Number(id.replace(/^\D+-/, ""));
  return out.sort((a, b) => b.score - a.score || num(a.id) - num(b.id)).slice(0, TITLE_LIMIT);
}

/** What one change wrote down for the landing comparison (BR-2657). */
export interface Written {
  readonly rules: readonly string[];
  /** Text in backticks in its body that contains a `/` and no whitespace. */
  readonly paths: readonly string[];
  readonly feature?: string;
}

export function writtenBy(c: Change): Written {
  const paths = [...new Set([...c.body.matchAll(/`([^`\s]*\/[^`\s]*)`/g)].map((m) => m[1]!.replace(/^\.\//, "")))];
  return { rules: c.rules, paths, ...(c.feature !== undefined ? { feature: c.feature } : {}) };
}

/** A changed path matches a written one when equal, under it as a directory, or under it plus `/` (BR-2657). */
export function pathMatches(changed: string, written: string): boolean {
  if (changed === written) return true;
  if (written.endsWith("/")) return changed.startsWith(written);
  return changed.startsWith(`${written}/`);
}

export interface LandMatch {
  readonly id: string;
  readonly title: string;
  readonly rules: readonly string[];
  readonly paths: readonly string[];
  /** The feature both wrote; shown, never a reason to remind on its own. */
  readonly feature?: string;
}

/** The unfinished changes whose written rules or paths the landing change touches (BR-2657). */
export function landMatches(own: { rules: readonly string[]; paths: readonly string[]; feature?: string }, others: readonly Change[]): LandMatch[] {
  const out: LandMatch[] = [];
  for (const c of others) {
    const w = writtenBy(c);
    const rules = [...new Set(own.rules)].filter((r) => w.rules.includes(r)).sort();
    const paths = own.paths.filter((p) => w.paths.some((x) => pathMatches(p, x))).sort();
    if (rules.length === 0 && paths.length === 0) continue;
    const feature = own.feature !== undefined && own.feature === w.feature ? own.feature : undefined;
    out.push({ id: c.id, title: c.title, rules, paths, ...(feature !== undefined ? { feature } : {}) });
  }
  return out;
}

/** The unfinished changes with a file, except `self`, and every change title for the weights. */
function unfinished(states: readonly ChangeState[], self: string): { open: Change[]; titles: string[] } {
  const filed = states.filter(hasFile);
  return { open: filed.filter((s) => !isClosed(s) && s.id !== self).map((s) => s.change), titles: filed.map((s) => s.change.title) };
}

const answerHint = (change: string, other: string) => `canon change duplicate ${change} ${other}`;

/**
 * Prints and records the title reminder for a change just created (BR-2656). `corpus` is the checkout the change was
 * created in when it is not on a branch yet. Never fails the creation: a comparison that cannot run is said.
 */
export function remindNew(ws: Workspace, change: string, title: string, say: (line: string) => void, corpus?: Corpus): void {
  const states = changeStates(ws, { delegatable: false, ...(corpus ? { corpus } : {}) });
  if (!states.ok) {
    say(`duplicate: cannot compare: ${states.error.message}`);
    return;
  }
  const { open, titles } = unfinished(states.value.states, change);
  const all = titles.includes(title) ? titles : [...titles, title];
  const found = relatedTitles(title, open, all);
  if (found.length === 0) return;
  for (const m of found) say(`possible duplicate: ${m.id} ${m.title} (relatedness ${m.score.toFixed(2)}; shared: ${m.shared.join(", ")})`);
  const first = found[0]!.id;
  say(`if one of them is the same work: ${answerHint(change, first)} --same; if not: ${answerHint(change, first)} --not "<why>"`);
  ws.db.db.transaction(() => {
    for (const m of found) ws.db.event(ws.actor, "duplicate.remind", change, { stage: "new", with: m.id, score: m.score, shared: m.shared });
  }).immediate();
}

/**
 * Prints the landing reminder (BR-2657) for `change` landing from `worktree`, and records each pair's first one at
 * this stage. Never refuses: a comparison that cannot run is said and the landing goes on.
 */
export function remindLand(ws: Workspace, worktree: string, change: string, own: Change | undefined, say: (line: string) => void): void {
  const names = git(worktree, "diff", "--name-only", `${ws.config.main}...HEAD`);
  if (!names.ok) {
    say(`duplicate: cannot compare: ${names.error.message}`);
    return;
  }
  const states = changeStates(ws, { delegatable: false });
  if (!states.ok) {
    say(`duplicate: cannot compare: ${states.error.message}`);
    return;
  }
  const rulePrefix = ws.config.types.find((t) => t.name === "rule")!.prefix; // reason: rule is a built-in type, never removed
  const ruleFile = new RegExp(`^canon/rules/.*/(${rulePrefix}-\\d+)\\.md$`);
  const changed = names.value.split("\n").filter(Boolean);
  const ownFile = own?.path;
  const paths = changed.filter((p) => p !== ownFile && !new RegExp(`^canon/changes/${change}(-[^/]*)?\\.md$`).test(p));
  const rules = [...(own?.rules ?? []), ...changed.flatMap((p) => { const m = ruleFile.exec(p); return m ? [m[1]!] : []; })];
  const { open } = unfinished(states.value.states, change);
  const answered = latestAnswers(ws);
  const found = landMatches({ rules, paths, ...(own?.feature !== undefined ? { feature: own.feature } : {}) }, open).filter((m) => !answered.has(pairKey(change, m.id)));
  if (found.length === 0) return;
  const before = new Set(reminders(ws).filter((r) => r.stage === "land").map((r) => pairKey(r.subject, r.with)));
  for (const m of found) {
    const parts = [
      ...(m.rules.length > 0 ? [`shared rules: ${m.rules.join(", ")}`] : []),
      ...(m.paths.length > 0 ? [`shared paths: ${m.paths.slice(0, PATHS_SHOWN).join(", ")}${m.paths.length > PATHS_SHOWN ? ", …" : ""}`] : []),
      ...(m.feature !== undefined ? [`same feature ${m.feature}`] : []),
    ];
    say(`possible duplicate: ${m.id} ${m.title} (${parts.join("; ")})`);
    say(`is ${m.id} the same work? ${answerHint(change, m.id)} --same, or --not "<why>"`);
    // reason: a landing retried after a refusal says it again but counts once, so precision is not inflated (BR-2657, D-171)
    if (!before.has(pairKey(change, m.id))) ws.db.event(ws.actor, "duplicate.remind", change, { stage: "land", with: m.id, rules: m.rules, paths: m.paths, feature: m.feature ?? null });
  }
}

