/**
 * How to work in a canon project, printed by `canon brief` at every session start (BR-2090, D-10).
 * It ships with the binary instead of being installed as a file, so it always matches the canon that runs.
 */
export const WORKFLOW_GUIDE = `canon keeps this project's shared memory in canon/: rules (rules/<domain>/BR-n.md, how the product must behave), decisions (D-n, why), changes (C-n, the work). How to work here:
- Before changing code read the area: canon context <path|C-n|domain>; find anything: canon search <word|id>.
- Every piece of work is a change in its own worktree: canon work start <C-n>, or --title "<what>" for a new one. Fill its 为什么 and 要改什么 before the code.
- When behavior changes, change its rule in the same commit (new rule: canon rule new --domain <domain> --title "..."). One rule = one testable behavior, with ## 规则 and ## 例子; tests name the rule they prove: it("BR-n: ...").
- A significant choice with real alternatives becomes a decision (canon decision new --title "..."), rejected options included.
- Finish with canon work land --finish. Landing is the only gate: when refused, fix what it names and land again. Stopping before that: canon work stop --next "<next step>".
- Landing can take minutes while it waits behind other landings: run it with a long timeout or in the background, and read its exit code directly, not through a pipe.
- In a worktree run only the tests for your change; the floor runs the full suite when landing.
- Ask the human only about direction, choices left to them, spending money, irreversible actions on shared things, or credentials. Ask in the conversation, then record their exact words: canon human answer <n> <answer> --relayed "<their words>". Never answer for them.
- Removing a worktree or branch that holds unlanded work: canon work drop <C-n>, never plain git.
- A problem you will not fix now: open an issue, one root cause per issue, with a command that reproduces it.`;
