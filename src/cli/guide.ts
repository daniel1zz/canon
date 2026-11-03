/**
 * How to work in a canon project, printed by `canon brief` at every session start (BR-2090, D-10).
 * It ships with the binary instead of being installed as a file, so it always matches the canon that runs.
 */
export const WORKFLOW_GUIDE = `canon keeps this project's shared memory in canon/: rules (rules/<domain>/BR-n.md, how the product must behave), decisions (D-n, why), changes (C-n, the work). How to work here:
- Before changing code read the area: canon context <path|C-n|domain> lists its rules by title; read the ones you touch with canon show <id> (--full prints them all). Find anything: canon search <word|id>.
- Every piece of work is a change in its own worktree: canon work start <C-n>, or --title "<what>" for a new one. Fill its 为什么 and 要改什么 before the code. With no task given, take the first unclaimed change in canon change list: it follows the owner's order in canon/backlog.md, which only the owner edits; a new change goes to the end by itself.
- Notes the rule review gives without blocking are not changes: never open a change for them. canon context and canon brief show the notes still open on a rule or decision; handle them when you next change that document. Blocks and real defects are fixed at once.
- When behavior changes, change its rule in the same commit (new rule: canon rule new --domain <domain> --title "..."). One rule = one testable behavior, with ## 规则 and ## 例子; tests name the rule they prove: it("BR-n: ...").
- Pick the domain by business capability, not by command name or technical layer: see canon rule domains; when none fits, create a subdomain (canon rule domain <domain>/<name>). Code lives in the matching directory, and the change file names the subdomain.
- A significant choice with real alternatives becomes a decision (canon decision new --title "..."), rejected options included.
- Finish with canon work land --finish. Landing is the only gate: when refused, fix what it names and land again. Stopping before that: canon work stop --next "<next step>".
- Landing can take minutes while it waits behind other landings: run it with a long timeout or in the background, and read its exit code directly, not through a pipe.
- Before landing run canon work test: it runs only the test files related to your change (changed tests, tests that import changed files, tests that name a rule you touched), one file per run, and says why it picked each; --all runs every test file. The floor runs the full suite when landing.
- After it lands, the project's post-land commands run in the background: canon work after-land --wait <C-n> (your change: another landing may come after yours) waits for them and prints each exit code and the code-review lines; use it instead of reading or polling the log.
- Ask the human only about direction, choices left to them, spending money (paid APIs, cloud resources), irreversible actions on shared things (publishing, deleting remote data, pushing to someone else's repository), or credentials and second factors; do not wait for them on anything else. Ask in the conversation, then record their exact words: canon human answer <n> <answer> --relayed "<their words>". Never answer for them.
- Removing a worktree or branch that holds unlanded work: canon work drop <C-n>, never plain git; it archives what would be lost before deleting, so it needs no one's approval.
- A problem you will not fix now: open an issue, one root cause per issue, with a command that reproduces it, the expected result and the actual result.`;
