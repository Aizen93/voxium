# Copilot Code Review Instructions

This file provides context for Copilot when reviewing PRs. It documents architecture decisions, conventions, and common patterns that should NOT be flagged as issues.

## Project Overview

Voxium is a Discord alternative — real-time voice and text communication platform. Monorepo with pnpm workspaces:

- **`apps/server`** — Node.js/Express 5 backend + Socket.IO + mediasoup SFU
- **`apps/desktop`** — React 19 + Vite + Tauri 2 desktop client
- **`apps/admin`** — React admin dashboard (separate app)
- **`packages/shared`** — TypeScript types, validators, and constants consumed by all apps

## Technology Stack & Versions

- **PostgreSQL 16** — `gen_random_uuid()` is built-in since PG 13. No `pgcrypto` extension needed.
- **Prisma 7** — Uses `prisma.config.ts` for datasource URL configuration, NOT the schema file. The `datasource db` block in `schema.prisma` intentionally omits `url` — this is correct for Prisma 7.
- **Express 5** — Async error handling built-in, no need for `express-async-errors`.
- **Tailwind 4** — Uses `@theme` block in `globals.css` with CSS custom properties. No `tailwind.config.js` needed for colors.
- **Tauri 2** — Desktop app uses WebView2 (Windows) / WebKit (macOS/Linux). CSP configured in `tauri.conf.json`.
- **mediasoup v3.19+** — Ships prebuilt worker binaries for linux-x64. No C++ build tools needed in Docker.

## Database & ORM

- Prisma 7 with driver adapter (`@prisma/adapter-pg`)
- Schema: `apps/server/prisma/schema.prisma`
- Config: `apps/server/prisma.config.ts` (datasource URL, seed config)
- Generated client: `apps/server/src/generated/prisma/client` (gitignored)
- Run Prisma commands from `apps/server/` directory
- Import `PrismaClient` from `../generated/prisma/client` (not `@prisma/client`)

## Authentication & Security

- **JWT** with `algorithms: ['HS256']` enforced on all `jwt.verify()` calls
- Auth middleware rejects tokens with a `purpose` field (prevents token reuse across flows)
- **Rate limiting**: `RateLimiterRedis` with `RateLimiterMemory` fallback, fail-open
- **Socket-level rate limiting**: `socketRateLimit(socket, event, maxPerMinute)`
- **Input sanitization**: All user text passes through `sanitizeText()` before DB storage
- **Email normalization**: `toLowerCase().trim()` on all email lookups
- **bcrypt 72-byte limit**: `PASSWORD_MAX` is 72 in shared constants
- **TOTP 2FA**: Secrets encrypted at rest (AES-256-GCM), replay protection via Redis SET NX
- **Privacy-first**: No third-party services (no Google STUN, no external TURN, no analytics, no CDNs)

## Socket.IO Patterns

- Room strategy: `server:{id}`, `channel:{id}`, `voice:{id}`, `dm:{id}`, `dm:voice:{id}`
- Channel rooms are auto-joined on connect and **never left** (for unread tracking)
- Socket handlers registered **synchronously** before any `await` in connection callback
- **Never emit `channel:leave`** — breaks `message:new` delivery
- Server-mutating API routes **must emit socket events** for real-time sync
- Frontend stores should NOT update local state from API response — socket event is sole source of truth

## Voice Architecture

- mediasoup SFU: each voice channel gets a Router (round-robin across Workers, 1 per CPU core, max 8)
- Each user: 2 transports (send+recv), 1 Producer, N Consumers
- DM calls: P2P WebRTC with Perfect Negotiation (polite/impolite via `localUserId < remoteUserId`)
- Server and DM voice are mutually exclusive
- Silence detection: Producer paused client+server-side on 300ms silence (mic only, not screen-share)

## Frontend Patterns

- **Zustand stores** (no providers, no Context)
- `authStore.updateProfile` merges partial API response to preserve fields not returned
- `dmStore` owns `clearMessages()` calls — UI components must NOT call `chatStore.clearMessages()` directly
- **Portaled popups**: `createPortal` to `document.body`, `position: fixed`, positioned via `getBoundingClientRect()`
- **Avatar component**: Always reset `imgError` when `avatarUrl` prop changes
- Theme colors via CSS custom properties (`--vox-*`) mapped through Tailwind `@theme` block
- `useMemo` is used for expensive derived data (member grouping, role sorting) — these are intentionally memoized

## Permissions System

- Bitmask permissions as BigInt strings
- `computeServerPermissions()` and `computeUserChannelPermissions()` verify membership
- Owner gets `ALL_PERMISSIONS`. Role hierarchy enforced on all mutations.
- Channel overrides cannot grant `ADMINISTRATOR`

## File Uploads & S3

- Store S3 keys in DB, not full URLs
- Attachments proxy through server (S3 URL never reaches client)
- `?inline` proxy mode for notifications and Tauri avatar downloads

## Build & Infrastructure

- After modifying `packages/shared`, run `pnpm build:shared` before consuming apps see changes
- After modifying `prisma/schema.prisma`, run `npx prisma generate` from `apps/server/`
- Pre-commit hook runs `pnpm typecheck` — errors must be fixed, never skipped with `--no-verify`
- Docker: uses `node-linker=hoisted` in `.npmrc` for pnpm compatibility
- mediasoup v3.19+ ships prebuilt workers — no C++ toolchain in Docker

## Conventions

- All Express route handlers use typed params: `Request<{ serverId: string }>` not bare `Request`
- Every new REST route needs a rate limiter
- Every new socket event needs `socketRateLimit()`
- All errors must be handled and logged — no empty catch blocks
- Never log sensitive data (passwords, tokens, TOTP secrets)
- Message queries must include `replyTo: { select: { id, content, author } }`
- Any code making a user a server member must also join their socket to `server:{id}` room and seed `ChannelRead` records

## Review Guidelines

When reviewing PRs, do NOT flag:
- Missing `url` in Prisma `datasource db` block (handled by `prisma.config.ts`)
- `gen_random_uuid()` usage in migrations (built-in since PostgreSQL 13)
- `useMemo`-wrapped O(n) lookups in React components (intentionally memoized)
- Type definitions that appear broad — check the actual interface fields before flagging type leaks
- Inline `style` props using `var(--vox-*)` CSS variables — this is the theme system's runtime switching mechanism

DO flag:
- Missing `disabled` attribute on buttons that show `cursor-not-allowed` styling
- Missing `aria-label` on icon-only buttons
- Docker `COPY` missing build artifacts needed at runtime
- Empty catch blocks or swallowed errors
- Missing rate limiters on new routes
- Missing `sanitizeText()` on user input before DB storage
- Socket events emitted without corresponding server-side mutations
- `jwt.verify()` calls without `algorithms: ['HS256']`
