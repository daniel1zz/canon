# Design Mode: Database

**Purpose**: Multi-perspective data model and schema design
→ See [database-design.md](database-design.md) for conventions
→ See [../shared/docs-lookup-guide.md](../../shared/docs-lookup-guide.md) for docs lookup

## Phase 1: Domain Concept Analysis

Start from domain concepts, NOT from schema. Schema is derived output.

```yaml
input: { entities, relationships, constraints (DB engine, ORM), domain_context }

pre_work:
  1. `canon context <domain>` and `canon search <domain>` (decisions and notes) → extract entities, invariants, lifecycle states
  2. Analyze existing schema (serena: get_symbols_overview on models/schema files)
  3. MANDATORY: Query ORM docs (context7/deepwiki/gitmcp) for schema patterns, relations, indexes
  4. Identify aggregate boundaries — which entities change together transactionally?
  5. Map entity lifecycles — state machines for entities with status/phase transitions
```

Output: **Domain Model Draft** — entities with invariants, relationships, lifecycle states, aggregate boundaries.

## Phase 2: Multi-Perspective Data Review

Launch **4 parallel subagents**, each reviewing the data model from a different concern.
Use `Agent` tool — send ALL 4 in a single message for true parallel execution.

### Perspective Matrix

| # | Perspective | Identity Prompt | Review Focus |
|---|------------|----------------|-------------|
| 1 | **Data Modeler** | "You are a data architect focused on domain integrity and normalization." | Normalization level appropriate? Aggregate boundaries enforce invariants? Relationships reflect real domain constraints? Value objects modeled correctly (composite types, not separate tables)? Naming follows ubiquitous language? |
| 2 | **Query Optimizer** | "You are a database performance engineer focused on access patterns." | Every table has identified access patterns? Index strategy covers all query paths? Denormalization justified by read patterns? N+1 risks identified? Pagination strategy per collection? Composite index column order correct? |
| 3 | **Migration Planner** | "You are responsible for safe, zero-downtime schema evolution." | Every change has migration strategy? Backward compatible with running code? Rollback plan for each migration? Data backfill strategy? Large table operations planned (batched, off-peak)? Schema versioning approach? |
| 4 | **Security Auditor** | "You audit data models for security, privacy, and compliance." | PII identified and classified? Encryption at rest for sensitive fields? Row-level access control needed? Audit trail for sensitive operations? Soft delete vs hard delete justified? Data retention policy? Credential/secret storage approach? |

### Subagent Prompt Template

Each subagent receives:

```
## Data Review Perspective
{Identity Prompt}

## Data Model Draft
**Domain**: {domain description}
**Entities**: {entity list with attributes, types, relationships}
**Aggregate Boundaries**: {which entities are transactionally coupled}
**Key Invariants**: {business rules the schema must enforce}
**Access Patterns**: {known query patterns}
**Constraints**: {DB engine, ORM, scale expectations}

## Your Task
Review this data model from your perspective.

Provide:
1. **Assessment** (3-5 points): What's good/bad from your lens?
2. **Issues** (2-3): Specific problems, citing entities/fields
3. **Recommendations** (2-3): Concrete schema changes
4. **Trade-off**: What you're willing to sacrifice for your priorities

250 words max. Be specific about tables/columns, not abstract.
```

## Phase 3: Synthesis & Schema Design

After all 4 agents return, synthesize:

1. **Cross-perspective issues** — flagged by 2+ perspectives (must fix)
2. **Security blockers** — any security/privacy issue = must fix
3. **Performance vs integrity tensions** — explicit denormalization decisions with rationale
4. **Final schema** — incorporating all findings

Apply conventions from [database-design.md](database-design.md): naming, ID types, data types, index rules.

## Phase 4: Document

```markdown
# Data Model: [Domain/Feature]

## Domain Concepts
| Entity | Aggregate | Lifecycle States | Key Invariants |
|--------|-----------|-----------------|----------------|

## ER Diagram
[mermaid erDiagram]

## Schema
[Prisma model / SQL DDL]

## Access Patterns & Indexes
| Pattern | Query | Index | Notes |
|---------|-------|-------|-------|

## Migration Strategy
| Change | Steps | Rollback | Risk |
|--------|-------|----------|------|

## Security & Privacy
| Field/Table | Classification | Protection | Retention |
|-------------|---------------|------------|-----------|

## Design Decisions
| Decision | Choice | Rationale | Dissenting View |
|----------|--------|-----------|-----------------|
```

## Persist
- Record the result the canon way (see SKILL.md, "Record the design"): a decision for each real choice, rules for behaviour, the change file for the work.
