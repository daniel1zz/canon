# Idempotency Design Reference

> Cross-cutting concern. Idempotent = executing the same operation N times leaves the same server state as once. Inject when a design has writes over unreliable transport, client retries, at-least-once message delivery, or exactly-once business needs (payments, orders). Pairs with `error-handling.md` (retry) and the Outbox pattern in `architecture-patterns.md`.

## When Idempotency Is Required

- **Writes over unreliable transport** — request times out but the server may have already executed; the client retry must not double-apply.
- **Client retry policies** — backoff retries are standard; a non-idempotent write causes double charges / duplicate rows.
- **At-least-once message delivery** — Kafka/RabbitMQ/SQS may redeliver; consumers **must** be idempotent.
- **Payments / orders** — zero tolerance for duplicates; idempotency is the mechanism behind "logically exactly-once".

> **Truth**: true exactly-once is unattainable in distributed systems. Achieve **effectively-once** = at-least-once delivery + idempotent consumption + dedup store.

## Idempotency Key Pattern (Stripe-style)

1. **Client generates the key** — UUIDv4 / 256-bit random. ⛔ Not a hash of business fields (PII leak, collisions, drift).
2. **Server stores atomically** — `(key, status, result)`; concurrent same-key requests resolved by `INSERT ... ON CONFLICT` / Redis `SET NX` so exactly one wins.
3. **Replay returns the first result** — including the original status code (even a 500).

| Parameter | Guidance |
|-----------|----------|
| Key scope | Composite `(account_id/user_id, key)` — prevent cross-tenant collisions |
| TTL / dedup window | ≥ max client retry window; Stripe ≈ 24h; typically 24–72h |
| Concurrency | Atomic op only — never check-then-act; use unique constraint or distributed lock |
| Length | Cap it (Stripe: 255 chars) |

## Delivery Semantics

| Semantic | Behavior | Note |
|----------|----------|------|
| at-most-once | May be lost, never duplicated | Unsafe for reliability |
| at-least-once | May duplicate, never lost | Default for most brokers |
| effectively-once | End-to-end result == single delivery | at-least-once **+ idempotent consumer + dedup** |

Brokers guarantee delivery; the **application (consumer) achieves effectively-once** via idempotent handling and a dedup store.

## Deduplication Strategies

| Strategy | Store | TTL | Concurrency | Use when |
|----------|-------|-----|-------------|----------|
| Dedup table | SQL unique constraint | column TTL / reaper | atomic INSERT | payments, orders |
| Redis set | hash + `EX` | auto-expire | `SET NX` | high-throughput API |
| Inbox pattern | event table + `message_id` | column TTL | tx isolation | event-driven microservices |
| Outbox pattern | local-tx with business write | async poller cleanup | tx commit | cross-service consistency |

- **Outbox** (producer side): business write + outbound event in **one transaction** → no lost events; async poller publishes.
- **Inbox** (consumer side): record `message_id` before processing; duplicate arrivals hit the unique constraint and short-circuit.
- Producer Outbox + consumer Inbox + idempotent handlers = end-to-end effectively-once.

## HTTP Method Idempotency (RFC 9110 §9.2.2)

| Method | Idempotent | Safe | Note |
|--------|-----------|------|------|
| GET / HEAD / OPTIONS | ✓ | ✓ | no side effects |
| PUT | ✓ | ✗ | repeated call → same final state |
| DELETE | ✓ | ✗ | deleting an already-deleted resource is still idempotent |
| POST | ✗ | ✗ | each call creates a new resource |
| PATCH | ✗ | ✗ | not idempotent in general |

Idempotency is about **server state**, not identical response codes (DELETE returning 204 then 404 is still idempotent). **POST needs an application-level idempotency key** — the HTTP method alone won't save you.

## Conditional Updates / Optimistic Locking

```sql
UPDATE accounts SET balance = balance - 100, version = version + 1
WHERE account_id = '123' AND version = 5;   -- applies only if unchanged
```
- A three-state record (`IN_PROGRESS` → 409 for concurrent dup; `COMPLETED` → return stored result; `FAILED` → return stored error) makes replays deterministic.
- Optimistic locking *detects* conflict (raises on mismatch); idempotency *absorbs* repeats (no error). They compose — not substitutes.

## Anti-Patterns

| Anti-pattern | Why it bites | Fix |
|--------------|--------------|-----|
| Business field as key (email hash) | PII leak, collisions, drift on minor edits | Client-generated UUIDv4 |
| No-TTL dedup table | Unbounded growth → slow → OOM | TTL 24–72h + reaper |
| Check-then-insert | Race window double-executes | Atomic `ON CONFLICT` / `SET NX` |
| Un-scoped key | User A's key collides with User B's | Composite `(account_id, key)` |
| Retry after key expired | TTL gap → second charge | Retry window ≤ TTL, or persistent dedup + unique business constraint |

## Checklist

- [ ] Operations needing idempotency identified (writes, retries, queue consumers, payments)
- [ ] Idempotency key: client-generated, scoped, TTL ≥ retry window
- [ ] Concurrent same-key handled atomically (unique constraint / SET NX)
- [ ] Delivery semantics chosen; effectively-once = at-least-once + idempotent consumer
- [ ] Dedup strategy selected (table / Redis / Inbox / Outbox)
- [ ] POST writes use an idempotency key (don't rely on HTTP method)
- [ ] Conditional/optimistic update guards against duplicate side effects

## [EVIDENCE]
- [S] https://www.rfc-editor.org/rfc/rfc9110.html — **RFC 9110** HTTP Semantics §9.2.2 Idempotent Methods: GET/HEAD/PUT/DELETE/OPTIONS idempotent; POST/PATCH not.
- [S] https://docs.stripe.com/api/idempotent_requests — Stripe: client-supplied `Idempotency-Key`, stored result replay, ~24h retention, concurrency handling.
- [C] https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/ — AWS Builders' Library: at-least-once + idempotent APIs make retries safe.
- [C] https://brandur.org/idempotency-keys — Stripe-like idempotency keys in Postgres: three-state model, recovery points, reaper.
- [C] https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/ — Confluent: idempotent producer + transactional writes + idempotent consumer → effectively-once.
- [C] https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/ — Outbox/Inbox patterns and at-least-once delivery.

**[CONFIDENCE]** HIGH — RFC 9110 method semantics verified; key pattern and effectively-once corroborated by Stripe (S), AWS/Confluent (C). Specific TTL values are vendor guidance, not spec.
