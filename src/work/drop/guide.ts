import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const dropGuide: readonly GuideLine[] = [
  { rank: 120, text: `Removing a worktree or branch that holds unlanded work: canon work drop <C-n>, never plain git; it archives what would be lost before deleting, so it needs no one's approval.` },
];
