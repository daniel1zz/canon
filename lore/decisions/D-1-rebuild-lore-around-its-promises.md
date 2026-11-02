---
id: D-1
title: Rebuild lore around its promises, keeping only what is necessary
status: accepted
---
## Context

By November 2026 lore had 80 top-level commands (~190 with subcommands), ~192k source lines, 27 gates and hooks, 43 skills and ~59k tokens of instructions injected per session. An audit of the live repo (2026-11-02) measured:

- Method checks (how an agent works) mostly refused legitimate work: the commit guard's "0 commits ahead" check 20/20 false in a sample, the git-safety gate 46/54 false, the edit anchor gate 148/270 false; ~7% of anchor refusals were followed by a shell write around it.
- Process records nobody used: 240 decision records with 0 traced outcomes; a calibration statistic 96% written by agents; snapshot_accuracy review 90 fails, 0 real; the per-task evidence log 6,367 calls, ~43 h.
- Baseline rules were valuable (agents answered 16.5/20 from rules vs 13/20 without; writing them surfaced 61 confirmed defects), but the machinery around them was not: 81.7% of 25,255 baseline versions were coverage-map writes; the citation gate's useful refusals were 2/35.
- AI review paid only on spec and ADR text (15/15 sampled rejects real); code security/concurrency review findings were mostly real but duplicated and stale because the judge saw one plan's diff.
- Agents grepped the exported Markdown mirror 273 times in 30 days instead of using search.

The owner set seven promises (P1-P7 in lore/product.md) and the rule that the burden of proof is on keeping a mechanism.

## Options

1. Prune the existing system and restructure it into DDD contexts in place. Rejected: most of the code embodies the process being removed; moving 669 files that will be deleted is waste, and the in-between state would last long.
2. Keep SQLite as the source of truth and slim it. Rejected: knowledge must change in the same commit as the code it describes (P1, P5), and git already provides history, diff, blame and backup.
3. Rebuild a small core beside the old one in the same repository and cut over once. Tried first (branch `next`), then rejected: the old project's hooks, rules and tests kept interfering (a git-safety gate refused removing a scratch worktree; a mistyped path ran the old 2,000-test suite), and the cut-over had to delete 6,000 files and move the new code.
4. Rebuild in a new repository at the old path; the old repository becomes the archive. Chosen.

## Decision

- Knowledge is Markdown files under `lore/`: one file per rule (`rules/<domain>/BR-n.md`), decision, change and note. A scripted simulation of concurrent sessions showed one file per rule gives 0% false merge conflicts versus 53% for a shared file appended to (8 sessions: 3.3% vs 59%).
- Ids are allocated by a coordination SQLite DB in the git common dir, always above the highest id in the files, never reused.
- Coordination (claims, landing queue, handoffs, human questions, events) lives in that DB, shared by all worktrees of the checkout. One machine only.
- Checks are outcomes at two boundaries: a coordination write (compare-and-swap) and a landing (rebase onto main, floor, `lore check`, rule review, compare-and-swap of main). No hook checks how an agent works.
- AI review is blocking only for rule and decision text, with the whole domain as context; code review runs after landing and never blocks.
- Acceptance is tests that name rule ids; `lore check` greps both sides.
- Context is pulled (`lore context`), whole domains, never injected per turn.
- The old repository is the archive: renamed to `~/Projects/zz/lore-v1` locally, `github.com/daniel1zz/lore` on GitHub. Its corpus (rules of the old system included) is not migrated: those rules describe behaviour the rebuild removes. New rule ids start at `BR-2001` so an id never means two things across the two repositories.

## Consequences

- No HTTP server, dashboard, Turso sync, seats, phases, AC records, evidence log, citation gate, coverage map, calibration or decision fields on writes.
- Old ids (`BR-1` to `BR-1613`, `AS-n`, `AD-n`) exist only in the archive repository.
- Every check records why it refused in the events table, so its precision can be measured and the check removed when it does not pay.
