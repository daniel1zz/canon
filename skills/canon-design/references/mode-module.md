# Design Mode: Module

**Purpose**: Multi-perspective module/component structure and boundary design
→ See [architecture-patterns.md](architecture-patterns.md) for patterns (fallback)
→ Check current official docs (context7 / the vendor docs) before naming any library, version or API

## Phase 1: Context & Analysis

```yaml
input: { feature, patterns, framework }

pre_work:
  1. Analyze existing module structure (serena: list_dir, get_symbols_overview)
  2. MANDATORY: Query framework docs (context7/deepwiki/gitmcp) for module organization, DI patterns, conventions
  3. Draft module boundaries and public interfaces
```

Output: **Module Draft** — proposed structure, interfaces, dependencies.

### Depth and seams (apply to every proposed or existing module)

A module's **interface** is everything a caller must know: types, invariants, ordering, error modes, required configuration. A module is **deep** when a lot of behaviour sits behind a small interface, **shallow** when the interface is nearly as complex as the implementation.

- **Deletion test**: imagine deleting the module. If its complexity vanishes, it was a pass-through; merge it into its callers. If the complexity reappears across N callers, it earns its keep. Ask "would deleting it make callers simpler, or just move the code?"
- **One adapter = hypothetical seam. Two adapters = real seam.** Do not introduce a port/interface unless at least two adapters are justified (typically production + test). A single-adapter seam is just indirection.
- **The interface is the test surface.** Callers and tests cross the same seam; if a test must reach past the interface, the module is the wrong shape. Do not expose internal seams through the interface just because tests use them.

Classify each dependency of the module; the category decides how it is tested across its seam:

| Category | Example | Design and test |
|----------|---------|-----------------|
| In-process | pure computation, in-memory state | merge freely; test through the interface directly, no adapter |
| Local-substitutable | Postgres with PGLite, an in-memory filesystem | test with the local stand-in running in the suite; the seam stays internal |
| Remote but owned | your own service across the network | define a port at the seam; production adapter (HTTP/gRPC/queue) + in-memory adapter for tests |
| True external | third-party APIs (payments, SMS) | inject it as a port; tests use a mock adapter |

When a design deepens existing shallow modules, the tests are replaced, not layered: write new tests at the deepened module's interface, asserting observable outcomes, and delete the old unit tests on the shallow modules once those exist. A test that has to change whenever the implementation changes is testing past the interface.

## Phase 2: Multi-Perspective Module Review

By default, review the draft yourself against each of the 4 lenses below, one at a time, and write down what each finds.
Parallel subagents are optional and costly (each starts from zero context, typically tens of thousands of tokens): use them only when the blast radius is large (cross-module, public API, data migration, security). Then send all 4 in one message, each with the prompt template below.

### Perspective Matrix

| # | Perspective | Identity Prompt | Review Focus |
|---|------------|----------------|-------------|
| 1 | **Coupling Analyst** | "You analyze dependencies and coupling between modules. Loose coupling is your priority." | Dependency direction correct? Circular dependencies? Module knows too much about others? Interface too wide? Can this module be replaced/mocked independently? Data ownership clear? |
| 2 | **Cohesion Reviewer** | "You evaluate whether each module has a clear, focused responsibility." | Single responsibility? Feature envy (doing work that belongs elsewhere)? God module risk? Are related things together? Are unrelated things separated? Naming reflects purpose? |
| 3 | **Reuse & Extension Planner** | "You plan for module reuse and future extension without over-engineering." | Can this module be reused in other contexts? Extension points without modification (OCP)? Over-engineered abstractions? Configuration vs code? Plugin points needed? |
| 4 | **Testing Architect** | "You evaluate how testable this module structure is." | Clear test boundaries? Dependencies injectable? Side effects isolated? Public API sufficient for black-box testing? Test data strategy? Integration test scope clear? Does every module pass the deletion test, and does every seam have two adapters? |

### Subagent Prompt Template

Each subagent (when used) receives:

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

After all lenses are reviewed (by you or by subagents), synthesize:

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
- [ ] Every module passes the deletion test; every port/interface has at least two adapters

**REFUSE to finalize** if any gate fails. Report failing gates and iterate.

## Persist
- Record the result the canon way (see SKILL.md, "Record the design"): a decision for each real choice, rules for behaviour, the change file for the work.
