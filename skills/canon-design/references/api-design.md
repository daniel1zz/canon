# API Design Reference

## REST Conventions

### Resource Naming
- Nouns, plural, kebab-case: `/user-profiles/{id}/posts`

### Pagination
- **Cursor-based** (recommended): `?cursor=abc&limit=20` → `{data, next_cursor, has_more}`
- **Offset-based** (simple): `?page=2&per_page=20` → `{data, page, total_pages, total_count}`
- Filtering: `?status=published&created_at[gte]=2024-01-01&q=keyword`
- Sorting: `?sort=-created_at,title` (prefix `-` = desc)
- Sparse fields: `?fields=id,title,author`

### Error Response Format (Project Standard)

```typescript
interface APIError {
  error: {
    code: string;           // VALIDATION_ERROR, NOT_FOUND, etc.
    message: string;        // Human-readable
    request_id?: string;    // For debugging
    details?: { field?: string; code: string; message: string }[];
  };
}
```

### Error Code Catalog

| Category | Codes |
|----------|-------|
| Auth | UNAUTHORIZED, INVALID_TOKEN, TOKEN_EXPIRED, FORBIDDEN, INSUFFICIENT_SCOPE |
| Validation | VALIDATION_ERROR, REQUIRED, INVALID_FORMAT, TOO_SHORT, TOO_LONG, OUT_OF_RANGE |
| Resource | NOT_FOUND, ALREADY_EXISTS, CONFLICT, GONE |
| Rate | RATE_LIMITED, QUOTA_EXCEEDED |
| Server | INTERNAL_ERROR, SERVICE_UNAVAILABLE, TIMEOUT |

## GraphQL Conventions

- Types: PascalCase, Fields: camelCase, Enums: SCREAMING_SNAKE_CASE
- Inputs: `{Type}Input`, Payloads: `{Type}Payload` (include both result + errors)
- Pagination: Relay connections (edges + pageInfo)
- N+1: Use DataLoader for batching

## API Key Format (Project Standard)

```
prefix_randomstring (32+ chars, cryptographically random)
  sk_live_  : Production secret
  sk_test_  : Test secret
  pk_live_  : Production public
  pk_test_  : Test public
```

Storage: hash before storing (bcrypt/argon2), never log full keys.

## JWT Token Design

- Access token: short-lived (15min), contains sub/email/role/iat/exp/iss/aud
- Refresh token: longer-lived (7 days), contains sub/jti(for revocation)/iat/exp/iss

## Versioning

Recommended: URL versioning for major (`/api/v1/`), additive changes within version, deprecate with sunset headers.

## Checklist

- [ ] Resources named correctly (nouns, plural, kebab-case)
- [ ] Error format follows project standard
- [ ] Auth method chosen, API key format if applicable
- [ ] Pagination approach selected (cursor preferred)
- [ ] Rate limiting planned
- [ ] OpenAPI/GraphQL schema complete
