import type { GuideLine } from "../../cli/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/cli/guide.ts puts them in rank order. */
export const sessionGuide: readonly GuideLine[] = [
  { rank: 20, text: `Every piece of work is a change in its own worktree: canon work start <C-n>, or --title "<what>" for a new one. Fill its 为什么 and 要改什么 before the code. With no task given, take the first unclaimed change in canon change list: it follows the owner's order in canon/backlog.md, which only the owner edits; a new change goes to the end by itself.` },
];
