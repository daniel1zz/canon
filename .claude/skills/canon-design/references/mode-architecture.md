# Design Mode: Architecture

**Purpose**: Multi-perspective system architecture design
→ See [architecture-patterns.md](architecture-patterns.md) for patterns
→ Check current official docs (context7 / the vendor docs) before naming any library, version or API
→ Visualization: C4 Model (Context → Container → Component → Code) — choose appropriate abstraction level

## Phase 1: Context, Constraints & Quality Attribute Analysis

```yaml
input: { scope, functional_reqs, non_functional_reqs, constraints }

pre_work:
  1. Analyze current architecture (serena: list_dir, get_symbols_overview)
  2. Research patterns (context7, gitmcp)
  3. MANDATORY: Query official docs for chosen frameworks
  4. Quality Attribute Utility Tree (ATAM-lite):
     - Extract NFRs → categorize (performance, security, availability, modifiability, usability)
     - Prioritize each: (importance H/M/L, difficulty H/M/L)
     - Top-priority attributes → concrete scenarios in stimulus-response-measure format
```

### Quality Attribute Scenario Format

For each high-priority NFR, define:

| Element | Description |
|---------|-------------|
| **Stimulus** | What triggers the concern (e.g., "1000 concurrent users submit forms") |
| **Response** | What the system does (e.g., "processes all within SLA") |
| **Measure** | How to verify (e.g., "p99 latency < 200ms, zero data loss") |

These scenarios feed directly into the multi-role evaluation (Phase 2) and become testable acceptance criteria for the implement/test skills.

## Phase 2: Multi-Role Architecture Evaluation

By default, review the draft yourself against each of the 6 lenses below, one at a time, and write down what each finds.
Parallel subagents are optional and costly (each starts from zero context, typically tens of thousands of tokens): use them only when the blast radius is large (cross-module, public API, data migration, security). Then send all 6 in one message, each with the prompt template below.

### Role Matrix

| # | Role | Identity Prompt | Core Concerns |
|---|------|----------------|--------------|
| 1 | **Performance Architect** | "You are a performance-focused architect. Every millisecond and byte matters." | Latency paths? Caching strategy? Data locality? Hot paths? Bottleneck prediction? Scale ceiling? |
| 2 | **Security Architect** | "You are a security architect. Think in threat models and attack surfaces." | Attack surface? Auth boundaries? Data flow trust zones? Secrets management? Compliance requirements? Least privilege? |
| 3 | **DX & Maintainability** | "You are a staff engineer focused on developer experience and long-term maintainability." | Code organization? Cognitive load? Onboarding complexity? Testing strategy? Debug-ability? Convention consistency? Dependency management? |
| 4 | **Operations Engineer** | "You are an SRE/ops engineer. You care about what happens at 3am." | Failure modes? Observability? Deployment strategy? Rollback plan? Health checks? Alert fatigue? Graceful degradation? |
| 5 | **Cost Optimizer** | "You are a cost-conscious architect evaluating infrastructure and operational costs." | Infrastructure cost at 1x/10x/100x scale? Build vs buy for each component? Team cost (complexity = velocity tax)? Managed vs self-hosted? Over-engineering risks? |
| 6 | **Domain Architect** | "You are a domain architect. You care about bounded contexts, aggregate boundaries, entity behaviors, and ubiquitous language." | Bounded context boundaries? Aggregate invariants? Entity vs Value Object? Domain vs Application Service? Repository pattern? Ubiquitous Language alignment? |

### 6. Domain Architect
**Perspective**: "I care about bounded contexts, aggregate boundaries, entity behaviors, and ubiquitous language."

**Focus areas**:
- Bounded Context identification and mapping (context map)
- Aggregate design: invariant boundaries, transactional consistency
- Entity vs Value Object classification
- Domain Service vs Application Service separation
- Repository pattern and persistence ignorance
- Ubiquitous Language alignment between code and domain

**Review checklist**:
- [ ] Are aggregate boundaries clearly defined? Can invariants be enforced within a single aggregate?
- [ ] Do entities encapsulate behavior (not just data)? Are there signs of Anemic Domain Model?
- [ ] Are Value Objects used for concepts with no identity (money, address, date range)?
- [ ] Is the domain layer free of infrastructure dependencies (DB, HTTP, framework)?
- [ ] Does the code use domain language consistent with stakeholder terminology?

**Trigger**: When canon has decisions or notes for the domain (`canon search <domain>`, `canon context <domain>`) OR task involves business logic modeling

### Subagent Prompt Template

Each subagent (when used) receives:

```
## Role
{Identity Prompt}

## Architecture Brief
**System**: {scope description}
**Functional Requirements**: {FR list}
**Non-Functional Requirements**: {NFR list}
**Constraints**: {tech constraints, team size, timeline}
**Current Architecture**: {summary of existing system, if any}
**Proposed Approach**: {initial architecture direction, if any}

## Your Task
Evaluate the proposed architecture (or propose one) from your specialized perspective.

Provide:
1. **Assessment** (3-5 points): What's good/bad about this architecture from your lens?
2. **Risks** (2-3): Specific risks the team should mitigate
3. **Recommendations** (2-3): Concrete changes you'd make
4. **Trade-off Acknowledgment**: What you're willing to sacrifice for your priorities
5. **Critical Decision**: The ONE architectural decision that matters most from your perspective

Keep output concise (300 words max). Be specific about components, not abstract.
```

## Phase 3: Synthesis & Design

After all lenses are reviewed (by you or by subagents), synthesize into final architecture:

### Synthesis Framework

1. **Consensus Decisions** — architectural choices all roles agree on (high confidence)
2. **Tension Points** — where roles disagree (these are the real trade-offs to document)
3. **Risk Registry** — all risks from all roles, deduplicated and prioritized
4. **Trade-off Decisions** — for each tension point, make an explicit decision with rationale
5. **Architecture Decision Records** — one ADR per significant trade-off

### Tension Resolution Table

| Tension | Role A says | Role B says | Decision | Rationale |
|---------|-----------|-----------|----------|-----------|
| Caching strategy | Performance: aggressive cache | Security: minimal cache (data freshness) | ... | ... |
| Service granularity | DX: fewer services | Ops: isolated blast radius | ... | ... |

## Phase 4: Record

No separate architecture document per design. The current system is `canon/architecture.md`: context, containers (runtime parts, their data, who calls whom) and main flows, only as it is now, each part ending with its decision numbers. If this design changes a container or a main flow, update it in the same change. Trade-off decisions become canon decisions (SKILL.md section 4); the tension table and risk registry from Phase 3 go into the decision's 方案 and 后果.

### ADR Format (enhanced)

Each Architecture Decision Record MUST include:

```markdown
## ADR-{N}: {Title}
**Status**: proposed | accepted | deprecated | superseded
**Date**: {YYYY-MM-DD}

**Context**: What forces are at play? What quality attributes are affected?

**Decision**: What was decided?

**Quality Attributes Affected**:
| Attribute | Impact | Scenario Reference |
|-----------|--------|--------------------|
| Performance | +/- | QA-{N} |
| Security | +/- | QA-{N} |

**Alternatives Considered**:
| Option | Pros | Cons | Why Rejected |
|--------|------|------|-------------|

**Consequences**: What becomes easier? What becomes harder?

**Validation Plan**: How will we verify this decision was correct?
```

## Persist
- Record the result the canon way (see SKILL.md, "Record the design"): a decision for each real choice, rules for behaviour, the change file for the work.
