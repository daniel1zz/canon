# Design Mode: API

**Purpose**: Multi-perspective API contract design
→ See [api-design.md](api-design.md) for conventions
→ See [../shared/docs-lookup-guide.md](../../shared/docs-lookup-guide.md) for docs lookup

## Phase 1: Context & Draft

```yaml
input: { domain, operations, style: REST|GraphQL }

pre_work:
  1. Define resources and operations
  2. MANDATORY: Query framework docs (context7/deepwiki/gitmcp) for framework-specific API patterns
  3. Draft endpoint list with request/response schemas
  4. Draft error handling strategy
```

Output: **API Draft** — endpoint list, schemas, error codes.

## Phase 2: Multi-Perspective API Review

Launch **4 parallel subagents**, each reviewing the draft API from a different consumer/concern lens.
Use `Agent` tool — send ALL 4 in a single message for true parallel execution.

### Perspective Matrix

| # | Perspective | Identity Prompt | Review Focus |
|---|------------|----------------|-------------|
| 1 | **Frontend Consumer** | "You are a frontend developer who will consume this API. You care about DX, consistency, and ease of integration." | Intuitive resource naming? Consistent response shapes? Pagination standard? Filtering/sorting ergonomic? Error responses actionable? Loading states clear? Batch endpoints where needed? |
| 2 | **Security Reviewer** | "You are a security engineer auditing this API design for vulnerabilities." | Auth on every endpoint? Rate limiting? Input validation boundaries? Sensitive data in URLs/logs? IDOR risks? Mass assignment? Information disclosure in errors? CORS policy? |
| 3 | **Performance Engineer** | "You are evaluating API performance characteristics at scale." | N+1 query risks? Over-fetching (return too much data)? Under-fetching (too many round trips)? Caching headers? Pagination limits? Large payload risks? Async operations for heavy work? |
| 4 | **API Evolution Planner** | "You plan for API lifecycle — versioning, deprecation, backward compatibility." | Versioning strategy? Breaking change risks? Extensible response shapes (envelopes)? Deprecation path? Webhook/event design for async? GraphQL considerations? Documentation plan? |

### Subagent Prompt Template

Each subagent receives:

```
## API Review Perspective
{Identity Prompt}

## API Draft
**Domain**: {domain}
**Style**: {REST|GraphQL}
**Endpoints**: {full endpoint list with schemas}
**Error Strategy**: {error handling approach}

## Your Task
Review this API design from your perspective.

Provide:
1. **Issues** (3-5): Specific problems with the current design, citing endpoints
2. **Recommendations** (3-5): Concrete changes to improve the API
3. **Missing Endpoints**: Any operations the API should support but doesn't?
4. **Quality Score**: 1-10 from your perspective

300 words max. Be specific about endpoints, not abstract.
```

## Phase 3: Synthesis & Final Design

After all 4 agents return, synthesize:

1. **Cross-perspective issues** — flagged by 2+ perspectives (must fix)
2. **Security blockers** — any security issue = must fix regardless of count
3. **DX improvements** — from Frontend Consumer (high impact on adoption)
4. **Revised API spec** — incorporating all fixes

## Output Template

```markdown
# API: [Domain]

## Design Decisions
| Decision | Choice | Rationale | Dissenting View |
|----------|--------|-----------|-----------------|

## Endpoints

### POST /auth/login
**Purpose**: Authenticate user
**Request**: `{ "email": "string", "password": "string" }`
**Response** (200): `{ "accessToken": "string", "refreshToken": "string", "expiresIn": 900 }`
**Errors**:
| Code | Description |
|------|-------------|
| 401 | Invalid credentials |
| 429 | Too many attempts |

## Cross-Cutting Concerns
- Authentication: [strategy]
- Rate Limiting: [policy]
- Pagination: [standard]
- Versioning: [approach]
- Error Format: [standard shape]
```

## Quality Gate Verification

Before finalizing, verify ALL gates pass (see SKILL.md Quality Gates table):
- [ ] Every endpoint has error responses documented
- [ ] Auth matrix: every endpoint has auth requirement
- [ ] All security issues from review resolved or accepted with rationale
- [ ] Pagination + rate limiting specified

**REFUSE to finalize** if any gate fails. Report failing gates and iterate.

## Persist
- Record the result the canon way (see SKILL.md, "Record the design"): a decision for each real choice, rules for behaviour, the change file for the work.
