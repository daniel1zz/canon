import type { GuideLine, GuideTopic } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090) and its topics `canon guide <topic>` prints (BR-2654); src/invocation/guide.ts puts them in order. */
export const sessionGuide: readonly GuideLine[] = [
  { rank: 20, text: `Business work uses a Change: canon work start <C-n>, or for a new one --title "<what>" --owner-gate "<what the owner approves>"|"none: <why>" --advances <R-n/Sk>|"none: <why>"; fill its 为什么 and 要改什么 before code. Non-business work uses canon chore start "<title>". Enter a worktree only by the path canon work start or canon chore start printed, never a guessed one. A subagent adds --as <its agent id> (CODEX_THREAD_ID in Codex) to canon work start, accept-design, land, stop and drop; the main session never does. Change or chore, what to take with no task, delegating: canon guide work.` },
];

export const sessionTopics: readonly GuideTopic[] = [
  { name: "work", when: `choosing between a Change and a chore, picking a change with no task given, delegating to a worker or accepting a redelegated design`, text: `A chore (canon chore start "<title>", resumed with its chore identity) is a light change whose file and C number are written when it lands. The session chooses the channel; canon does not classify changed paths.

With no task given, take the first change in canon change list (branch-only changes included) not marked claimed, ambiguous or waiting: the owner's order in canon/backlog.md (only the owner edits it) first, then started work; a new change goes after the backlog.

For a worker, the design owner creates the Change, publishes its design on main, then runs canon work delegate <C-n> --to <name>. Workers start only their assigned C-n and cannot create changes, fixes or chores. After redelegation the acceptor runs canon work accept-design <C-n>.

Before the main session stops, the Stop hook names what it can do now from canon work due (BR-2655): do it, or stop again to leave it. When the owner asks to pause, canon goal dispatch off; canon goal dispatch on resumes.` },
];
