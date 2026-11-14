import type { Say, Workspace } from "../../workspace.ts";
import type { Corpus } from "../../../knowledge/documents/model.ts";
import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";

/**
 * BR-2355: decisions this landing adds (new files against `base`) that are still `proposed` after the close commit accepted
 * the change's own (D-109) are said and recorded, never refused: a chore, a landing without --finish or a batch member.
 */
export function noticeProposedDecisions(ws: Workspace, say: Say, t: { wt: string; base: string; head: string; subject: string | null; corpus: Corpus }): Result<string[]> {
  const added = git(t.wt, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=A", t.base, t.head, "--", "canon/decisions");
  if (!added.ok) return err("io", added.error.message);
  const paths = new Set(added.value === "" ? [] : added.value.split("\n"));
  const proposed = t.corpus.docs.filter((d) => d.kind === "decision" && d.status === "proposed" && paths.has(d.path));
  for (const d of proposed) say(`proposed decision: ${d.id} ${d.title} lands still proposed (only a landing with --finish accepts the decisions its change added, D-109); accept it with \`canon decision accept ${d.id}\` in a change`);
  if (proposed.length > 0) ws.db.event(ws.actor, "land.proposed", t.subject, { decisions: proposed.map((d) => d.id) });
  return ok(proposed.map((d) => d.id));
}
