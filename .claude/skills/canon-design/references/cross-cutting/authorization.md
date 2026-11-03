# Authorization Design Reference

> Cross-cutting concern. AuthN answers "who are you"; **AuthZ answers "what may you do"**. This file covers AuthZ only. Inject when a design has multiple roles, multi-tenancy, resource ownership, or any per-resource access rule.

## Model Selection

| Model | Decision rule | Best for | Watch out |
|-------|---------------|----------|-----------|
| **RBAC** (role-based) | Permissions are stable and map to job functions | Org hierarchies, admin consoles, static role sets | **Role explosion** — every permission combo spawns a new role |
| **ABAC** (attribute-based) | Decisions depend on context (time, location, IP, resource attributes) | "Only during work hours", "only same-department", conditional rules | Hard to reason about / audit; policy sprawl |
| **ReBAC** (relationship-based, Google Zanzibar) | Permission flows along object relationships ("owner of folder → access its files") | Collaboration tools, document sharing, social graphs, multi-tenant SaaS | Needs a relationship store + graph traversal |
| **ACL** (access control list) | Permissions bound directly per-object | Small scale, few objects | Unmaintainable at scale |

**Rule of thumb**: Start RBAC; add ABAC conditions for edge cases; switch to ReBAC the moment "who can see this" depends on a relationship chain rather than a static role. Large systems combine all three behind a central PDP.

## Permission Modeling — Subject × Resource × Action

Model every permission as a triple: **subject** (user / role / group / attribute) × **resource** (typed object, possibly hierarchical) × **action** (read / write / delete / execute / manage).

- Build an **Access Control Matrix** at design time (rows = roles, cols = resources, cells = allowed actions) to spot gaps and over-grants.
- Apply **least privilege** by default — grant the narrowest action set; deny is the default.
- Separate **resource-level** ("may read *this* doc") from **collection-level** ("may list *all* docs") — they are different permissions.
- ABAC conditions layer *on top of* the matrix (time/location/ownership), they don't replace it.

## Multi-Tenant Isolation

| Strategy | Cost | Isolation | Use when |
|----------|------|-----------|----------|
| **Row-level (RLS)** | Low | Logical (shared DB resources) | Standard SaaS, cost-sensitive |
| **Schema-per-tenant** | Medium | Stronger (DB-enforced) | Mid tenant count, per-tenant customization (degrades past ~hundreds of schemas) |
| **Database-per-tenant** | High | Physical | Regulated industries, contractual isolation |

- **Every tenant-scoped query MUST filter `tenant_id`** — a forgotten `WHERE tenant_id = ?` is the dominant cross-tenant leak. Enforce via RLS policies or a repository layer that injects the predicate, not ad-hoc per-query.
- RLS isolates *rows* but shares CPU/cache/disk — pair with per-tenant resource quotas to prevent noisy-neighbor.
- Derive `tenant_id` from the authenticated principal/server context, **never** from a client-supplied parameter.

## IDOR / BOLA (OWASP API #1)

Broken Object Level Authorization = the API authenticates the user but **fails to verify the user owns/may access the specific object**. Changing an `id` in the URL/body reaches someone else's resource.

- ⛔ **Obscure/random IDs (UUIDv4) are NOT authorization.** They raise enumeration cost but the object is still served to anyone who learns the id (leaked in lists, logs, referrals, incrementable siblings).
- ✅ **Every endpoint performs an object-level check**: `if (principal cannot access resource) → 403/404`. Do it server-side, every request, no exceptions.
- Centralize the check (middleware / PDP) so no handler can forget it.
- Defense in depth: rate-limit to slow enumeration, audit-log access patterns.

## Enforcement Architecture — PEP / PDP / PAP

- **PEP** (Policy Enforcement Point): per-request guard (gateway / middleware) that *asks* and *enforces*.
- **PDP** (Policy Decision Point): evaluates policy, returns allow/deny — centralized engine.
- **PAP** (Policy Admin Point): where policies are authored/stored/versioned.

**Separate decision from enforcement.** Inline `if`-checks scattered in business code are the root cause of inconsistent authz. Introduce a policy engine (Open Policy Agent / Rego, AWS Cedar / Verified Permissions) when: multiple services must agree, policies change without redeploy, or relationships drive decisions (ReBAC). Keep authz logic out of business logic — externalize it as a single source of truth.

## Anti-Patterns

| Anti-pattern | Why it bites | Fix |
|--------------|--------------|-----|
| Over-privileged roles | One leaked account → broad blast radius | Least privilege + periodic access review |
| Hardcoded authz scattered in handlers | One forgotten check = vuln; inconsistent across services | Centralize via PEP→PDP |
| Inconsistent enforcement across endpoints | Attacker finds the one unguarded path | Single policy engine all services call |
| Confused deputy | High-priv service tricked by low-priv caller | Push checks to the lowest trust boundary; just-in-time access |
| Obscure-ID-as-security | BOLA despite "unguessable" ids | Mandatory server-side object-level check |
| Role explosion | Hundreds of unmaintainable roles | ABAC conditions / ReBAC relationships instead of new roles |

## Checklist

- [ ] Authorization model chosen and justified (RBAC / ABAC / ReBAC / hybrid)
- [ ] Access Control Matrix defined; least privilege is the default
- [ ] Every endpoint has an object-level authorization check (no IDOR/BOLA)
- [ ] Authz decision separated from business logic (PEP → PDP)
- [ ] Multi-tenant: every query filters tenant_id from server-derived context; isolation level chosen
- [ ] No reliance on obscure IDs as access control
- [ ] Policies versioned and auditable

## [EVIDENCE]
- [S] https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/ — "API1:2023 Broken Object Level Authorization"; #1 API risk; exploited by manipulating the object ID in the request.
- [S] https://csrc.nist.gov/projects/role-based-access-control — NIST RBAC, standard **INCITS 359**; users assigned roles, roles assigned privileges.
- [A] https://authzed.com/learn/google-zanzibar — Google Zanzibar ReBAC: relationship tuples drive checks; designed for collaboration/sharing at scale.
- [S] https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/best-practices.html — AWS: offload authz to a PDP (OPA / Amazon Verified Permissions); separate enforcement from decision.
- [A] https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html — OWASP Authorization Cheat Sheet: enforce least privilege, deny by default, centralize access control.
- [C] https://www.cerbos.dev/blog/authorization-failure-patterns — Real breaches (Facebook 2018, Okta 2023, Microsoft 2024) trace to UI-coupled/over-privileged authz; externalize as SSOT.

**[CONFIDENCE]** HIGH — model selection and BOLA/multi-tenant guidance corroborated by OWASP (S), NIST (S), AWS (S); engine-selection nuance is B/C tier.
