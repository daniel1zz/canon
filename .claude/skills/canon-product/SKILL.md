---
name: canon-product
description: "Use when deciding what to build or whether a feature is worth building: tearing down benchmark products, deriving features from an outcome and evidenced needs, running the cheapest experiments that could kill a bet, or expanding a validated solution into a story map. Triggers: 'what should we build', 'is this worth building', 'validate this idea', 'what do competitors have', 'benchmark', 'teardown', 'story map', '该做什么功能', '这功能有人要吗', '验证一下', '对标', '竞品功能拆解', '拆功能'. NOT for architecture or API design (canon-design), UI variants (canon-prototype), or writing a PRD."
---

# Product (canon)

Two failures dominate AI product work: the feature list is whatever someone thought of, and "validated" means "reasoned about". This skill replaces recall with observation and plans with results.

In canon, humans set direction and AI sessions do the rest. So this skill **gathers and grades evidence, derives the options, and runs what an AI can run**; the choice of direction goes to the humans with that evidence attached.

## 1. Pick the mode

| Mode | Question | Read |
|------|----------|------|
| `benchmark` | What already ships, and what does nobody serve? | `references/benchmark.md` |
| `opportunity` | Which needs, and which solutions, follow from one outcome? | `references/opportunity.md` |
| `validate` | Is the problem worth solving, and does the solution work? | `references/validate.md` |
| `decompose` | What exactly does the validated solution consist of? | `references/decompose.md` |

Usual order for a new bet: benchmark → opportunity → validate → decompose. Read only the file of the mode you run.

- Do not jump from opportunity to rules with untested solutions: every carried behaviour is then marked `unvalidated` in the note and the human question.
- Decompose is required when the change **adds a step** to the user's journey; it may be skipped for a change to a single existing step.

## 2. Before starting

1. `canon search <topic>` and `canon context <domain>`: earlier notes, decisions and rules on the same question. Extend or supersede an earlier note; never silently redo it. A benchmark older than about two quarters is re-run, not trusted.
2. Name the **one** outcome this work serves (a metric with a baseline and a target). If nobody has stated one, that is a direction question: `canon human ask`.

## 3. The evidence ladder (all modes)

Every claim about users or demand carries its tier.

| Tier | Evidence | Weight |
|------|----------|--------|
| **E1** | Observed behaviour: you watched them struggle, or instrumented data shows it | Strongest |
| **E2** | Money spent: they already pay for a partial solution or a competitor | Strong |
| **E3** | Time invested: they built a spreadsheet, script or manual process to cope | Strong |
| **E4** | Past-behaviour quotes: interview answers about what they actually did | Moderate |
| **E5** | Public complaints with specifics: support tickets, issues, forum and review posts | Moderate |
| **E6** | Stated intent: survey answers, "I would definitely use that" | Near zero; never sufficient alone |

- **Model recall is E6.** It may generate candidates to verify; it is never a source.
- **A subagent playing the user is E6.** Never simulate users and count the answers as evidence, least of all for willingness to pay.
- **Enthusiasm is not evidence.** The only future-tense signal that counts is backed by an irreversible commitment (prepayment, a signed pilot, real data uploaded).
- **Warm sources are discounted one full tier.** Friends, teammates and existing champions want to be encouraging.

## 4. What an AI session can run, and what it cannot

| Can run now | Needs a human (ask, do not fake) |
|-------------|-----------------------------------|
| Teardowns of live products, docs, changelogs, pricing pages (a browser via `agent-browser`, or fetched docs) | Interviews with real users |
| Mining data the project already has: analytics, logs, support tickets, GitHub issues | Fake doors or A/B tests on real traffic |
| Engineering spikes in a worktree | Anything that spends money or contacts customers |
| Prototypes (`canon-prototype`) driven against stated tasks | Usability sessions with target users |

What cannot be run is marked `unvalidated` with the reason. If the missing experiment is what the decision hinges on, put it in the human question as an option ("run X before deciding").

## 5. Record the result

1. **Research → a note.** `canon note new --title "<topic> 的<对标/机会树/验证/故事地图>"`, then edit the file. Language: canon-rules section 6 step 2. It holds the matrix, tree, ledger or map, every claim with its tier and source, failed experiments next to passing ones, and the rejected branches with the reason and what evidence would reopen each. It does not hold a version's slice of the map (item 5).
2. **Direction → `canon human ask`.** Which outcome to pursue and which branch to bet on is the humans' call:
   ```
   canon human ask "<问题，一句话>" --option "<推荐>,<备选>,<不推荐>" --change C-n
   ```
   The question cites the note id and states the recommendation, the strongest evidence for and against each option, and what stays `unvalidated`.
3. **Real choices the humans have delegated** (which of two validated solutions to build first, when the outcome is already set) → a decision: `canon decision new --title "..."`, with every rejected option and why.
4. **Behaviour → rules**, through canon-rules and the normal change flow, once the direction is answered (authorship: canon-rules section 0): each above-the-line story-map row the product commits to becomes a rule. A rule resting on an `unvalidated` row says so in its body.
5. **A version's slice → a release document.** When the map is cut into versions, `canon release new --title "<version>"` makes the document: the slice goes in its 故事地图切片 section, next to the version's goal, users, scope, what it leaves out and success criteria. The rules from that slice carry `release: R-n` in their front matter, so `canon release status` shows how far the version is.

## Exit checks (every mode)

- [ ] Every user or demand claim carries a tier and a source; no E6-only claim is presented as established.
- [ ] Failed and not-run experiments are reported alongside passing ones.
- [ ] Rejected options are written down with reasons.
- [ ] The result is in a note; the direction question (if any) is asked with the note cited.
