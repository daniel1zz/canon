import type { Say, Workspace } from "../../workspace.ts";
import type { Corpus } from "../../../knowledge/documents/model.ts";
import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";

/**
 * BR-2355: decisions this landing adds (new files against `base`) that are still `proposed` are said and recorded,
 * never refused: subagents land decisions proposed by design (canon-parallel).
 */
export function noticeProposedDecisions(ws: Workspace, say: Say, t: { wt: string; base: string; head: string; subject: string | null; corpus: Corpus }): Result<string[]> {
  const added = git(t.wt, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=A", t.base, t.head, "--", "canon/decisions");
  if (!added.ok) return err("git", added.error.message);
  const paths = new Set(added.value === "" ? [] : added.value.split("\n"));
  const proposed = t.corpus.docs.filter((d) => d.kind === "decision" && d.status === "proposed" && paths.has(d.path));
  for (const d of proposed) say(`proposed decision: ${d.id} ${d.title} lands still proposed; accept it with \`canon decision accept ${d.id}\` in a change (after its challenge), or say in the change file why it stays proposed`);
  if (proposed.length > 0) ws.db.event(ws.actor, "land.proposed", t.subject, { decisions: proposed.map((d) => d.id) });
  return ok(proposed.map((d) => d.id));
}
