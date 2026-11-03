---
name: canon-design
description: "Use before implementing when a change needs an architecture, API, data model, system (scale, reliability) or module-boundary design, or when choosing between real alternatives. Triggers: 'design this', 'architecture', 'API design', 'data model', 'schema', '设计一下', '架构', '方案对比'. Ends in a canon decision (D-n) and rules, not a separate design document. NOT for visual UI design."
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

- Give at least two real options with their trade-offs, and a recommendation. Three or more options or several dimensions → reason step by step (sequential thinking) instead of a pros/cons list from memory.
- Check current official docs before proposing any library, version or API.
- Quantify vague goals first ("fast" → p99 under X ms at Y rps).
- Every scenario the design serves names at least one business-level failure it must handle (limit hit, payment declined, permission revoked mid-flow, upstream outage) and how it fails loudly and recoverably; "no failure mode applies" has to be argued, not assumed.
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
| Concurrency | shared state, several sessions or processes | name the interleaving that could break it and what makes it atomic |
| Performance | latency-sensitive paths, large data | set a budget and show the design meets it |
| Observability | new component | what is logged or recorded, and how a failure is noticed |
| Data privacy | PII or other user data | classify its sensitivity; encryption at rest and in transit; retention period and deletion; audit trail of who reads or changes it |

## 4. Record the design

1. **Decision** for each real choice: `canon decision new --title "..."` → fill 背景 (facts, data), 方案 (every option with why it was taken or rejected), 决定, 后果. Write it in Chinese (canon/ documents are Chinese). A decision without its rejected options is blocked at land.
2. **Rules** for every behaviour the design commits the product to: `canon rule new --domain <d> --title "..."`. One rule = one trigger and one outcome; fill 规则 and 例子 with concrete inputs on both sides of the boundary. Each active rule needs a test that names it.
3. **Change file** (`canon/changes/C-n.md`): 为什么 / 要改什么 referencing the decision and the rules.
4. Land as usual (`canon work land`). The rule review reads the decision and rules against the whole domain; fix what it blocks.

Interfaces worth fixing before implementation (types, command signatures, schema) go into the change file or the code itself, not a separate document.
