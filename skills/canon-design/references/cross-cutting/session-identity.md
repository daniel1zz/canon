# Session & Identity Design Reference

> Cross-cutting concern. Covers how authenticated state is established, carried, refreshed, and revoked. Inject when a design has logged-in users, tokens, or any notion of "session".

## Authentication Mechanism Selection

| Mechanism | Decision rule | Best for | Trade-off |
|-----------|---------------|----------|-----------|
| **Server-side session + cookie** | Single domain, need instant revocation, high-assurance | Classic web apps, finance/health | Stateful — needs shared session store to scale horizontally |
| **Token-based (JWT / opaque)** | APIs, mobile, cross-domain, stateless scale | SPA + API, microservices, mobile | Revocation is harder; token handling on client |
| **Hybrid** | Want stateless verification + control | High-scale web with revocation needs | Short-lived JWT validated against a server-side session record |

## Token Type: JWT vs Opaque

| Dimension | JWT (self-contained) | Opaque (reference) |
|-----------|----------------------|--------------------|
| Revocation | Hard — valid until expiry unless blocklisted | Instant — delete from store |
| Verification | Local (no network round-trip) | Remote introspection call |
| Size | Larger (encoded claims) | Small (random reference) |
| Use when | High-throughput, offline/edge validation | Need immediate control, sensitive ops |

**Rule**: If you need instant revocation, prefer opaque tokens or server-side sessions. If you use JWT, you **must** pair it with short lifetimes + refresh rotation — a long-lived JWT you cannot revoke is the classic foot-gun.

## Session Lifecycle

- **Access token**: short-lived (≈5–15 min; shorter for sensitive ops). Carries authorization, validated on every request.
- **Refresh token**: longer-lived (≈days–weeks), used only to mint new access tokens. With rotation, an active user effectively stays signed in indefinitely.
- **Idle + absolute timeouts**: expire on inactivity *and* cap total session age regardless of activity.
- High-risk actions (change password, payment) → **re-authenticate** ("step-up"), don't rely on the existing session alone.

## Refresh Token Rotation + Reuse Detection

1. Each refresh issues a **new** refresh token and invalidates the old one (token *family*).
2. **Reuse detection**: if an already-used (rotated-out) refresh token is presented → assume theft → **revoke the entire family** + force re-auth.
3. Allow a small grace window (~seconds) for network races/retries.
4. ⛔ **Rotation without reuse detection gives no security benefit** — both are required together. RFC 9700 requires public clients to use rotation or sender-constrained tokens.

## Revocation & Logout

- Server-side session: delete the record → instant, fully controlled.
- JWT has **no native revocation**. Mitigations: (1) short lifetimes so expiry does the work; (2) a revocation/blocklist (e.g. Redis) checked per request — adds the statefulness JWT tried to avoid, so reserve for high-risk events; (3) rotate refresh tokens and revoke families.
- Provide **global logout** (revoke all sessions/families for a user) for "log out everywhere" and post-compromise response.

## Storage & Transport

- **Cookies**: `HttpOnly` (no JS read → mitigates XSS theft), `Secure` (HTTPS only), `SameSite=Lax` (CSRF defense; `Strict` can break OAuth redirects, `None` requires extra CSRF defense), narrow `Path`/`Domain`.
- **Client token placement**: access token in **memory** (lost on reload, unreadable by XSS); refresh token in **HttpOnly cookie**.
- ⛔ **Never store tokens in `localStorage`/`sessionStorage`** — any XSS reads them directly, and they get no CSRF protection.
- With session cookie + `SameSite=Lax`, traditional CSRF is largely neutralized; add CSRF tokens when `SameSite=None` is unavoidable.

## Anti-Patterns

| Anti-pattern | Why it bites | Fix |
|--------------|--------------|-----|
| JWT in localStorage | XSS-exfiltratable; no instant logout | Memory (access) + HttpOnly cookie (refresh) |
| OAuth 2.0 Implicit grant | Token exposed in URL fragment (RFC 9700 deprecates it) | Authorization Code + PKCE |
| Long-lived JWT, no blocklist | Stolen token usable for its full long life | Short access TTL + refresh rotation |
| Cookies missing HttpOnly/SameSite | XSS read + CSRF surface | Set all security attributes |
| Refresh rotation without reuse detection | False sense of security; stolen token reusable | Rotation **+** family revocation on reuse |

## Checklist

- [ ] Auth mechanism chosen (server session / token / hybrid) with revocation story
- [ ] Access token short-lived; refresh token rotated with reuse detection
- [ ] Idle + absolute session timeouts defined
- [ ] Step-up re-auth for high-risk actions
- [ ] Tokens in memory + HttpOnly cookie; never localStorage
- [ ] Cookies: HttpOnly, Secure, SameSite set
- [ ] Global "logout everywhere" / post-compromise revocation path exists

## [EVIDENCE]
- [A] https://datatracker.ietf.org/doc/html/rfc6749 — OAuth 2.0 Authorization Framework (**RFC 6749**).
- [A] https://datatracker.ietf.org/doc/html/rfc6750 — OAuth 2.0 Bearer Token Usage (**RFC 6750**).
- [A] https://datatracker.ietf.org/doc/html/rfc7519 — JSON Web Token (**RFC 7519**).
- [A] https://datatracker.ietf.org/doc/rfc9700/ — OAuth 2.0 Security Best Current Practice (**RFC 9700**): mandates refresh-token rotation or sender-constrained tokens for public clients; deprecates Implicit grant.
- [A] https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html — OWASP Session Management Cheat Sheet: cookie attributes, idle/absolute timeout, session-id handling.
- [B] https://developer.okta.com/docs/guides/refresh-tokens/main/ — Okta: refresh token rotation with reuse/replay detection and grace window.

**[CONFIDENCE]** HIGH — RFC numbers verified (6749/6750/7519/9700); rotation+reuse-detection and cookie/storage guidance from OWASP (A) and vendor BCP (B). Exact recommended TTL ranges vary by source/threat model (treat as guidance, not spec).
