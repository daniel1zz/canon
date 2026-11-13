import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const sessionGuide: readonly GuideLine[] = [
  { rank: 20, text: `Business work uses a Change: canon work start <C-n>, or --title "<what>" for a new one; fill its 为什么 and 要改什么 before code. Non-business work uses canon chore start "<title>" (resume with its chore identity), without a Change document or C number; use the printed worktree. The session chooses the channel; canon does not classify changed paths. With no task given, take the first change in canon change list not marked claimed or ambiguous (it shows changes still only on their branch too): first the owner's order in canon/backlog.md, which only the owner edits, then started work; a new change goes after the backlog by itself. Enter a change's worktree only by the path canon work start printed, never one you guess (ls | tail). A subagent adds --as <its agent id> to canon work start, land, stop and drop, and to canon chore start and land; the main session never does.` },
];
