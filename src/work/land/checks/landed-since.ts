import { git } from "../../../kernel/git.ts";
import type { Corpus, Doc } from "../../../knowledge/documents/model.ts";

/**
 * The live rules (active or planned) and accepted decisions that main added or changed from `from` to `to`, as they are now in `corpus`,
 * without `except` (the landing's own changed documents) (BR-2396, D-81). Undefined when git cannot compare the two
 * commits (for example `from` is gone), so the caller reviews in full.
 */
export function landedSince(wt: string, from: string, to: string, corpus: Corpus, except: ReadonlySet<string>): Doc[] | undefined {
  if (!git(wt, "cat-file", "-e", `${from}^{commit}`).ok) return undefined;
  const diff = git(wt, "-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", from, to, "--", "canon/rules", "canon/decisions");
  if (!diff.ok) return undefined;
  const paths = new Set(
    (diff.value === "" ? [] : diff.value.split("\n"))
      .map((l) => l.split("\t") as [string, string])
      .filter(([status]) => status === "A" || status === "M")
      .map(([, path]) => path),
  );
  const live = (d: Doc) => (d.kind === "rule" && d.status !== "retired") || (d.kind === "decision" && d.status === "accepted");
  return corpus.docs.filter((d) => paths.has(d.path) && live(d) && !except.has(d.path));
}
