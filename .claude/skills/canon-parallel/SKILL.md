---
name: canon-parallel
description: "Use when dispatching several subagents to work at the same time in a canon project, or deciding whether a batch of tasks should be split across concurrent agents at all. Triggers: 'parallel agents', 'concurrent subagents', 'dispatch subagents', 'fan out', 'split this across agents', 'run these in parallel', 'spawn agents for each task', '并行', '并发', '派子 agent', '分给几个 agent', '同时做这几件事'. Covers when to split and when not, what every subagent's brief must contain, and how the main agent verifies the results from canon's event table instead of trusting the subagents' reports. NOT for doing one change yourself."
---

# Parallel subagents (canon)

Several agents can work on one canon project at once: each holds its own change in its own worktree, and landings take turns. That keeps work from being lost, but it does not make landings faster. Split only when the gain is real, brief every subagent the same way, and judge the outcome by what canon recorded, not by what the subagents say.

## 1. Split or not

Landings are serial: one at a time, each one spends most of its turn running the floor (the project's full test command). **The floor is the throughput limit.** If a landing takes about 2.5 minutes, an hour holds about 24 landings no matter how many agents are working; more agents only make the queue longer.

Split when the tasks are:

- **independent**: no task needs another one's result to start, and they change different files;
- **medium-sized**: each is a whole change with its own rules and tests, minutes to tens of minutes of work. A tiny task costs a full landing turn of its own, and a subagent first spends tens of thousands of tokens reading context;
- **3 to 5 at once.** In a measured run, 5 subagents finished in about 44 minutes what took them about 122 minutes added up (about 2.8 times faster), and kept the landing queue busy the whole time. More than that only adds waiting.

Do not split, or put the tasks in one agent's hands, when:

- **two tasks change the same file** (see section 2, step 3);
- one task needs another's result (do them in order);
- the main agent already holds the context and the work is small: doing it yourself is cheaper than briefing someone.

## 2. Before dispatching

1. Note where the run starts in the event table: `canon events | tail -1` and take that event's id (call it `<start>`). Everything the subagents do is recorded after it.
2. Give each task one change. Either let the subagent create it (`canon work start --title "<title>"`) or name an existing one (`canon work start C-n`). Never give two subagents the same change: the second start is refused as claimed (exit 5).
3. List the files each task will likely touch: run `canon context <path>` for the area, and read what the change file plans to change where the change already exists. Two tasks that will edit the same file do not run at the same time: give them to one agent in sequence, or put them in different rounds. Watch for files every feature appends to, such as a central registry of commands or config keys, a guide listing every workflow, or one large shared test file; most conflicts land there.
4. If two tasks must still touch the same file, say so in both briefs, and name which one lands first.
5. Estimate the cost before you dispatch, from measured numbers, and tell the user: a subagent that reads an area and lands one change typically uses on the order of 70k to 280k tokens, so ten of them is roughly a million or more. Ask before a run that large; do not guess low.
6. Read-only audits that run at the same time (several agents checking different areas) report what they find and do not file issues themselves: two of them can find the same root cause, and each one's "search for an existing issue first" races the other's. The main agent dedupes, checks the key claims, then files one issue per root cause.

## 3. What every brief must contain

Copy this list into each brief and fill in the task. A subagent starts with none of your context.

- **The task and why**: what to build, the evidence for the need, what counts as done, and which domain or files it covers.
- **Its own change**: run `canon work start --title "<title>"` (or `canon work start C-n`) from the primary checkout, then `cd` into the worktree it prints and do every edit there. The rest of the workflow is in `canon brief`: tell the subagent to run it.
- **Hands off the others**: never enter, edit or clean another agent's worktree, and never edit the primary checkout.
- **Test before landing**: where `canon work test` does not exist, run each related test file in its own test-runner invocation (several files in one run have hung under load). Never run the full suite: the floor runs it once at landing.
- **Landing**: redirect the output of `canon work land --finish` to a log file. Exit 75: still queued after the wait, run it again.
- **No background work left behind**: the agent tool moves a subagent's command to the background after about three minutes, so a test run or a landing usually ends up there. The subagent then waits for that command's completion notice and does not end its turn or write its final report while the command still runs; it starts no other background commands or monitors, and stops any it did start before its final report. A subagent that ends its turn with background work still running stays listed as waiting, and a landing it left running was once killed with it, silently.
- **After landing**: `canon brief` says how to wait for the post-land commands. Where `canon work after-land` does not exist, read the after-land log whose path the landing printed, until every background command has written its exit line. A simple real bug found in the code-review findings is fixed in a new change; anything else is reported.
- **Clean only its own worktree**: `canon work clean <C-n>` with its own change id, never a bare `canon work clean`.
- **Decisions stay proposed**: a subagent cannot start subagents of its own, so it cannot run canon-design's independent challenge. When a task writes a decision, the brief says: land it as `proposed`, do not `canon decision accept` it, and list it in the report. The main agent then has an agent that sees the problem and the options, not the recommendation, challenge it, addresses what it finds, and accepts the decision itself.
- **Execute; hand back choices the brief did not settle**: the main agent holds the whole context and makes the decisions, the subagent carries out the brief. When going on would mean making a choice the brief did not settle, or doing work the main agent would likely not want, stop and report first instead of deciding. Common cases: about to add a new mechanism (table or column, process handling, rule) for a situation not seen in real use; the work is clearly larger or different than the brief said; the brief's premise turns out false; the same area was already fixed more than once recently for the same kind of problem (`git log` on the files, `canon search`); the fix would contradict an accepted rule or decision; a choice reserved for the owner. Small choices inside the brief's scope are not a reason to stop: finish the task. To stop: commit what exists, run `canon work stop --next "<why stopped>"`, and report what was found and the options with a recommendation; the main agent decides and resumes the subagent.
- **Report with measurements**: change ids, what changed, rules and decisions, the tests run and their result, each landing's exit code and time (queued and total), review findings, and anything not done with the reason.

## 4. While they run

- Do not start the subagents' changes yourself or redo their work. Your own work goes in your own change and lands through the same queue.
- `canon work status` shows the claims and the landing queue; the overlap lines a landing prints show which changes touch the same files.

## 5. Verify from the event table, not from the reports

A subagent's report is a claim; the coordination database recorded what happened. Check before you accept any result:

1. `canon stats --since <start>`: landings ok and refused, queue waits, conflicts, who took part, and the refusals per check.
2. `canon events --since <start> --kind land.ok` (and `--kind land.refuse`, `--subject C-n`): each change a subagent reports as landed must have a `land.ok` event; a refusal it did not mention is a finding.
3. `canon work after-land <C-n>` for each change: its own background commands finished and exited 0, and what code review said about it; a failure the report did not mention is a finding.
4. `git log --oneline <main>`: every reported change has its commits and its close commit on main.
5. `canon check` on main, and `canon work status`: no leftover claims or queued entries from the run.
6. Spot-check the key points of each report against the code: a test named in the report exists and proves what it says.
7. Find the hotspots for the next run: group `canon events --since <start> --kind overlap.notice --json` by the files in each notice, and read the conflict refusals in `canon events --since <start> --kind land.refuse` for the files they name. A file that keeps showing up is worth splitting, or worth keeping to one agent per round.
8. With `floor_timing: after` (check `canon work status`: it shows `main: N landings not yet tested`), the background floor waits for a quiet period or a backlog before it tests main. Once the batch is verified and nothing more is about to land, run `canon floor watch --now`: it tests main's latest commit at once, waits for a test in progress and returns when main's latest commit is tested; exit 1 means that commit failed, and `canon work start --fix-main` opens the fix.
9. Stop each subagent once its result is verified (the agent tool's stop, e.g. `TaskStop` with its id), even when it reported done: one that still holds background commands or monitors stays listed and keeps running them.

Where `canon stats --since` or `canon events` does not exist yet, use `canon stats` (totals only), `canon work status` and `git log` on main, and say in your summary that the run was checked without the event window.

Report the run with the numbers from these commands (landings, refusals and why, queue waits, conflicts, wall time against the subagents' time added up), not with the subagents' own summaries.
