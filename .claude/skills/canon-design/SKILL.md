---
name: canon-design
description: "Use when deciding how something should be structured: designing a new architecture, API, data model, system (scale, reliability) or module boundary, or judging whether an existing structure, model, layout or process is the right design and how it should change ('is this the best design', 'evaluate our X', 'should we reorganise'). Also whenever choosing between real alternatives. Triggers: 'design this', 'architecture', 'API design', 'data model', 'schema', 'is this the best', 'evaluate the design', '设计一下', '架构', '方案对比', '是不是最佳', '评估一下', '该怎么改'. NOT for visual UI design or a defect-only audit."
---

# Design (canon)

Design is done when a later session can read **why** (a decision, `canon/decisions/D-n.md`) and **what must hold** (rules, `canon/rules/<domain>/BR-n.md`) without asking anyone. A design that lives only in this conversation is lost.

## 1. Pick the mode

| Mode | Read | Focus |
|------|------|-------|
| `architecture` | `references/mode-architecture.md`, `references/architecture-patterns.md` | layers, boundaries, C4, migration |
| `api` | `references/mode-api.md`, `references/api-design.md` | endpoints / commands, errors, auth, pagination |
| `database` | `references/mode-database.md`, `references/database-design.md` | schema, indexes, migrations, access patterns |
| `system` | `references/mode-system.md`, `references/system-design.md` | SLAs, failure modes, capacity |
| `module` | `references/mode-module.md` | responsibility, depth (deletion test), seams, dependency categories |

Read only the files of the mode you need. Cross-cutting references (`references/cross-cutting/`: authorization, error handling, idempotency, session identity) when the design touches them.

## 2. Before designing

1. `canon context <path|domain|C-n>`: the whole current domain, its rules, the accepted decisions and open changes. The design must not contradict an active rule or an accepted decision; if it has to, say so and change them in the same change.
2. `canon search <topic>`: earlier decisions and notes on the same question. Extend or supersede (`--supersedes D-n`), never silently redo.
3. Look at how 1–3 mature products or libraries solve the same problem before inventing one.
4. Read the existing code you are changing (symbols, callers) before proposing structure.

## 3. Design

- Frame the problem before listing options: what questions must this design answer, which scenarios must it serve? When evaluating an existing design, a list of its defects is input, not the frame: a plan built only from the defect list is a patch, not a design.
- Give at least two real options with their trade-offs, and a recommendation. Real means different designs, not one design done more or less ("fix 3 things" vs "fix 10 things" is one option). Three or more options or several dimensions → write the reasoning out dimension by dimension instead of a pros/cons list from memory.
- Before giving the recommendation, have it challenged once by a subagent that sees the problem and the options but not your recommendation. Ask it: is the question itself framed wrong, is a genuinely different design missing, in which scenario does each option fail? Address what it raises, then recommend. Skip this only for a small design inside one module that changes no interface, and say that you skipped it and why.
- Check current official docs before proposing any library, version or API.
- A question that driving a throwaway answers faster than arguing (does this state machine or data model hold up in use, which of a few screen layouts works) is settled with the canon-prototype skill first; the design then cites what the prototype showed.
- Quantify vague goals first ("fast" → p99 under X ms at Y rps).
- Every scenario the design serves names at least one business-level failure it must handle (limit hit, payment declined, permission revoked mid-flow, upstream outage) and how it fails loudly and recoverably; "no failure mode applies" has to be argued, not assumed.
- Weigh each option's complexity against what it costs when the scenario happens, and judge each scenario by canon-triage's criterion for a real finding (its section 2: do normal operations lead to it?). A scenario that criterion calls a known limit gets one line in the decision's 后果 or the rule, not a new mechanism.
- Review the draft against the mode's lenses yourself. Parallel review subagents (one per lens, see the mode file) are optional: each starts from zero context and costs tens of thousands of tokens, so use them only when the blast radius is large (cross-module, public API, data migration, security).

### Quality gates (all must pass, or say which one does not and why)

| Mode | Gates |
|------|-------|
| `architecture` | every non-functional requirement has a measurable architectural answer; every tension has a decision with rationale; high risks have mitigations; migration phases with rollback |
| `api` | every operation has its errors; every operation has its auth requirement; security issues resolved or accepted with rationale; pagination and rate limits stated |
| `database` | all foreign keys indexed; every table justified by an access pattern; zero-downtime migration for every schema change; no float for money, time zones on timestamps |
| `system` | SLA targets (throughput, p99, availability); no unmitigated single point of failure; every component has a failure mode and degradation; capacity at 1×/10×/100× |
| `module` | no dependency cycles; one clear responsibility per module; every module passes the deletion test; no seam with a single adapter; public surface enough to test as a black box; dependencies injectable |

### Cross-cutting (evaluate every time; skip only with a stated reason)

| Concern | When | Do |
|---------|------|----|
| Security | user input, auth, storage, external calls | trace the data flow, list threats and mitigations |
| Concurrency | shared state, several sessions or processes | name the interleaving that could break it in normal use and what makes it atomic; rarer ones are known limits unless they lose data |
| Performance | latency-sensitive paths, large data | set a budget and show the design meets it |
| Observability | new component | what is logged or recorded, and how a failure is noticed |
| Data privacy | PII or other user data | classify its sensitivity; encryption at rest and in transit; retention period and deletion; audit trail of who reads or changes it |

## 4. Record the design

1. **Decision** for each real choice: `canon decision new --title "..."` → fill 背景 (facts, data), 方案 (every option marked 采用 or 否决 with why, at least one of each), 决定, 后果. Write it in Chinese (canon/ documents are Chinese). Under the options cite where the facts come from, one line each: `- 来源：<URL or repository path> “<exact quote, 8+ characters>”` — research the outside practice first, then quote it; a new decision needs at least one source, and the landing fetches each new one and refuses it unless the quote is really there. Do not add self-assessed scores or confidence levels: nobody can check them.
2. **Rules** for every behaviour the design commits the product to: `canon rule new --domain <d> --title "..."`. One rule = one trigger and one outcome; fill 规则 and 例子 with concrete inputs on both sides of the boundary. A behaviour this change does not build (its code comes in a later step of the plan) gets `status: planned` in the rule's front matter: it needs 规则 and 例子 but no test, and the change that builds it lists it under `rules:` and makes it active. In a planned rule's 例子 pin only the boundaries the design settles; the edge cases the implementation finds are added by the step that builds it.
3. **Change file** (`canon/changes/C-n.md`): 为什么 / 要改什么 referencing the decision and the rules.
4. If the design changes a container (a runtime part, where its data lives) or a main flow, update `canon/architecture.md` in the same change: it describes the system as it is now, each part ending with its decision numbers. Check its decision numbers against what you just decided: a superseded or amended one means a line to rewrite.
5. Land as usual (`canon work land`). The rule review reads the decision and rules against the whole domain, and the overview; fix what it blocks.

No separate document per design: interfaces worth fixing before implementation (types, command signatures, schema) go into the change file or the code itself.
