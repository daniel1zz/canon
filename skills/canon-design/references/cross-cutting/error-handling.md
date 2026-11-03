# Error Handling Design Reference

> Cross-cutting concern. A unified, cross-layer error model — not per-handler ad-hoc try/catch. Inject when a design has cross-layer calls, external dependencies, or a public API. Aligns with the project rule: **no silent fallback, fail loud, never `catch { return null }`**.

## Error Classification

Classification drives handling strategy (status code, retry, log/response verbosity):

| Class | HTTP | Meaning | Strategy |
|-------|------|---------|----------|
| **User error** | 4xx | Expected, client can fix (bad input, unauthorized, not found) | Fail fast, return clear actionable message |
| **System error** | 5xx | Unexpected server fault (bug, dependency down) | Log full detail, return generic message, hide internals |
| **Transient** | 503/504/429 | Temporary (timeout, throttle, brief outage) | Retry with backoff — **only if the operation is idempotent** |

## Unified Error Model — RFC 9457 Problem Details

For HTTP APIs use **RFC 9457 Problem Details** (2023, obsoletes RFC 7807; backward-compatible). One consistent shape across the whole API:

```json
{
  "type": "https://api.example.com/errors/invalid-request",
  "title": "Invalid Request",
  "status": 400,
  "detail": "The 'email' field is required",
  "instance": "/orders/12345"
}
```

- `type` — stable URI identifying the error class (machine-readable anchor)
- `title` — short human label (fixed per type)
- `status` — HTTP status mirror (convenient for JSON-only clients)
- `detail` — request-specific context (dynamic, but **never** stack/SQL/internal paths)
- `instance` — request id / resource path for log correlation

## Error Code Catalog

Three layers per error:

| Layer | Field | Purpose | Example |
|-------|-------|---------|---------|
| Machine-readable | `code` (enum) | Client decision logic | `INVALID_ARGUMENT` |
| Human-readable | `message` | Developer debugging | `'age' must be ≥ 18` |
| Retry hint | `retryable` (bool) | Drives safe auto-retry | `false` |

- Code enums are a **backward-compatibility contract** — never change/remove values. Google AIP-193 defines a canonical set (`NOT_FOUND`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `UNAVAILABLE`, …).
- `message` may evolve freely; clients must **not** parse it.

## Propagation & Wrapping — Boundary Translation

- **Inner layers** (domain/data) throw specific, typed errors with full context.
- **Boundaries translate**: domain error → transport error at the edge (e.g. `NotFoundError` → HTTP 404 Problem Details). The outermost middleware is the single place that renders errors to the wire.
- **Wrap** when crossing an abstraction boundary, **preserving the cause chain**:
  - Python `raise X from err` · JS `new Error(msg, { cause: err })` · Go `fmt.Errorf("...: %w", err)`
- **Rethrow** within the same layer to keep the original stack.
- ⛔ Never swallow: no empty `catch`, no `return null` on failure — the caller cannot distinguish "no data" from "operation failed".

## Retry Semantics

- **Retryable**: `UNAVAILABLE` (503), `DEADLINE_EXCEEDED` (504), `RESOURCE_EXHAUSTED` (429) — **and only if the operation is idempotent** (see `idempotency.md`).
- **Not retryable**: `INVALID_ARGUMENT` (400), `UNAUTHENTICATED` (401), `PERMISSION_DENIED` (403) — fail fast.
- **Exponential backoff + jitter**: `delay = min(base · 2^attempt, max) + random(0, jitter)` — jitter prevents thundering-herd synchronization.
- **Retry budget + circuit breaker**: cap retries (≈2–3), and trip a breaker on aggregate failure rate to shed load and avoid cascading failure. Composition: Timeout → Retry → Circuit Breaker → Fallback.

## Information Leakage — Log vs Response Separation

| Detail | Log (internal) | Response (external) |
|--------|----------------|---------------------|
| Stack trace | ✓ full | ✗ never |
| SQL / queries | ✓ (parameterized) | ✗ never |
| Internal paths | ✓ | ✗ resource id only |
| Vendor/3rd-party error | ✓ | ✗ translated to generic code |
| Request id | ✓ | ✓ (for correlation) |

Error responses must not reveal architecture, framework versions, or DB type. Security checks **fail closed** (default deny).

## Anti-Patterns

| Anti-pattern | Why it bites | Fix |
|--------------|--------------|-----|
| `catch { return null }` | Caller can't tell "empty" from "failed"; silent corruption | Return explicit error/Result or throw |
| Exceptions as control flow | Slow, obscures intent | Conditionals or Option/Result types |
| Everything → 500 | Hides whether client or server is at fault | Map 4xx (client) vs 5xx (server) precisely |
| Catch-all that does nothing | No logs, no alerts, silent degradation | Handle at one explicit layer; propagate otherwise |
| Lost cause chain | Root cause untraceable | Preserve `cause`/`from`/`%w` |

## Checklist

- [ ] Errors classified: user (4xx) / system (5xx) / transient
- [ ] Unified error model (RFC 9457 Problem Details for HTTP APIs)
- [ ] Stable machine-readable code catalog + `retryable` flag
- [ ] Boundary translation defined; cause chain preserved; no swallowed errors
- [ ] Retry only idempotent + transient; backoff + jitter; retry budget / circuit breaker
- [ ] Responses leak no stack/SQL/internal detail; logs keep full context
- [ ] Security checks fail closed

## [EVIDENCE]
- [S] https://www.rfc-editor.org/rfc/rfc9457.html — **RFC 9457** Problem Details for HTTP APIs (2023); obsoletes **RFC 7807**; defines type/title/status/detail/instance.
- [S] https://google.aip.dev/193 — Google AIP-193 Errors: canonical error code set + `ErrorInfo`; codes are a stable contract.
- [A] https://owasp.org/www-community/Improper_Error_Handling — OWASP: error messages must not leak internals; fail closed.
- [A] https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html — OWASP Error Handling Cheat Sheet: separate detailed logs from generic responses.
- [C] https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/ — AWS Builders' Library: exponential backoff + jitter; retry only safe (idempotent) operations.
- [A] https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker — Azure Circuit Breaker pattern: prevent cascading failure.

**[CONFIDENCE]** HIGH — RFC 9457→7807 supersession verified; model and retry/leakage guidance from RFC (S), Google AIP (S), OWASP (A), AWS/Azure (C). Reinforces project's no-silent-fallback rule.
