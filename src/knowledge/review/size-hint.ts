import type { Corpus, Doc } from "../documents/model.ts";
import { changedBytes, pieceRemedy, refusalRemedy, reviewSizes, type ReviewExtras } from "./review.ts";

/** The share of `review_max_prompt_kb` from which a top domain is warned about (BR-2375): 70% leaves 75 KB at the default 250 KB, which covers the 56 KB change of #145. */
export const WARN_SHARE = 0.7;

const kb = (n: number): number => Math.ceil(n / 1024);

/** The documents this work changes, as the landing's review counts them; absent on main and when the work changes none (they count 0). */
export interface WorkChanges {
  readonly changed: readonly Doc[];
  readonly extras: ReviewExtras;
}

/**
 * One hint line for each top domain whose smallest review piece plus the fixed part and the changed documents reaches 70% of
 * the budget; a hint, never a finding (BR-2375, D-76). The sizes are the ones the refusal names. Without `work` the changed
 * documents count 0 and the line says so; with it they are this work's real ones, and a total over the budget says the
 * landing's review will be refused.
 */
export function reviewSizeHints(root: string, corpus: Corpus, budgetBytes: number, work?: WorkChanges): string[] {
  const { fixed, pieces } = reviewSizes(root, corpus);
  const docs = work ? changedBytes(corpus, work.changed, work.extras) : 0;
  const docsText = work ? `changed documents ${kb(docs)} KB (this work's, counted as the landing's review counts them)` : "changed documents 0 KB (not known without a change)";
  const out: string[] = [];
  for (const p of pieces) {
    const total = docs + fixed + p.piece;
    if (total < budgetBytes * WARN_SHARE) continue;
    const pct = Math.round((total / budgetBytes) * 100);
    const sizes = `${docsText}, review instructions + rule index + accepted decision titles ${kb(fixed)} KB, domain text ${kb(p.piece)} KB; ${kb(total)} KB together is ${pct}% of review_max_prompt_kb = ${kb(budgetBytes)} KB`;
    // reason: with the real changed documents counted, over 100% is not a warning but the refusal the landing will give (BR-2375, BR-2359)
    const tail = work && total > budgetBytes
      ? `the landing's review of this work will be refused: ${refusalRemedy(root, corpus, { docs, index: fixed, piece: p.piece, where: p.where, need: total, budget: budgetBytes })}`
      : `a change to ${p.top} is refused above 100%${work ? "" : " (the changed documents are not counted)"}: ${pieceRemedy(root, corpus, total, p.piece, p.where)}`;
    out.push(`hint review-size: ${p.top}: ${sizes}, ${tail}`);
  }
  return out;
}
