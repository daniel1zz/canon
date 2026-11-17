import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../../work/db.ts";
import { isChore } from "../../work/session/subject.ts";
import { parseDocFile } from "../documents/docfile.ts";
import type { Change, Corpus } from "../documents/model.ts";
import type { DocType } from "../documents/types.ts";
import { criteriaOf } from "./criteria.ts";

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
  for (const w of was) if (w.owner && is.some((c) => c.text === w.text && !c.owner)) out.push(`${id}: success criterion no longer waits for the owner: ${w.text}`);
  const a = new Set(before?.features ?? []);
  const b = new Set(now?.features ?? []);
  if (a.size !== b.size || [...a].some((f) => !b.has(f))) out.push(`${id}: features [${[...a].join(", ")}] → [${[...b].join(", ")}]`);
  const dropped = (d: GoalDoc | undefined) => d?.status === "dropped";
  if (before !== undefined && now !== undefined && dropped(before) !== dropped(now)) out.push(`${id}: status ${String(before.status ?? "")} → ${String(now.status ?? "")}`);
  if (before === undefined && dropped(now)) out.push(`${id}: added as dropped`);
  if ((before?.mergedInto ?? null) !== (now?.mergedInto ?? null)) out.push(`${id}: merged_into ${String(before?.mergedInto ?? "-")} → ${String(now?.mergedInto ?? "-")}`);
  return out;
}

export function landingGoal(i: { readonly db: CoordDb; readonly wt: string; readonly base: string; readonly head: string; readonly corpus: Corpus; readonly subject: string | null }): { ok: true } | { ok: false; message: string } {
  const dirs = ["release", "feature"].map((n) => i.corpus.types.find((t) => t.name === n)).filter((t) => t !== undefined).map((t) => `canon/${t.dir}`);
  const diff = git(i.wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", i.base, i.head, "--", ...dirs);
  const paths = diff.ok && diff.value !== "" ? diff.value.split("\n") : [];
  const read = (ref: string, path: string) => {
    const text = git(i.wt, "show", `${ref}:${path}`);
    return text.ok ? goalDoc(text.value, path, i.corpus.types) : undefined;
  };
  const changes: string[] = [];
  for (const path of paths) {
    const before = read(i.base, path);
    // reason: a shipped release is frozen by its own checks; comparing it again would ask the owner about a ship (BR-2325, BR-2515)
    if (before?.status === "shipped") continue;
    const now = read(i.head, path);
    if (now?.status === "shipped") continue;
    if (!before && !now) continue;
    changes.push(...goalChanges(before, now));
  }
  if (changes.length === 0) return { ok: true };
  const ask = "ask the owner first (canon human ask), then write the answered question's number in the change's owner_answers (BR-2510)";
  const list = changes.map((c) => `  ${c}`).join("\n");
  if (i.subject === null || isChore(i.subject)) return { ok: false, message: `this landing changes the goal, which only a change confirmed by the owner may do; a chore cannot:\n${list}\nLand it in a change and ${ask}` };
  const change = i.corpus.docs.find((d): d is Change => d.kind === "change" && d.id === i.subject);
  const answered = (change?.ownerAnswers ?? []).filter((n) => i.db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(n)?.answer != null);
  if (answered.length > 0) return { ok: true };
  const named = change?.ownerAnswers?.length ? ` (owner_answers names ${change.ownerAnswers.map((n) => `#${n}`).join(", ")}, none answered)` : "";
  return { ok: false, message: `${i.subject} changes the goal without the owner's answer${named}:\n${list}\n${ask}` };
}
