import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../../work/db.ts";
import { isChore } from "../../work/session/subject.ts";
import { parseDocFile } from "../documents/docfile.ts";
import type { Corpus } from "../documents/model.ts";
import { ownerAnswered } from "../releases/goal-landing.ts";

/**
 * `active` says the owner confirmed a quality standard (D-145), so a landing that makes one active names a question the
 * owner answered for this change, as leaving 待负责人 does (BR-2560, BR-2510). Nothing else about a standard is refused.
 */

/** Each quality standard's status at `ref`, by id; a file that does not parse is left out, as canon check reports it. */
function statusesAt(cwd: string, ref: string, dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const files = git(cwd, "-c", "core.quotePath=false", "ls-tree", "--name-only", ref, `${dir}/`);
  for (const path of files.ok && files.value !== "" ? files.value.split("\n") : []) {
    if (!/\/Q-\d+[^/]*\.md$/.test(path)) continue;
    const text = git(cwd, "show", `${ref}:${path}`);
    const parsed = text.ok ? parseDocFile(text.value, path) : undefined;
    if (!parsed?.ok) continue;
    // reason: a standard without `status` is a draft (BR-2552)
    out.set(String(parsed.value.meta["id"]), String(parsed.value.meta["status"] ?? "draft"));
  }
  return out;
}

/** The standards active at `head` that were draft, retired or absent at `base`, by number (BR-2560). */
export function newlyActive(cwd: string, base: string, head: string, corpus: Corpus): string[] {
  const dir = `canon/${corpus.types.find((t) => t.name === "quality")?.dir ?? "quality"}`;
  const changed = git(cwd, "diff", "--name-only", base, head, "--", dir);
  if (!changed.ok || changed.value === "") return [];
  // reason: compared by id, so a standard moved to another file name is the same standard (BR-2560)
  const before = statusesAt(cwd, base, dir);
  const now = statusesAt(cwd, head, dir);
  return [...now].filter(([id, status]) => status === "active" && before.get(id) !== "active").map(([id]) => id).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
}

export function landingConfirmations(i: { readonly db: CoordDb; readonly wt: string; readonly base: string; readonly head: string; readonly corpus: Corpus; readonly subject: string | null }): { ok: true } | { ok: false; message: string } {
  const active = newlyActive(i.wt, i.base, i.head, i.corpus);
  if (active.length === 0) return { ok: true };
  const ids = active.join(", ");
  if (i.subject === null || isChore(i.subject)) return { ok: false, message: `this landing makes ${ids} active, which says the owner confirmed them, and a chore cannot record the owner's answer: land it in a change (BR-2560)` };
  if (ownerAnswered(i.db, i.corpus, i.subject).length > 0) return { ok: true };
  return { ok: false, message: `${i.subject} makes ${ids} active, which says the owner confirmed them, without the owner's answer. Ask the owner (canon human ask --change ${i.subject}), then write the answered question's number in owner_answers; or leave them draft (BR-2560)` };
}
