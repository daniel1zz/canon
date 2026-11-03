# Design Mode: System

**Purpose**: Multi-perspective distributed system and scalability design
→ See [system-design.md](system-design.md) for patterns and decision tables
→ See [../shared/docs-lookup-guide.md](../../shared/docs-lookup-guide.md) for docs lookup

## Phase 1: Requirements & Capacity Modeling

```yaml
input: { system_scope, throughput, latency, availability, constraints }

pre_work:
  1. Analyze current system (serena: list_dir, get_symbols_overview)
  2. Extract SLA targets from PRD/requirements (`canon search <topic>`, and `canon/product.md`)
  3. MANDATORY: Query official docs (context7/deepwiki/gitmcp) for chosen technologies
  4. Back-of-envelope capacity model:
     - Daily active users → peak QPS (rule: peak ≈ 3-5x average)
     - Storage growth rate → 1yr/3yr projections
     - Network bandwidth requirements
  5. Identify hard constraints (budget, team size, existing infra, compliance)
```

Output: **System Brief** — SLA targets, capacity model, constraints, technology candidates.

## Phase 2: Multi-Perspective System Review

Launch **4 parallel subagents**, each evaluating the system design from a different concern.
Use `Agent` tool — send ALL 4 in a single message for true parallel execution.

### Perspective Matrix

| # | Perspective | Identity Prompt | Review Focus |
|---|------------|----------------|-------------|
| 1 | **Capacity Planner** | "You model system capacity and predict scaling bottlenecks." | Throughput math correct? Resource sizing adequate? Growth projections at 1x/10x/100x? Bottleneck identification? Horizontal vs vertical scaling decision per component? Data partitioning strategy? |
| 2 | **Reliability Engineer** | "You design for failure. Every component will fail — your job is graceful degradation." | Single points of failure? Failure mode per component with blast radius? Circuit breakers, retries, timeouts? Data durability guarantees? Disaster recovery plan (RPO/RTO)? Health checks and self-healing? |
| 3 | **Cost Optimizer** | "You evaluate infrastructure cost-efficiency at every scale point." | Managed vs self-hosted per component? Reserved vs on-demand vs spot? Over-provisioning risks? Cost at 1x/10x/100x scale? Build vs buy for each component? Serverless opportunities? |
| 4 | **Operations Engineer** | "You care about what happens at 3am. Observability, deployment, incident response." | Observability: metrics/logs/traces coverage? Alerting strategy (no alert fatigue)? Deployment: blue-green/canary/rolling? Rollback plan? Runbook for top 5 failure scenarios? On-call burden? |

### Subagent Prompt Template

Each subagent receives:

```
## System Review Perspective
{Identity Prompt}

## System Brief
**Scope**: {system description}
**SLA Targets**: { throughput, p99 latency, availability % }
**Capacity Model**: {DAU, peak QPS, storage projections}
**Proposed Architecture**: {components, data flow, technology choices}
**Constraints**: {budget, team, existing infra, compliance}

## Your Task
Evaluate the proposed system design from your perspective.

Provide:
1. **Assessment** (3-5 points): What's good/bad from your lens?
2. **Risks** (2-3): Specific risks with severity (critical/high/medium)
3. **Recommendations** (2-3): Concrete changes to the design
4. **Trade-off**: What you're willing to sacrifice for your priorities
5. **Critical Decision**: The ONE system decision that matters most from your perspective

300 words max. Be specific about components, not abstract.
```

## Phase 3: Synthesis & Design

After all 4 agents return, synthesize:

1. **Consensus** — system decisions all perspectives agree on (high confidence)
2. **Tension Points** — where perspectives disagree (document as explicit trade-offs)
3. **Risk Registry** — all risks deduplicated, prioritized by severity × likelihood
4. **Trade-off Decisions** — for each tension, explicit decision with rationale
5. **Architecture Decision Records** — one ADR per significant trade-off

### Tension Resolution Table

| Tension | Perspective A says | Perspective B says | Decision | Rationale |
|---------|-------------------|-------------------|----------|-----------|
| Managed vs self-hosted DB | Cost: managed saves ops | Reliability: self-hosted gives control | ... | ... |
| Cache aggressiveness | Capacity: aggressive cache | Reliability: cache invalidation risk | ... | ... |

## Phase 4: Document

```markdown
# System Design: [System Name]

## Overview
[1-2 paragraph description]

## Requirements
| Dimension | Target | Measurement |
|-----------|--------|-------------|
| Throughput | [X req/s] | [how measured] |
| Latency | [p99 < Xms] | [how measured] |
| Availability | [X%] | [calculation] |

## Architecture Diagram
[Component diagram — mermaid or C4]

## Component Design
### [Component A]
- **Responsibility**: [single sentence]
- **Technology**: [choice + rationale]
- **Scaling**: [strategy]
- **Failure Mode**: [what happens when it fails + degradation]

## Data Flow
[Sequence diagram for critical paths]

## Technology Choices
| Component | Technology | Rationale | Alternative | Official Ref |
|-----------|-----------|-----------|-------------|--------------|

## Capacity Plan
| Scale | Users | QPS | Storage | Compute | Est. Cost |
|-------|-------|-----|---------|---------|-----------|
| 1x | | | | | |
| 10x | | | | | |
| 100x | | | | | |

## Risk Registry
| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|

## Trade-off Decisions
| Decision | Choice | Rationale | Trade-off | Dissenting View |
|----------|--------|-----------|-----------|-----------------|

## Failure Modes
| Component | Failure | Blast Radius | Detection | Recovery | Degradation |
|-----------|---------|-------------|-----------|----------|-------------|

## Observability
| Signal | What | Tool | Alert Threshold |
|--------|------|------|-----------------|
| Metric | | | |
| Log | | | |
| Trace | | | |
```

## Persist
- Record the result the canon way (see SKILL.md, "Record the design"): a decision for each real choice, rules for behaviour, the change file for the work.
