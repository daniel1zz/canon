import type { Corpus } from "../documents/model.ts";
import { pieceRemedy, reviewSizes } from "./review.ts";

/** The share of `review_max_prompt_kb` from which a top domain is warned about (BR-2375). */
export const WARN_SHARE = 0.8;

const kb = (n: number): number => Math.ceil(n / 1024);

/**
 * One hint line for each top domain whose smallest review piece plus the fixed part reaches 80% of the budget; a hint, never
 * a finding (BR-2375, D-76). The sizes are the ones the refusal names; the changed documents depend on the change, so they count 0.
 */
export function reviewSizeHints(root: string, corpus: Corpus, budgetBytes: number): string[] {
  const { fixed, pieces } = reviewSizes(root, corpus);
  const out: string[] = [];
  for (const p of pieces) {
    const total = fixed + p.piece;
    if (total < budgetBytes * WARN_SHARE) continue;
    const pct = Math.round((total / budgetBytes) * 100);
    out.push(
      `hint review-size: ${p.top}: changed documents 0 KB (not known without a change), review instructions + rule index + accepted decision titles ${kb(fixed)} KB, domain text ${kb(p.piece)} KB; ${kb(total)} KB together is ${pct}% of review_max_prompt_kb = ${kb(budgetBytes)} KB, and a change to ${p.top} is refused above 100%: ${pieceRemedy(root, corpus, total, p.piece, p.where)}`,
    );
  }
  return out;
}
