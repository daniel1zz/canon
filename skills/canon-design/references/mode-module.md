# Design Mode: Module

**Purpose**: Multi-perspective module/component structure and boundary design
→ See [architecture-patterns.md](architecture-patterns.md) for patterns (fallback)
→ See [../shared/docs-lookup-guide.md](../../shared/docs-lookup-guide.md) for docs lookup

## Phase 1: Context & Analysis

```yaml
input: { feature, patterns, framework }

pre_work:
  1. Analyze existing module structure (serena: list_dir, get_symbols_overview)
  2. MANDATORY: Query framework docs (context7/deepwiki/gitmcp) for module organization, DI patterns, conventions
  3. Draft module boundaries and public interfaces
```

Output: **Module Draft** — proposed structure, interfaces, dependencies.

## Phase 2: Multi-Perspective Module Review

Launch **4 parallel subagents**, each evaluating the module design from a different concern.
Use `Agent` tool — send ALL 4 in a single message for true parallel execution.

### Perspective Matrix

| # | Perspective | Identity Prompt | Review Focus |
|---|------------|----------------|-------------|
| 1 | **Coupling Analyst** | "You analyze dependencies and coupling between modules. Loose coupling is your priority." | Dependency direction correct? Circular dependencies? Module knows too much about others? Interface too wide? Can this module be replaced/mocked independently? Data ownership clear? |
| 2 | **Cohesion Reviewer** | "You evaluate whether each module has a clear, focused responsibility." | Single responsibility? Feature envy (doing work that belongs elsewhere)? God module risk? Are related things together? Are unrelated things separated? Naming reflects purpose? |
| 3 | **Reuse & Extension Planner** | "You plan for module reuse and future extension without over-engineering." | Can this module be reused in other contexts? Extension points without modification (OCP)? Over-engineered abstractions? Configuration vs code? Plugin points needed? |
| 4 | **Testing Architect** | "You evaluate how testable this module structure is." | Clear test boundaries? Dependencies injectable? Side effects isolated? Public API sufficient for black-box testing? Test data strategy? Integration test scope clear? |

### Subagent Prompt Template

Each subagent receives:

```
## Module Review Perspective
{Identity Prompt}

## Module Draft
**Feature**: {feature name}
**Proposed Structure**: {file tree}
**Public Interfaces**: {TypeScript interfaces}
**Dependencies**: {what this module needs from outside}
**Framework**: {framework conventions}
**Existing Codebase Patterns**: {how other modules are structured}

## Your Task
Review this module design from your perspective.

Provide:
1. **Assessment** (3-5 points): What's good/bad about this structure from your lens?
2. **Issues** (2-3): Specific structural problems
3. **Recommendations** (2-3): Concrete changes to improve
4. **Trade-off**: What you're willing to sacrifice for your priorities

250 words max. Be specific about files/interfaces, not abstract.
```

## Phase 3: Synthesis & Final Design

After all 4 agents return, synthesize:

1. **Consensus** — structural decisions all perspectives agree on
2. **Tensions** — coupling vs cohesion vs reuse trade-offs (explicit decisions)
3. **Revised structure** — incorporating all findings

## Output Template

```markdown
# Module Design: [Feature/Module Name]

## Module Boundary
- **Public API**: [What this module exposes]
- **Internal**: [What stays private]
- **Dependencies**: [What it needs from outside]

## Structure
src/[module]/
├── index.ts          # Public exports
├── [module].service.ts
├── [module].controller.ts
├── [module].repository.ts
├── dto/
├── interfaces/
└── __tests__/

## Public Interface
[TypeScript interfaces exported from index.ts]

## Dependency Graph
[mermaid: Controller → Service → Repository / External]

## Design Decisions
| Decision | Choice | Rationale | Trade-off |
|----------|--------|-----------|-----------|

## Perspective Tensions Resolved
| Tension | Perspectives | Resolution | Why |
|---------|------------|-----------|-----|
```

## Quality Gate Verification

Before finalizing, verify ALL gates pass (see SKILL.md Quality Gates table):
- [ ] No circular dependencies
- [ ] Every module has single clear responsibility
- [ ] Public API sufficient for black-box testing
- [ ] Dependencies injectable

**REFUSE to finalize** if any gate fails. Report failing gates and iterate.

## Persist
- Record the result the canon way (see SKILL.md, "Record the design"): a decision for each real choice, rules for behaviour, the change file for the work.
