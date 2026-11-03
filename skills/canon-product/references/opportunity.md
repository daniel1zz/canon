# Mode: opportunity

Derive the feature list instead of inventing it: an opportunity solution tree (Teresa Torres) from **one** measurable outcome, through evidenced needs, to competing solutions, to experiments that could disprove them.

Without evidence about user pain (a benchmark's gaps, support tickets, issues, analytics), do not brainstorm needs from imagination. Run `benchmark` or mine the existing data first, and say so.

## Level 1: one outcome

A metric with a baseline and a target, not a project name.

| Valid | Invalid | Why |
|-------|---------|-----|
| "7-day activation 23% → 40%" | "Improve onboarding" | Not measurable |
| "Median time to first value 40 min → 5 min" | "Launch a mobile app" | That is a solution |

One outcome per tree; two outcomes are two trees. With no known baseline, the first deliverable is the instrumentation to get one. Which outcome to pursue is direction: if it was not given, `canon human ask`.

## Level 2: opportunities (needs, evidence-gated)

An opportunity is a need, pain or desire in the user's terms. **Solution-in-disguise test**: reject it if any is true:

1. It names a UI element, page, or system ("a dashboard", "an onboarding wizard", "AI-powered X").
2. Prefixing "users need " makes it ungrammatical or absurd.
3. There is exactly one obvious way to satisfy it (a real need admits many).

| Opportunity | Solution in disguise |
|-------------|----------------------|
| "New users don't know what to do first" | "Add an onboarding wizard" |
| "I lose my place when I come back the next day" | "Add a resume banner" |
| "I can't tell whether the run succeeded" | "Add a status badge" |

- Each opportunity cites **at least two independent sources** with their tiers. One resting only on E5/E6 is marked `unevidenced` and cannot be the branch pursued.
- Opportunities are independent: if satisfying A first requires satisfying B, B is the real opportunity and A sits under it.

## Level 3: at least 3 solutions per opportunity

Fewer than three means the solution space was never searched; one solution is an anchor, not a choice. Three near-identical variants do not count. Generate across these axes:

| Axis | Prompt |
|------|--------|
| **Remove** | Can the need disappear instead of being served? The best solutions often delete a step |
| **Automate** | Can the system do it without the user? |
| **Assist** | Can the user's existing path become faster or clearer? |
| **Defaults** | Can a better default make the decision unnecessary? |
| **Borrow** | What did the benchmark show others doing here? |
| **Absurd** | The obviously-too-much version; it exposes hidden constraints |

## Level 4: experiments that can disprove

Each solution gets the smallest test that could show it does not work, with the **kill condition stated before running it**. An experiment that can only confirm is not an experiment.

| Experiment | Answers | Cost |
|-----------|---------|------|
| Existing data or support-log read | Does the pain show up at all? | Hours |
| Fake door | Does anyone want it? (needs real traffic: human) | Hours |
| Prototype + target tasks (`canon-prototype`) | Can it be figured out? | Days |
| Engineering spike | Can we build it at all? | Days |
| Concierge, done by hand for 3 users | Does solving it change behaviour? (human) | Days |
| A/B test | Does it move the outcome at scale? | Weeks; last, not first |

Record for each: hypothesis · kill condition · smallest test · what we do with either result.

## Prioritise: one branch

Score each opportunity 1–5 on anchored scales, so two runs reach the same answer and a score can be argued with:

| | 1 | 3 | 5 |
|---|---|---|---|
| **Evidence strength** | Single E5/E6 source | 2 independent sources, best E4 | 2+ independent sources incl. E1–E3 |
| **Outcome leverage** | No line to the metric | Affects a step where some of the gap sits | Sits on the largest measured drop-off |
| **Disproof cost** | Needs live traffic or a full build (weeks) | Prototype or spike (days) | Existing data, fake door, log read (hours) |

Rank by the mean; break ties on disproof cost (a cheap wrong answer is recoverable). Then give exactly three labels, because a lone winner hides the reasoning that gets re-litigated next month:

- **Recommended**: pursue now, carry into `validate`.
- **Alternative**: pursue if the recommended branch is refuted; name the trigger.
- **Not recommended**: parked; record why and what evidence would reopen it.

At most 2–3 opportunities active at once; a tree with every branch active is a backlog. These three labels are the options of the `canon human ask` when the bet is the humans' call.

## Exit checks

- [ ] One measurable outcome with a baseline (or an instrumentation task to get one).
- [ ] Every opportunity passes the solution-in-disguise test and cites 2+ sources with tiers.
- [ ] Every opportunity has 3+ materially different solutions; every solution an experiment with a kill condition.
- [ ] One branch recommended; the others recorded with reasons.
