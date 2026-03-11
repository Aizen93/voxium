# Voxium - Project Context

## Overview

**Voxium** is a modern, open-source voice and text communication platform — a Discord alternative. Monorepo with pnpm workspaces: Node.js/Express backend, React/Tauri 2 desktop client, standalone admin dashboard, and shared types package.

**Version:** 1.2.1
**Date:** 2026-03-11

## Project Structure

```
Voxium/
├── apps/
│   ├── server/           # Express API + Socket.IO + WebRTC signaling
│   ├── desktop/          # Tauri 2 + React 19 + Vite (cross-platform desktop)
│   └── admin/            # Standalone admin dashboard (React + Vite, port 8082)
├── packages/
│   └── shared/           # TypeScript types, validators, constants
├── docker-compose.yml    # PostgreSQL + Redis
└── CLAUDE.md             # Conventions and commands
```

## Key Features Implemented

- Real-time text messaging with editing, deletion, reactions, replies, search, @mentions with server-side autocomplete search + styled mention badges + mention highlight + distinct notification sound
- **mediasoup SFU voice** (server channels) + WebRTC P2P DM calls with global call status panel (visible from any view), push-to-talk, noise suppression, screen sharing, silence detection (producer pause/resume), voice quality selector (low/medium/high bitrate), adaptive bandwidth caps
- Server/channel/category management with drag-and-drop reordering
- JWT auth with refresh tokens, password reset, Remember Me
- S3 file uploads (avatars, server icons, message attachments) with presigned URLs; attachments proxied through server (S3 URL never exposed to client); `?inline` proxy for avatars/server-icons (used by notifications); 3-day retention with daily 4 AM cleanup job + email report; expired attachments show placeholder in chat
- Direct messages with typing indicators, reactions, unread tracking
- Friend request system with real-time notifications
- Unread indicators (channel + server level, persistent via DB)
- Two-tier admin dashboard (admin + superadmin roles) with user/server/ban management, storage tools (avatars/server-icons/attachments with top uploaders, file browser, orphan cleanup), live metrics, audit log, moderation queue (reports), support ticket management, rate limit controls, feature flags
- Admin user deletion with server ownership transfer
- Comprehensive security hardening: JWT algorithm pinning (`HS256`), token purpose validation, IDOR prevention on message routes, admin role hierarchy enforcement, email enumeration prevention, TOTP replay protection (Redis), bcrypt 72-byte input limit, Tauri CSP, socket payload runtime type validation, presigned URL content-type enforcement, trust proxy conditional, GitHub Actions injection prevention
- Rate limiting (per-endpoint + socket-level, admin-editable via Redis-backed registry) and input sanitization
- Feature flags (registration, invites, server creation, voice, DM voice, support) — Redis-backed, toggleable from admin dashboard without redeploying
- Per-server invite lock (owners/admins can lock/unlock invites independently of global flag)
- Tauri 2 desktop wrapper with native notifications (avatar support: WinRT circular icon on Windows, blob URL icon in browser)
- Support ticket system (one-per-user, real-time chat with staff, admin claim/close workflow)
- **Dynamic resource limits** — 3-tier resolution (per-server override > global config > hardcoded defaults) for max channels, voice users, categories, and members; admin UI for global + per-server management; read-only limits tab in server settings

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express, TypeScript, Prisma, PostgreSQL, Redis, Socket.IO |
| Frontend | React 19, Vite 6, Zustand, Tailwind CSS, Tauri 2 |
| Voice | mediasoup SFU (server), WebRTC P2P (DM), RNNoise WASM noise suppression |
| Storage | S3-compatible (presigned URL upload, proxy streaming for attachments) |
| Admin | React 19, Vite, Zustand (standalone app, port 8082) |

## Known Issues

- No duplicate report prevention (same user can submit multiple pending reports against the same target)
- Admin viewing an unclaimed support ticket does not receive real-time message updates (socket only joined to `support:{ticketId}` room upon claiming)

## Remaining Work

- [x] ~~mediasoup SFU for production-grade voice~~ (done — server voice channels use SFU)
- [x] ~~Comprehensive security audit & hardening~~ (done — JWT hardening, IDOR fixes, runtime validation, TOTP replay protection, etc.)
- [x] ~~Horizontal scaling foundation~~ (done — Socket.IO Redis adapter, Redis-based presence/DM voice state, multi-node test passing)
- [x] ~~@Mention system~~ (done — server-side search, styled badges, highlight, mention sound)
- [x] ~~Global DM call panel~~ (done — DMVoicePanel visible from any view)
- [ ] Mobile app (React Native)
- [ ] E2E encryption for DMs
- [ ] Prometheus + Grafana monitoring

## Recent Changes

- **Notification Avatars + Presence Cleanup** (2026-03-11) — 3-tier notification system with avatar support: (1) Windows WinRT toast with circular avatar via custom `notify_with_avatar` Tauri command + `ureq` download; (2) Tauri plugin fallback (text-only); (3) Web Notification API with pre-fetched blob URL via `?inline` S3 proxy. Added `?inline` query param to `GET /uploads/*` for direct image proxy (avoids S3 302 redirect CORS issues). Security hardened: Rust-side avatar key regex, magic byte validation, symlink detection, 1MB limit, forced Content-Type, nosniff. Fixed stale presence bug via `clearPresenceState()` on server startup/shutdown. Fixed `catch (s3Err: any)` → typed `unknown` cast.

- **Global DMVoicePanel** (2026-03-10) -- Persistent DM call status panel visible in both server and DM sidebar views, mirroring the server VoicePanel pattern.

- **@Mention System** (2026-03-10) — @mentions in server messages with autocomplete, styled mention badges, highlighted messages, distinct notification sound. No DB schema change; mentions parsed from content at query time.

- **Drag-and-Drop File Upload** (2026-03-09) — Added drag-and-drop file upload to MessageInput with visual drop zone overlay, extracted `processFiles` shared by file picker, paste, and drop handlers.

- **Comprehensive Security Hardening** (2026-03-09) — Multi-pass security audit and fixes across the entire backend: JWT algorithm pinning (`HS256`) on all `jwt.verify()` calls to prevent algorithm confusion; token purpose validation in HTTP auth middleware and Socket.IO auth to reject trusted-device/totp-verify tokens as access tokens; IDOR prevention on message edit/delete (channelId match + server membership verification); admin role hierarchy (admins cannot ban/delete peer admins); email enumeration prevention (generic conflict error on registration); TOTP replay protection via Redis `SET NX EX` with 90s TTL; presigned URL content-type enforcement via `signableHeaders`; bcrypt PASSWORD_MAX reduced to 72; runtime type validation on all Socket.IO event payloads (strings, booleans, objects); rate limiting on all previously unprotected endpoints (messages PATCH/DELETE, DM PATCH/DELETE, reactions, socket events); 64KB size limit on DM voice signal relay; trust proxy conditional (production only); Tauri CSP configured; GitHub Actions script injection fix; displayName sanitization on registration; TOTP_ENCRYPTION_KEY startup warning.

- **Socket Authorization Hardening** (2026-03-09) — `channel:join` now verifies server membership via DB query; `typing:start`/`typing:stop` check `socket.rooms.has()` before broadcasting.

- **Attachment Security Hardening + Admin Storage** (2026-03-08) — Switched attachment access from presigned URL redirects to server-side proxy streaming (S3 URL never reaches client). Added `expired` soft-delete flag to `MessageAttachment` — expired files show placeholder in chat UI instead of silently disappearing. Self-healing proxy auto-marks attachments as expired when S3 returns `NoSuchKey`. Daily 4 AM cleanup job expires attachments older than 3 days, sends email report to `CLEANUP_REPORT_EMAIL`. Admin storage dashboard extended: 5 stat cards (total, avatars, server-icons, attachments, orphaned), file browser with type/status filters (Active/Orphaned/Expired), top uploaders aggregated from S3 + DB (users and servers), context-aware delete messages. Image lightbox for in-app image viewing. Download notifications via toast. E2E rate limit fixture for per-test Redis clearing.

- **Attachment Security Audit** (2026-03-08) -- Read-only security review of file attachment system. Found 1 HIGH (JWT token leakage via query param), 5 MEDIUM (input validation gaps, no content-length enforcement, no presigned URL tracking, cleanup ordering), 4 LOW issues. No code changes; see CONTEXT_CHANGELOG.md for full findings.
- **File Attachments Review** (2026-03-08) -- Read-only review of message attachment feature. Found stale-index bug in `MessageInput.tsx` upload state management; see CONTEXT_CHANGELOG.md for details.
- **SFU Voice Optimization** (2026-03-08) — Silence detection pauses mediasoup producers when noise gate detects silence (70-94% bandwidth reduction in typical use). Voice quality selector (low 16kbps / medium 32kbps / high 64kbps) applied to SFU producer encoding + DM SDP. Recv transport capped at 1.5 Mbps for fair bandwidth distribution. All voice:join error paths now emit `voice:error` with user-facing messages. Eliminated `as any` lint warnings via typed `emitSpeaking()` helper. Review fixes: reconnect callback re-registration, screen-audio producer filtering, teardown callback consistency.

- **Dynamic Resource Limits** (2026-03-07) — 3-tier limit resolution system (per-server override > global config > hardcoded defaults) for max channels, voice users, categories, and members. `GlobalConfig` + `ServerLimits` Prisma models, `getEffectiveLimits()` utility, admin CRUD endpoints, admin UI with global editor + per-server modal, read-only Limits tab in server settings, enforcement in channel/category creation, voice join, and invite join.

- **mediasoup SFU Voice Architecture** (2026-03-07) — Replaced mesh P2P with mediasoup SFU for server voice channels. `mediasoupManager.ts` + `mediasoupConfig.ts` manage workers/routers/transports/producers/consumers. `voiceHandler.ts` rewritten for SFU signaling (create-transport, connect-transport, produce, consume). DM calls remain P2P. Load test script (`scripts/load-test-voice.ts`) for stress testing.

- **Feature Flags + Server Invite Lock** (2026-03-05) — Redis-backed global feature flag system with admin UI, plus per-server invite lock toggle for owners/admins.

- **Support Ticket System** (2026-03-05) — One-per-user support tickets with real-time chat, admin claim/close workflow, audit logging.

- **Reports/Moderation Queue + Staff Badge** (2026-03-05) — Report system, admin moderation queue, StaffBadge component for admin/superadmin users.

- **Admin Audit Log** (2026-03-05) — `AuditLog` model, fire-and-forget `logAuditEvent()`, admin UI page.

## Related Documents

- **`CLAUDE.md`** — Commands, conventions, architecture patterns, important invariants
- **`Architecture.md`** — Detailed system architecture, database design, scalability strategy
- **`CONTEXT_CHANGELOG.md`** — Full feature-by-feature development history with file changes and review notes
