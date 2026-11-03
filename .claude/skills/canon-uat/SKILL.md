---
name: canon-uat
description: "Use when a feature or change is done and needs acceptance: does the product actually do what its rules promise, driven through its real entry point (CLI or web)? Also when tests pass but the product still feels broken. Triggers: 'acceptance', 'UAT', 'accept this', 'is this ready to ship', 'does it really work', 'were all the rules verified', '验收', '能交付吗', '规则都验证了吗', '真的能用吗'. Executor and judge are separate; outcomes are proven by machine probes. NOT for writing a test suite (use canon-test) or debugging a known bug (use canon-diagnose)."
---

# Acceptance (canon)

Acceptance answers one question: **does the product do what its rules promise, for someone who uses only the real entry point and knows nothing about the implementation?** Tests prove units; acceptance proves the product. "The component exists and its tests pass" is not "a user can reach it".

## The spine: the executor reports, the judge rules

- **Executor.** Drives one journey through the real entry point (the command, the page). Receives only a persona card, a goal, the entry point and credentials the persona would have; never rule text, source, selectors or internal paths. Emits an action trace and a first-person log of what it saw and where it got stuck. It never writes "passed", "achieved" or "gave up" as a ruling; abandonment is an event ("tried four ways to undo, none worked, stopped").
- **Judge.** Never drove the journey. Receives the trace, the log, the rules, and the results of **probes it runs itself**. It alone rules every gate.

Run them as separate subagents. If you cannot (you are a subagent yourself), execute every journey first and write the full evidence, then judge; tag the verdict `SELF-VERIFIED` and lower its confidence, because one context cannot un-see its own execution.

## 1. Anchor on the rules

1. `canon context <domain|C-n>`: the active rules in scope, their examples, the accepted decisions and the change being accepted.
2. Build the **inventory**, the denominator of the run: one row per active rule in scope, `BR-n · what it promises · P0/P1/P2` (P0 = without this the feature has no reason to exist). Include every rule about what the product must **refuse** (invalid input → usage error, foreign claim → conflict, check violation → refusal with a fix hint); refusals are first-class rows, not afterthoughts.
3. A user-visible promise in the change that no rule states, or a rule too vague to judge, is a **rule gap**: record it and judge that row `UNVERIFIED`. Do not stop to ask. The finding becomes a rule edit (step 6).
4. Environment: local or a throwaway copy, never production or a shared repo. Build or start the product first and record exactly what you ran.

## 2. Derive journeys

A journey = persona card + goal + entry point + success criteria, citing the inventory rows it covers.

- **Persona card**: `knows` is a whitelist ("has used git; was told `canon work start` begins a change"). Anything not on it is knowledge the executor may not use.
- **Goal**: an outcome in the persona's world ("my fix is on main"), never a feature name.
- **Success criteria are outcomes, each with an oracle**: `exit` (code), `fs` (file content), `git` (branch, commit, ref), `db`/`api` (the record), `artifact` (a downloaded file), `ui` (seen on a surface other than the one that announced success). "Prints ok" and "a toast appears" are never criteria by themselves.

Tiers; **quick is the default**:

| Tier | Rows covered | Per P0 row |
|------|--------------|------------|
| quick | P0 | happy path + its riskiest refusal + one destructive probe |
| standard | P0, P1 | quick + error recovery, abandon and return, messy input, return later with state intact, accumulated state (seed 30+ realistic records first) |
| thorough | all | standard + exit paths (export, delete, undo) + edge personas |

**Destructive probes**: a graceful refusal passes; silence, corruption or a blank screen is a finding.

- Double submit: run the same mutating command twice, double-click submit, re-send after a timeout. Look for duplicate records and re-fired side effects.
- Two at once: two tabs editing one record, or two worktrees/processes acting on the same change at the same moment. Who wins, and is the loser told?
- Interrupt mid-flow: kill the process during a write, go offline mid-save, then check state integrity.
- Hostile and stale input: overlong, emoji, an id that was deleted, a ref that moved, an unknown flag.

Close derivation with a **coverage audit**: every inventory row maps to a journey or is `UNCOVERED: <reason>` (tier cut, environment missing). "Forgot" is not a reason. A P0 row, refusals included, is never cut by tier; if it cannot be exercised, the run carries `COVERAGE-GAP`.

## 3. Execute

Run P0 journeys first, each executed and judged before the next tier starts, so a run that dies still keeps its most important verdicts.

**CLI driver** (canon itself, any command-line product):

```bash
T=$(mktemp -d) && E=$(mktemp -d)     # throwaway repo; evidence kept outside it
git -C "$T" init -q && git -C "$T" commit -q --allow-empty -m init
# set up only what the persona would have, then run the real command (built binary or entry file):
(cd "$T" && canon work start --title "x") > "$E/03.out" 2> "$E/03.err"; echo "exit=$?" > "$E/03.exit"
git -C "$T" branch --list > "$E/03.git"; git -C "$T" status --short >> "$E/03.git"
```

Record per step: command, exit code (read unpiped, never through `| tail`), stdout, stderr, and the files and git state afterwards. A fresh repo per journey; journeys never share one.

**Web driver**: `agent-browser`; decide each step from screenshots (what a user sees), not from the DOM or accessibility tree; use the snapshot only to label what was clicked. Isolate concurrent journeys by **browser profile**, not session name: sessions on one origin share local storage and cookies.

**Trace**, one line per action, written as you go: `{"step":3,"intent":"start a change","action":"run","target":"canon work start --title x","before":"no branch","after":"branch change/C-1, exit 0","confusion":false}`. The judge rules H1 from the end state and H3 from the sequence; prose cannot serve either.

**Budget in countable units**: per obstacle, try every affordance the persona can see (`--help`, the error's hint, visible buttons), then record a give-up event; per journey, stop at 5 confusion events or 8 failed attempts. Reaching the stop is a reportable outcome. Never re-enter the same form more than 2–3 times.

## 4. Judge

Three hard gates, each `pass` / `fail` / `UNVERIFIED`. `UNVERIFIED` never counts as a pass; missing evidence is `UNVERIFIED`, never an assumed pass.

- **H1 Task completion**, ruled from the trace's end state, not the executor's feelings. Done with heavy confusion still passes (it costs friction). A P0 H1 `fail` needs a **second independent executor** (fresh card, fresh repo or profile) to reproduce it before it can drive REJECT; if the two diverge, mark `EXECUTOR-VARIANCE` and report it instead.
- **H2 Outcome correctness, by a machine probe the judge runs itself**: read the file, query the record, `git log main`, parse the export. For P0 a `ui` observation is not enough. No probe possible ⇒ `UNVERIFIED` ⇒ the row cannot pass. A success message over wrong data is the most dangerous pass there is.
- **H3 No cheat**, audited from the trace: did any step use a path, flag, format or id the persona's whitelist could not have produced? A cheat invalidates the journey: re-dispatch it with a corrected card before ruling.

Scored 1–5, from the trace: **friction** (backtracks and confusion against the shortest path any executor actually took), **error recovery** (was the message actionable to this persona, was work preserved), **rule fidelity** (each promise delivered as written, differently, or missing; "differently" is a finding, never silently accepted).

## 5. Verdict

| Condition | Verdict |
|-----------|---------|
| Every P0 and P1 gate passes, scores ≥ 3, no gap | ACCEPT |
| No gate fails on P0, but some P0 gate is UNVERIFIED (rule gap, no probe), a P0 row is uncovered, a P1 gate fails or a score is < 3 | ACCEPT-WITH-ISSUES |
| A P0 gate fails (H1 reproduced by a second executor) | REJECT |

Modifiers on the verdict line: `COVERAGE-GAP`, `RULE-GAP`, `UNVERIFIED`, `SELF-VERIFIED`, `EXECUTOR-VARIANCE`. An UNVERIFIED P0 gate is a blocking gap, listed first: the row is not accepted until it is probed or its rule is fixed. P2 findings never change the verdict on their own.

## 6. Report and findings

Report in the reply (and in the change file's tasks when accepting a change): verdict and modifiers; the inventory with each row's journey, gates and verdict; the uncovered rows with reasons; what was run and where. Every non-pass finding cites its rule, the trace steps and the evidence; a finding without evidence is deleted, not reported.

Each finding lands in canon, not in a report nobody reads again:

- **Product contradicts a rule** → a defect. Fix it in this change with a regression test named after the rule (see canon-test), or open a GitHub issue (`gh issue create`): one root cause, the reproducing command, expected vs actual.
- **Rule gap** → edit the rule (`## 规则`, `## 例子` with the boundary just found) or add one with `canon rule new`, in a change. If what the rule should say is a product direction call, `canon human ask` and carry on; do not wait for the answer.
- **Accepted P0 journeys** → freeze into automated tests named after their rules (`it("BR-n: ...")`), asserting the same oracle the judge probed, so the floor re-checks them at every land.
