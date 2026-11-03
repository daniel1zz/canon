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

- **two tasks change the same file.** They conflict at landing, and the one landing second finds out only when its turn comes, after waiting in the queue. It can still be done, but plan for rework;
- one task needs another's result (do them in order);
- the work is a follow-up on a review note that does not block: that is not a change of its own;
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
- **Its own change**: run `canon work start --title "<title>"` (or `canon work start C-n`) from the primary checkout, then `cd` into the worktree it prints and do every edit there. Fill the change file's sections before the code, and change rules in the same commit as the behaviour.
- **Hands off the others**: never enter, edit or clean another agent's worktree, and never edit the primary checkout.
- **Test before landing**: run `canon work test`, which runs the test files related to the change, one file per run. Where that command does not exist, run each related test file in its own test-runner invocation (several files in one run have hung under load), and never the full suite: the floor runs it once at landing.
- **Land with a long timeout**: `canon work land --finish`, with a command timeout of at least 10 minutes or in the background, output redirected to a log file; read the exit code directly, never through a pipe (a pipe reports the last command's code). Refused (exit 1): fix what the message names, commit, land again; never bypass the gate. Exit 75: still queued after the wait, run it again.
- **After landing**: run `canon work after-land <C-n> --wait` with its own change id where the command exists (check `canon work --help`). Without the id it reports the newest landing of anyone, which may be another subagent's; otherwise read the after-land log whose path the landing printed, until every background command has written its exit line, and read the code-review findings in it. A simple real bug found there is fixed in a new change; anything else is reported.
- **Clean only its own worktree**: `canon work clean <C-n>` with its own change id, never a bare `canon work clean`.
- **Review notes that do not block are not changes**: do not open a follow-up change for them.
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

Where `canon stats --since` or `canon events` does not exist yet, use `canon stats` (totals only), `canon work status` and `git log` on main, and say in your summary that the run was checked without the event window.

Report the run with the numbers from these commands (landings, refusals and why, queue waits, conflicts, wall time against the subagents' time added up), not with the subagents' own summaries.
