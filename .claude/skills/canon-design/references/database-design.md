# Database Design Reference

## Naming Conventions

| Element | Style | Pattern | Examples |
|---------|-------|---------|----------|
| Tables | snake_case, plural | — | `users`, `order_items` |
| Columns | snake_case | — | `first_name`, `created_at` |
| PK | `id` | UUID or BIGINT | not `user_id` in users table |
| FK | `{table_singular}_id` | — | `user_id`, `order_id` |
| Timestamps | — | Always include | `created_at`, `updated_at`, `deleted_at` (soft delete) |
| Booleans | `is_/has_/can_/should_` | — | `is_active`, `has_verified_email` |

## ID Type Selection

| Type | Use When | Trade-off |
|------|----------|-----------|
| UUID | Distributed systems, security-sensitive | Larger, slower index, not sortable |
| BIGINT auto | Single DB, internal IDs | Predictable, requires coordination |
| ULID | Need sortable + unique | Larger than bigint |

## Data Type Quick Rules

- Money: `decimal(p,s)` — **never float**
- Timestamps: **always with time zone**
- JSON: `jsonb` for queried data, avoid for core relational data
- Strings: `varchar(n)` for known max, `text` for variable

## Index Design Rules

1. **Query-driven**: Create based on actual queries / EXPLAIN plans
2. **Selectivity**: High selectivity = effective (email > status > boolean)
3. **Composite order**: Equality first, then range — `INDEX(status, created_at)` not reverse
4. **Covering index**: `INCLUDE` columns to enable index-only scan
5. **Partial index**: `WHERE is_active = true` for subset indexing
6. **Always index FKs**

## Zero-Downtime Migration Steps

| Operation | Steps |
|-----------|-------|
| Add column | 1. Add nullable/default → 2. Deploy writes → 3. Backfill → 4. Add NOT NULL |
| Remove column | 1. Stop reading → 2. Stop writing → 3. Drop |
| Rename column | 1. Add new → 2. Dual-write → 3. Backfill → 4. Switch reads → 5. Drop old |
| Change type | 1. Add new col → 2. Dual-write → 3. Convert → 4. Switch reads → 5. Drop old |

## Performance Patterns

- **N+1**: Use `include`/eager loading, never loop queries
- **Select only needed**: Use `select` to avoid `SELECT *`
- **Cursor pagination**: Preferred for large datasets
- **Connection pooling**: Use PgBouncer or Prisma Data Proxy for serverless
- **Caching**: Cache-aside with Redis, invalidate on write (TTL or event-based)

## Checklist

- [ ] Naming conventions followed
- [ ] PK type decided (UUID vs BIGINT)
- [ ] All FKs have indexes
- [ ] Timestamps included (created_at, updated_at)
- [ ] Indexes planned for common queries
- [ ] Composite index column order correct
- [ ] Cascade delete rules appropriate
- [ ] Migration strategy for zero-downtime
