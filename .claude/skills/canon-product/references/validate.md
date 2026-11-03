# Mode: validate

Run the cheapest experiments that could prove the bet wrong, and grade what comes back, before engineering is committed. This mode ends with **results**, not a plan. A validation section nobody executed is a liability, because it reads as diligence.

Method basis: Marty Cagan's four product risks, Rob Fitzpatrick's *The Mom Test*, multiplicative problem scoring. Tiers are the E1–E6 ladder in `SKILL.md`.

## Part A: Problem Score — is the problem worth solving?

Score four dimensions 1–5. **Every score cites evidence with its tier**; an uncited score is invalid, not "assume 3".

| Dimension | 5 | 3 | 1 |
|-----------|---|---|---|
| **Frequency** | Daily or more | Monthly | Rarely, once |
| **Intensity** | Blocks critical work; real loss of money, time or reputation | Annoying but manageable | Barely noticed |
| **Workarounds** | Paying for partial solutions or built custom tooling | A basic tedious process | Never attempted |
| **Willingness to pay** | Already spending on partial solutions | "Probably would" (hypothetical, discount it) | Never considered paying |

**Score = Frequency × Intensity × Workarounds × WTP** (1–625). At least 250: strong, proceed. 100–249: promising; gather evidence on the weakest dimension first. Under 100: reframe or walk away.

Multiplicative on purpose: a near-zero dimension cannot be averaged away. Worked example, "PDF export": frequency 3 (monthly board reports, E5 ticket) × intensity 2 (a screenshot workaround exists, E1) × workarounds 4 (3 users built print-to-PDF flows, E3) × WTP 1 (nobody pays for export tooling) = 24 → drop.

**The workaround dimension is the honest one.** If nobody has ever cobbled anything together, the pain is below the threshold where people act, however loudly they complain.

## Part B: assumption map — what to test first

Do not test every risk of every solution in parallel; that spends the expensive tests before the cheap ones could make them unnecessary. List every assumption the branch rests on and place it:

| | No evidence | Some evidence | Strong evidence |
|---|---|---|---|
| **High importance** | **Test first: this is the bet** | Test second | Already known |
| **Low importance** | Note it, do not test | Ignore | Ignore |

The riskiest assumption is the one that, if false, makes everything downstream pointless. Test it with the cheapest instrument that could kill it; a three-day spike queued behind a two-hour data read is often never needed.

## Part C: the four risks, per solution

| Risk | Question | Cheapest test | Pass bar |
|------|----------|--------------|----------|
| **Value** | Will they use or buy it? | Existing data, fake door, concierge, pre-sale | Behavioural commitment from 5+ target users, not warm contacts |
| **Usability** | Can they figure it out? | Prototype + 5 target users, unassisted | 4 of 5 finish the core task without help |
| **Feasibility** | Can we build it? | Timeboxed engineering spike | The spike answers the specific unknown; no "probably fine" |
| **Viability** | Does it work for the project? | Unit economics, legal and privacy, support load, maintenance surface | Explicit numbers, or an explicitly accepted risk |

- **Usability**: give the task, then stay silent. Once you explain, the result is void. Record where they hesitate, not what they say afterwards. An AI driving the prototype checks that the task is *completable*; it does not stand in for a target user.
- **Value**: escalate to the strongest signal the stage affords: clicks < sign-ups < real data uploaded < prepayment.
- Never deceive test users beyond what a valid result needs: a fake door is acceptable; taking payment for a product that does not exist is not.

## Part D: execute

Run independent experiments concurrently. What an AI session can and cannot run is in `SKILL.md` §4; what cannot be run now is marked `unvalidated` with the reason, never validated by reasoning.

**Report failed experiments alongside passing ones.** Cherry-picking launders a guess into "validated". If three of five tests failed, the headline is that three failed.

## Output: the validation ledger (in the note)

```markdown
**Problem Score**：频率 4 × 强度 4 × 变通 5 × 付费 3 = 240 → 有希望（最弱：付费意愿，只有假设，没有观察到的花费）

| # | 方案 | 风险 | 做了什么实验 | 结果 | 证据等级 | 结论 |
|---|------|------|--------------|------|----------|------|
| 1 | 引导式首次运行 | 价值 | 已有埋点：340 个新用户 | 18% 走到第二步，淘汰线 5% | E1 | validated |
| 1 | 引导式首次运行 | 可用性 | 原型，5 个目标用户 | 3/5 完成，低于标准 | E1 | refuted，重新设计 |
| 1 | 引导式首次运行 | 可行性 | 没做（需要人安排） | — | — | unvalidated |
```

Every row is exactly one of `validated` (ran, passed its stated bar), `refuted` (ran, failed), `unvalidated` (not run). There is no fourth state for "we reasoned about it and it seems fine". Never upgrade `unvalidated` because the idea is liked, the deadline is close, or the argument is compelling; an unvalidated bet goes to the humans as one (`canon human ask`), labelled as a bet.

If a result refutes something an existing note or decision asserts, say so in the new note and supersede the decision (`canon decision new --supersedes D-n`).

## Exit checks

- [ ] Problem Score on all four dimensions, every score citing tiered evidence.
- [ ] Assumption map built; the riskiest high-importance, no-evidence assumption tested first.
- [ ] Each surviving solution assessed on all four risks; not-run ones marked with the reason.
- [ ] Failed experiments reported next to passing ones.
