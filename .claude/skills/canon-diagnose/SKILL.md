---
name: canon-diagnose
description: "Use when the user says 'diagnose this' / 'debug this', reports a bug, says something is broken, throwing, failing or flaky, or describes a performance regression. Triggers: 'bug', 'broken', 'failing test', 'why does', '排查', '为什么报错', '修这个 bug'. Runs a feedback-loop, reproduce, hypothesise, instrument, fix, regression-test loop, and records the result the canon way."
---

# Diagnose (canon)

A discipline for hard bugs. Skip a phase only with a stated reason.

Start with `canon context <path>` for the code you suspect: the domain's rules say what the code must do, which is what "wrong" means here. If no rule covers the behaviour, that gap is part of the finding.

## Phase 1 — Build a feedback loop

**This is the skill.** With a fast, deterministic, agent-runnable pass/fail signal for the bug, you will find the cause; without one, no amount of reading code will. Spend disproportionate effort here.

Ways to build one, roughly in this order:

1. A **failing test** at whatever seam reaches the bug (unit, integration, end to end).
2. An **HTTP script** against a running dev server.
3. A **CLI invocation** with a fixture input, diffing output against a known-good snapshot (for canon itself: a throwaway git repo plus `bun src/cli/main.ts ...`).
4. A **headless browser script** asserting on DOM, console or network.
5. **Replay a captured trace** (request, payload, event log) through the code path in isolation.
6. A **throwaway harness**: the smallest subset of the system that reaches the code path in one call.
7. A **property or fuzz loop** for "sometimes wrong output".
8. A **bisection harness** (`git bisect run`) when the bug appeared between two known states.
9. A **differential loop**: same input through old and new version, diff the outputs.
10. **Human in the loop**, last resort: copy `scripts/hitl-loop.template.sh`, so even a manual repro is structured and its answers come back to you.

Then improve the loop itself: faster (narrow scope, skip unrelated setup), sharper (assert on the exact symptom, not "didn't crash"), deterministic (pin time, seed randomness, isolate the filesystem and network). For a non-deterministic bug, raise the reproduction rate (loop it, parallelise, add stress, narrow timing windows) until it is debuggable.

If you genuinely cannot build a loop: stop, say so, list what you tried, and ask for access to the environment, a captured artifact, or permission for temporary instrumentation. Do not hypothesise without a loop.

## Phase 2 — Reproduce

Run the loop and watch the bug appear. Confirm it is the failure the user described (not a nearby different one), that it reproduces across runs, and capture the exact symptom so you can verify the fix against it later.

## Phase 3 — Hypothesise

Write **3–5 ranked, falsifiable hypotheses** before testing any: "If X is the cause, then changing Y makes the bug disappear / changing Z makes it worse." A hypothesis without a prediction is discarded or sharpened. Show the ranked list to the user if they are present (they often know which one it is); do not wait if they are not.

## Phase 4 — Instrument

Each probe tests one prediction; change one variable at a time. Prefer a debugger or REPL; otherwise targeted logs at the boundaries that tell hypotheses apart, never "log everything and grep". Tag every debug line with a unique prefix (`[DEBUG-a4f2]`) so cleanup is one grep. For performance: measure a baseline first (timer, profiler, query plan), then bisect.

## Phase 5 — Fix and regression test

Write the regression test **before** the fix, at a seam that exercises the real bug pattern as it happens at the call site. A test at a too-shallow seam gives false confidence; if no correct seam exists, that is a finding (see Phase 6).

1. Turn the minimised repro into a failing test. In canon, name it after the rule it proves (`it("BR-n: ...")`).
2. Watch it fail. 3. Fix. 4. Watch it pass. 5. Re-run the original, un-minimised loop.

If the fix changes what the product does, change the rule in the same commit (`canon/rules/<domain>/BR-n.md`), or add one with `canon rule new`. A bug in behaviour no rule describes usually means a rule is missing: add it.

## Phase 6 — Clean up and record

Before calling it done:

- [ ] the original repro no longer reproduces
- [ ] the regression test passes (or the missing seam is written down)
- [ ] every `[DEBUG-...]` line is gone (grep the prefix) and throwaway harnesses are deleted
- [ ] the hypothesis that turned out right is in the commit message

Then ask what would have prevented the bug. A fix that needs a design change (no good test seam, tangled callers, hidden coupling) becomes a change of its own (`canon work start --title ...`, with a decision if there are real options); a problem you are not fixing now becomes a GitHub issue with the reproduce command, expected and actual result, one root cause per issue.
