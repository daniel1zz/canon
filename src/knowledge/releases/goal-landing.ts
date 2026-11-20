import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../../work/db.ts";
import { isChore } from "../../work/session/subject.ts";
import { parseDocFile } from "../documents/docfile.ts";
import type { Change, Corpus } from "../documents/model.ts";
import type { DocType } from "../documents/types.ts";
import { criteriaOf } from "./criteria.ts";
import { lightChangeOf } from "../query/query.ts";

/**
 * The goal is the owner's (BR-2510, D-130): a landing that changes a success criterion, what a release is made of, or
 * drops a release or feature, names a question the owner answered. Shipped releases are not compared: they are frozen.
 */

interface GoalDoc {
  readonly id: string;
  readonly status: unknown;
  readonly features: readonly string[];
  readonly mergedInto: unknown;
  readonly criteria: readonly { text: string; owner: boolean }[];
}

const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();

function goalDoc(text: string, path: string, types: readonly DocType[]): GoalDoc | undefined {
  const parsed = parseDocFile(text, path);
  if (!parsed.ok) return undefined;
  const m = parsed.value.meta;
  return {
    id: String(m["id"]),
    status: m["status"],
    features: Array.isArray(m["features"]) ? (m["features"] as unknown[]).map(String) : [],
    mergedInto: m["merged_into"],
    criteria: criteriaOf(parsed.value.body, types).map((c) => ({ text: squeeze(c.text), owner: c.state === "owner" })),
  };
}

/** What changed in the goal between `before` and `now` of one document, one line each; empty when nothing did. */
export function goalChanges(before: GoalDoc | undefined, now: GoalDoc | undefined): string[] {
  const id = (now ?? before)!.id;
  const out: string[] = [];
  const was = before?.criteria ?? [];
  const is = now?.criteria ?? [];
  for (const c of is) if (!was.some((w) => w.text === c.text)) out.push(`${id}: success criterion added or reworded: ${c.text}`);
  for (const w of was) if (!is.some((c) => c.text === w.text)) out.push(`${id}: success criterion removed or reworded: ${w.text}`);
  // reason: matched by its exact text and state, so rewording it at the same time does not slip past the owner (BR-2510)
  for (const w of was) if (w.owner && !is.some((c) => c.text === w.text && c.owner)) out.push(`${id}: success criterion no longer waits for the owner: ${w.text}`);
  const a = new Set(before?.features ?? []);
  const b = new Set(now?.features ?? []);
  if (a.size !== b.size || [...a].some((f) => !b.has(f))) out.push(`${id}: features [${[...a].join(", ")}] → [${[...b].join(", ")}]`);
  const dropped = (d: GoalDoc | undefined) => d?.status === "dropped";
  if (before !== undefined && now !== undefined && dropped(before) !== dropped(now)) out.push(`${id}: status ${String(before.status ?? "")} → ${String(now.status ?? "")}`);
  if (before === undefined && dropped(now)) out.push(`${id}: added as dropped`);
  if ((before?.mergedInto ?? null) !== (now?.mergedInto ?? null)) out.push(`${id}: merged_into ${String(before?.mergedInto ?? "-")} → ${String(now?.mergedInto ?? "-")}`);
  return out;
}

/** Whether a change line says a criterion left 待负责人: the one goal change that needs the owner's own answer (BR-2510). */
const leftOwner = (line: string) => line.includes("no longer waits for the owner");

/**
 * The landing's goal check (BR-2510): changes to the goal land and are listed in `notices`, a chore's too; what is refused
 * is judged by what changed, not by the channel (D-139, D-148): a criterion leaves 待负责人 only with an answered question
 * asked for this change, which a chore's light change file, written by its landing, cannot name.
 */
export function landingGoal(i: { readonly db: CoordDb; readonly wt: string; readonly base: string; readonly head: string; readonly corpus: Corpus; readonly subject: string | null }): { ok: true; notices: string[] } | { ok: false; message: string } {
  const dirs = ["release", "feature"].map((n) => i.corpus.types.find((t) => t.name === n)).filter((t) => t !== undefined).map((t) => `canon/${t.dir}`);
  const diff = git(i.wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", i.base, i.head, "--", ...dirs);
  const changes = goalChangesBetween(i.wt, i.base, i.head, diff.ok && diff.value !== "" ? diff.value.split("\n") : [], i.corpus.types);
  if (changes.length === 0) return { ok: true, notices: [] };
  const list = changes.map((c) => `  ${c}`).join("\n");
  const light = i.subject !== null && isChore(i.subject);
  // reason: a chore is named by the C number its close commit wrote (BR-2458); without that file, by its identity
  const id = light ? (lightChangeOf(i.corpus, i.subject!)?.id ?? i.subject!) : (i.subject ?? "this landing");
  const owner = changes.filter(leftOwner);
  if (owner.length > 0) {
    const lines = owner.map((c) => `  ${c}`).join("\n");
    if (i.subject === null || light) {
      return { ok: false, message: `${id} marks success criteria the owner was to accept, without the owner's answer:\n${lines}\nA chore's change file is written by its landing and names no owner_answers: do this in a change (canon work start --title "<what>"), ask the owner (canon human ask --change <C-n>), then write the answered question's number in its owner_answers (BR-2510)` };
    }
    if (ownerAnswered(i.db, i.corpus, i.subject).length === 0) {
      return { ok: false, message: `${i.subject} marks success criteria the owner was to accept, without the owner's answer:\n${lines}\nAsk the owner (canon human ask --change ${i.subject}), then write the answered question's number in owner_answers (BR-2510)` };
    }
  }
  const note = light ? [`note: ${id} is a light change (canon chore): no ## 为什么 says why it changes the goal; the owner sees the change in canon overview (BR-2510)`] : [];
  return { ok: true, notices: [`goal: ${id} changes the goal:`, ...changes.map((c) => `  ${c}`), ...note] };
}

/** The questions in the change's `owner_answers` that were asked for this change and answered (BR-2510, BR-2560). */
export function ownerAnswered(db: CoordDb, corpus: Corpus, subject: string): number[] {
  const change = corpus.docs.find((d): d is Change => d.kind === "change" && d.id === subject);
  // reason: the answer must be one asked for this change, or any old answered question would do (BR-2510)
  return (change?.ownerAnswers ?? []).filter((n) => {
    const q = db.db.query<{ answer: string | null; subject: string | null }, [number]>("SELECT answer, subject FROM questions WHERE id = ?").get(n);
    return q?.answer != null && q.subject === subject;
  });
}

/** The goal changes of the release and feature files `paths` between two commits, one line each (BR-2510, BR-2505). */
export function goalChangesBetween(cwd: string, base: string, head: string, paths: readonly string[], types: readonly DocType[]): string[] {
  const read = (ref: string, path: string) => {
    const text = git(cwd, "show", `${ref}:${path}`);
    return text.ok ? goalDoc(text.value, path, types) : undefined;
  };
  const out: string[] = [];
  for (const path of paths) {
    const before = read(base, path);
    // reason: a shipped release is frozen by its own checks (BR-2325, BR-2515)
    if (before?.status === "shipped") continue;
    const now = read(head, path);
    if (now?.status === "shipped" || (!before && !now)) continue;
    out.push(...goalChanges(before, now));
  }
  return out;
}
