# Mode: benchmark

Turn "the industry has solved this before" into a **feature matrix** where every cell carries a URL, a screenshot or a recorded interaction. Model memory may suggest candidates to verify; it never fills a cell.

Scope the teardown to one question (for example "what does a team meet between sign-up and a first useful result?"). An unscoped teardown becomes a feature dump.

## 1. Pick 1–3 benchmarks

More than three dilutes depth into a shallow sweep.

| Slot | Pick | Why |
|------|------|-----|
| **Category leader** (required) | The product most users would name first | Defines table stakes: what users assume exists |
| **Closest analogue** (required) | Whoever serves *our* user in *our* scenario, even if smaller | The leader's scope is shaped by its scale, not by our user |
| **Non-product alternative** (required) | A spreadsheet, a template, a shell script, doing nothing | Most products lose to these, not to the leader |
| Adjacent disruptor (optional) | A newer product attacking the category from another angle | Shows where the category is heading |

State each pick and why before gathering anything.

## 2. Gather evidence

Never drop to a lower tier while a higher one is reachable.

| Tier | Source |
|------|--------|
| **B1** | Hands-on use of the live product (free tier, public demo, sandbox), driven with `agent-browser` |
| **B2** | Official surface: docs, changelog, pricing page, help centre, API reference |
| **B3** | Product-made media: demo videos, onboarding walkthroughs, published screenshots |
| **B4** | Third-party teardowns, review sites, community threads |
| **B5** | Model recall: candidates only; promote to B1–B4 or drop |

**Pricing pages are disproportionately informative**: how a company packages features shows which ones it believes carry willingness to pay.

If a benchmark cannot be reached above B4, say so and mark its cells unverified; an unverified cell is not scored as an absence.

Extract per benchmark:

1. Feature inventory, in the product's own vocabulary.
2. Information architecture: top-level navigation, how it organises its concepts.
3. Core flow step count from entry to first value, and where the friction sits.
4. State coverage: empty, loading, error, first run, lots of data.
5. Onboarding: what it forces before you can succeed once.
6. Pricing packaging: which features gate which tier.

## 3. Build the matrix

```markdown
| # | 功能 | 领头产品 | 最接近的同类 | 非产品替代 | 我们 | 分类 | 证据 |
|---|------|----------|--------------|------------|------|------|------|
| 1 | 首屏不为空 | 有：3 个自动看板 | 有：行业模板 | 不适用 | 无：空白画布 | table-stakes | 2026-07 实际走过注册 |
```

Every row gets exactly one class:

| Class | Definition | Consequence |
|-------|-----------|-------------|
| **table-stakes** | Present in all benchmarks, and its absence makes the core job fail | In scope. Its absence is a defect, not a differentiator |
| **differentiator** | Present in some, plausibly why users pick that one | Candidate bet; must survive `validate` |
| **trap** | Present but low use, legacy, or there only to justify a pricing tier | Written down as a non-goal so nobody copies it by reflex |
| **gap** | Absent everywhere, yet the job clearly needs it | The most valuable rows; they feed `opportunity` |

**Feature parity is not a strategy.** A matrix that concludes "build what the leader has" has failed; it must name what we will deliberately not build. A trap is a claim about *our* outcome, not that the feature is bad; re-check it if the outcome changes.

## 4. Output (the note)

Sections: 选了哪些对标及原因（各自达到的证据等级）· 功能矩阵 · table-stakes · differentiator · trap（明确不做）· gap（机会候选）· 证据表（论断、等级、来源）· 没能核实的部分.

Gap rows and the user pain seen during the teardown become opportunity candidates (needs, not features). Trap rows become the non-goals stated in the direction question.
