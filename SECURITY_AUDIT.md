# Voxium Security Audit

**Date:** 2026-03-06  
**Auditor:** Senior Application Security Engineer (automated)  
**Branch:** `copilot/securityaudit-fixes-again`  
**Scope:** Full codebase — backend (`apps/server`), frontend (`apps/desktop`), infrastructure (`Dockerfile`, `docker-compose.production.yml`)

---

## 1. Threat Model Summary

### What Is This Application?
Voxium is a Discord-alternative: real-time voice and text chat, WebRTC P2P voice, S3-backed file uploads, TOTP-based 2FA, JWT authentication with refresh tokens, and a two-tier admin dashboard. It is deployed as a containerised Node.js service behind a reverse proxy (production) or run locally in development.

### Attack Surface
| Entry Point | Notes |
|---|---|
| `POST /api/v1/auth/*` | Registration, login, password reset, TOTP — all rate-limited |
| `GET/POST /api/v1/*` (authenticated API) | ~20 routers; protected by JWT `authenticate` middleware |
| `GET /api/v1/admin/*` | Restricted to `admin`/`superadmin` roles via `requireAdmin` |
| `GET /health` | Unauthenticated; intentional for uptime monitoring |
| WebSocket (`socket.io`) | JWT-authenticated on handshake; per-event rate limiting |
| S3 presigned URLs | Direct client-to-S3 upload; keys validated server-side |
| SMTP (outbound only) | Password reset emails; no inbound attack surface |

### Where Untrusted Data Enters
1. **HTTP request body** → validated by shared `validateUsername/validatePassword/validateEmail`, `sanitizeText`, and schema checks before DB writes.
2. **HTTP query parameters** → used for pagination (`limit`, `before`, `page`), search (`q`), and admin filters — all range-clamped or validated.
3. **WebSocket event payloads** → rate-limited; channel/DM join events include ownership checks before room join.
4. **JWT claims** → verified via `jsonwebtoken.verify()` on every request; `tokenVersion` and `bannedAt` re-checked against DB.

### Existing Security Controls
- bcrypt (cost 12) for password hashing
- JWT access tokens (15 min) + refresh tokens (7–30 days) with `tokenVersion` invalidation on password change / ban
- TOTP (HOTP-SHA1) with AES-256-GCM encrypted secrets at rest; backup codes hashed with bcrypt
- Per-endpoint Redis-backed rate limiting (login: 5/min/IP, register: 3/min/IP, etc.)
- Helmet middleware: HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy
- CORS restricted to configured origins (`CORS_ORIGIN` env var)
- `trust proxy 1` + IP normalisation for correct client IP behind reverse proxies
- Input sanitization via `sanitizeText` (HTML-strip + trim)
- Non-root Docker image; multi-stage build; no secrets baked in
- Production error handler: no stack traces, generic 500 message

### Deployment Model
Docker + PostgreSQL + Redis, expected behind nginx with TLS. All secrets injected via environment variables. The `Dockerfile` explicitly notes "NO secrets in image."

---

## 2. Executive Summary

Voxium has a strong security baseline: authentication is well-implemented (bcrypt-12, tokenVersion invalidation, TOTP with encrypted secrets, rate-limited auth endpoints), all sensitive API routes are protected by JWT middleware, and no hardcoded secrets were found anywhere in the codebase. The three confirmed findings are **medium and low severity**: the health check endpoint leaks internal error messages to unauthenticated callers, four `$queryRawUnsafe` calls use a weakly-typed raw-query API (though the SQL strings are static and parameters are bound), and SMTP lacks configurable TLS enforcement. All three have been fixed on this branch. The most important remaining action is ensuring strong, high-entropy values are used for `JWT_SECRET`, `JWT_REFRESH_SECRET`, and `TOTP_ENCRYPTION_KEY` in every deployed environment.

---

## 3. Findings Table

| # | Severity | Confidence | Finding | File(s) | Status | Fix Commit |
|---|---|---|---|---|---|---|
| 1 | Medium | Confirmed | Health endpoint leaks `err.message` without auth | `app.ts:84,96` | ✅ Fixed | see PR |
| 2 | Medium | Confirmed | `$queryRawUnsafe` — weaker typing; use `$queryRaw`+`Prisma.sql` | `socketServer.ts:274,313` `admin.ts:774,797` | ✅ Fixed | see PR |
| 3 | Low | Confirmed | SMTP connection not TLS-enforced | `utils/email.ts:6` | ✅ Fixed | see PR |
| 4 | Low | Possible | `JWT_SECRET` entropy not validated at startup | `index.ts` | ⚠️ Needs review | — |
| 5 | Low | Confirmed | CSP `styleSrc` includes `'unsafe-inline'` | `app.ts:42` | 📋 Document only | — |

---

## 4. Detailed Findings

---

### [MEDIUM] Finding 1 — Health Endpoint Leaks Raw Error Messages

**File(s):** `apps/server/src/app.ts:84,96`  
**Code (before fix):**
```ts
} catch (err: any) {
  checks.database = { status: 'error', latency: Date.now() - dbStart, error: err.message };
  healthy = false;
}
// …
} catch (err: any) {
  checks.redis = { status: 'error', latency: Date.now() - redisStart, error: err.message };
  healthy = false;
}
```
**Confidence:** Confirmed  
**Status:** ✅ Fixed  
**Category:** Tier 3 — Error Handling / Information Disclosure

**What's wrong:** The `/health` endpoint is unauthenticated (intentionally, for uptime probes) and returns raw `err.message` from database/Redis connection failures. PostgreSQL/Redis error messages can include the connection string (containing hostname, port, and potentially credentials), internal hostnames, or driver-version strings.

**Attack scenario:**
1. Attacker forces a DB connection failure (e.g., network disruption, or the DB is simply unreachable at startup).
2. `GET /health` responds 503 with `{ checks: { database: { error: "connect ECONNREFUSED 10.0.0.5:5432" } } }`.
3. Attacker learns internal IP addresses, port layout, or database type/version.

**Root cause:** Convenience — same `err.message` path used in both development (where verbose messages are helpful) and production.

**Fix applied:**
```ts
// Before
checks.database = { status: 'error', latency: Date.now() - dbStart, error: err.message };

// After
const errMsg = process.env.NODE_ENV === 'production' ? 'connection failed' : (err.message as string);
checks.database = { status: 'error', latency: Date.now() - dbStart, error: errMsg };
```
Full error is still logged server-side via the existing `console.error`.

**Why the fix works:** In production, the error message is replaced with the generic string `'connection failed'`, revealing no internal topology. Development behaviour is unchanged.

**New dependencies or env vars introduced:** None.

---

### [MEDIUM] Finding 2 — `$queryRawUnsafe` Should Be `$queryRaw` + `Prisma.sql`

**File(s):**
- `apps/server/src/websocket/socketServer.ts:274,313`
- `apps/server/src/routes/admin.ts:774,797`

**Code (before fix, representative example):**
```ts
const unreads = await prisma.$queryRawUnsafe<
  Array<{ channel_id: string; server_id: string; cnt: bigint }>
>(
  `SELECT c.id AS channel_id, c.server_id, COUNT(m.id) AS cnt
   …
   WHERE c.id = ANY($2::text[])
   …`,
  userId,
  textChannelIds
);
```
**Confidence:** Confirmed  
**Status:** ✅ Fixed  
**Category:** Tier 1 — Injection (defence-in-depth)

**What's wrong:** `$queryRawUnsafe` accepts a plain string as the SQL template. Although in all four cases the SQL string is a hardcoded constant (no user-controlled string interpolation), the `Unsafe` API makes it possible for a future maintainer to accidentally introduce a SQL injection by changing `$1` to a template literal expression. `$queryRaw` + `Prisma.sql` enforces parameterisation at the type level and makes intent explicit.

**Attack scenario (current):** Not directly exploitable — all SQL strings are static constants. Risk is introduced if a maintainer later refactors these into string concatenations while following the `$queryRawUnsafe` pattern.

**Root cause:** The ORM-level distinction between safe and unsafe raw queries was not exploited; `$queryRawUnsafe` was used everywhere as a convenience.

**Fix applied:**
```ts
// After — socketServer.ts
import { Prisma } from '@prisma/client';
// …
const unreads = await prisma.$queryRaw<Array<{ channel_id: string; server_id: string; cnt: bigint }>>(
  Prisma.sql`SELECT c.id AS channel_id, c.server_id, COUNT(m.id) AS cnt
   FROM channels c
   LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ${userId}
   …
   WHERE c.id = ANY(${textChannelIds}::text[])
   …`
);

// After — admin.ts
const signups = await prisma.$queryRaw<Array<{ day: string; count: bigint }>>(
  Prisma.sql`SELECT DATE(created_at) AS day, COUNT(*) AS count
  FROM users
  WHERE created_at >= ${since}
  GROUP BY DATE(created_at)
  ORDER BY day ASC`
);
```

**Why the fix works:** `Prisma.sql` is a tagged-template function that converts each interpolated value into a bound parameter. The TypeScript type system then rejects any attempt to pass a plain string to `$queryRaw`, preventing accidental injection paths.

**New dependencies or env vars introduced:** `Prisma` namespace imported from `@prisma/client` (already a direct dependency; no new package needed).

---

### [LOW] Finding 3 — SMTP Connection Not TLS-Enforced

**File(s):** `apps/server/src/utils/email.ts:6`  
**Code (before fix):**
```ts
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '1025', 10),
  secure: false,   // ← always false; no STARTTLS requirement
  …
});
```
**Confidence:** Confirmed  
**Status:** ✅ Fixed  
**Category:** Tier 2 — Cryptography / TLS configuration

**What's wrong:** `secure: false` means Nodemailer does not request TLS. If `requireTLS` is also not set (it wasn't), the connection proceeds in plaintext even if the mail server offers STARTTLS. Password-reset tokens are transmitted unencrypted over the network.

**Attack scenario:**
1. Attacker is on-path between the Voxium server and the configured SMTP relay (internal network, VPS provider, or DNS/BGP hijack).
2. Attacker performs a STARTTLS stripping attack or passively sniffs the SMTP session.
3. Password-reset tokens in the email body are captured; attacker resets any user's password.

**Root cause:** `secure: false` is the Nodemailer default for local dev (MailHog on port 1025). The same value was retained for production.

**Fix applied:**
```ts
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '1025', 10),
  secure: process.env.SMTP_SECURE === 'true',
  requireTLS: process.env.SMTP_SECURE !== 'true' && process.env.SMTP_REQUIRE_TLS === 'true',
  …
});
```
The production example (`.env.production.example`) is updated to set `SMTP_REQUIRE_TLS=true` for port 587 (STARTTLS).

**Why the fix works:** When `SMTP_REQUIRE_TLS=true`, Nodemailer refuses to proceed if the server does not offer STARTTLS, preventing silent plaintext fallback. For implicit TLS (port 465), set `SMTP_SECURE=true` instead.

**New dependencies or env vars introduced:**
| Variable | Description | Example | Config location |
|---|---|---|---|
| `SMTP_SECURE` | `true` for implicit TLS (port 465). Default: `false` | `false` | `.env` / cloud secrets |
| `SMTP_REQUIRE_TLS` | `true` to enforce STARTTLS (port 587). Default: `false` | `true` | `.env` / cloud secrets |

---

### [LOW] Finding 4 — JWT Secret Entropy Not Validated at Startup

**File(s):** `apps/server/src/index.ts` (startup checks)  
**Confidence:** Possible  
**Status:** ⚠️ Needs review  
**Category:** Tier 1 — Secrets & Credential Management

**What's wrong:** `index.ts` checks that `JWT_SECRET` and `JWT_REFRESH_SECRET` are present (non-empty), but does not validate their entropy. The `.env.example` ships with placeholder values like `"change-me-to-a-random-secret-at-least-32-chars"` that are short and predictable. Guessing or brute-forcing a weak secret would allow an attacker to forge arbitrary JWTs.

**Attack scenario:**
1. Operator copies `.env.example` without changing the placeholder values.
2. Attacker knows or guesses the placeholder secret.
3. Attacker forges a JWT with any `userId` and `role: 'superadmin'`, achieving full admin access.

**Root cause:** No enforcement beyond presence check.

**Suggested fix (not applied — requires deciding on minimum entropy policy):**
```ts
// In index.ts startup checks
const JWT_SECRET = process.env.JWT_SECRET!;
if (JWT_SECRET.length < 32 || JWT_SECRET.startsWith('change-me')) {
  console.error('FATAL: JWT_SECRET is too weak or is still set to the placeholder value.');
  process.exit(1);
}
```
Alternatively, validate using `Buffer.byteLength(JWT_SECRET, 'utf8') >= 32`.

---

### [LOW] Finding 5 — CSP Allows `unsafe-inline` for Styles

**File(s):** `apps/server/src/app.ts:42`  
**Code:**
```ts
styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
```
**Confidence:** Confirmed  
**Status:** 📋 Document only  
**Category:** Tier 3 — HTTP Security Configuration / CSP

**What's wrong:** `'unsafe-inline'` in `styleSrc` allows any inline `<style>` tag or `style=` attribute. While this does not directly enable JavaScript execution, it can be used in CSS-based data exfiltration attacks (attribute selectors stealing CSRF tokens or sensitive input values) and weakens the CSP's defence-in-depth posture.

**Why not fixed:** Tailwind CSS and many React UI libraries generate inline styles at runtime. Removing `'unsafe-inline'` would likely break significant portions of the UI and requires a dedicated CSS migration effort (nonces or hashes per inline rule) that is out of scope for this audit.

**Recommendation:** Long-term, migrate to CSS-in-class-only patterns and remove `'unsafe-inline'`. In the short term, the risk is low because `scriptSrc` does NOT allow `'unsafe-inline'`, limiting the impact to CSS-only injection vectors which require a stored-XSS entry point that does not currently exist in the codebase.

---

## 5. Fix Plan for Remaining Issues

### Quick Wins (< 1 day)
- **Finding 4 (JWT entropy):** Add a 10-line startup check that validates `JWT_SECRET` and `JWT_REFRESH_SECRET` are ≥ 32 bytes and do not match known placeholder strings. No new dependencies required.

### Strategic Fixes
- **Finding 5 (CSP `unsafe-inline`):** Requires a UI audit to identify all inline style sources. Tailwind JIT, any `style=` props, and emotion/styled-components all need to be catalogued. Estimated effort: 2–5 days depending on UI codebase size. Migration path: use a CSP nonce (injected per-request from the server) for any remaining necessary inline styles.

---

## 6. Environment Variables Added

| Variable | Description | Example | Where to configure |
|---|---|---|---|
| `SMTP_SECURE` | `true` for implicit TLS (port 465). Leave `false` for STARTTLS (port 587) or local dev. | `false` | `.env` / `.env.production` |
| `SMTP_REQUIRE_TLS` | `true` to mandate STARTTLS upgrade before sending (port 587). Prevents silent plaintext fallback. | `true` | `.env` / `.env.production` |

---

## 7. Secure Areas

The following Tier 1 and Tier 2 areas were audited and found to have no issues:

**Authentication — Password Storage**  
bcrypt with cost factor 12 (`authService.ts`). Cost 12 is above the current OWASP minimum recommendation of 10 and is appropriate for a production service. ✅

**Authentication — JWT Implementation**  
HS256 with separate `JWT_SECRET` / `JWT_REFRESH_SECRET` env vars, 15-minute access token expiry, 7–30 day refresh depending on `rememberMe`, `tokenVersion` field that increments on every password change and account ban, meaning all previously issued tokens are immediately invalidated. The `authenticate` middleware re-fetches `tokenVersion` and `bannedAt` from the DB on every request (not just from the JWT). ✅

**Authentication — TOTP / 2FA**  
TOTP secrets encrypted at rest with AES-256-GCM (random IV per secret, authenticated ciphertext). Backup codes are one-time-use and hashed with bcrypt. The backup-code consumption path uses `updateMany` with an optimistic-concurrency `where` clause to prevent concurrent reuse. Trusted device tokens include `tokenVersion` so password changes invalidate them. ✅

**Authorization — Admin Route Protection**  
All routes under `/api/v1/admin` are protected by `authenticate` → `requireAdmin` middleware chain applied at the router level (`adminRouter.use(...)`), not per-route. Superadmin-only routes add `requireSuperAdmin`. Role is read from the DB on every request, not from the JWT, so privilege changes take effect immediately. ✅

**Authorization — IDOR Checks**  
Every route that operates on a resource owned by another user includes an explicit ownership / membership check before the DB mutation. Example: message routes verify `serverMember` presence before returning/editing messages; DM routes verify conversation participation; S3 avatar keys include `userId` in the path and the server validates the prefix before accepting them. ✅

**Injection — SQL**  
All Prisma ORM queries use the safe query builder API. The four `$queryRawUnsafe` calls identified in this audit had static SQL strings with bound parameters (not exploitable), and have been converted to `$queryRaw` + `Prisma.sql` as part of this audit. ✅ (after fix)

**Injection — NoSQL / Command / Template**  
No NoSQL database, no shell commands, no user-controlled template strings found in the codebase. ✅

**Secrets — Hardcoded Values**  
No hardcoded secrets found anywhere in source code, config files, CI/CD workflows, Dockerfiles, or migration files. All secrets are read from environment variables. The Dockerfile explicitly documents that the image contains no secrets. ✅

**Rate Limiting**  
All authentication endpoints (login, register, forgot-password, reset-password, refresh, change-password, TOTP) have individual Redis-backed rate limiters with IP-based or user-based keys and block durations. Rates are configurable at runtime via the admin dashboard without redeployment. General API rate limit (100 req/min/IP) provides a backstop. Socket events are rate-limited per-socket per-event via `socketRateLimit`. ✅

**Infrastructure — Docker**  
Multi-stage build, production image runs as non-root user `voxium` (UID 1001), no secrets baked into layers, OpenSSL and CA certificates installed explicitly. ✅
