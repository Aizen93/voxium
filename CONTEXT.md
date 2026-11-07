# Voxium - Project Context

## Overview

**Voxium** is a modern, source-available voice and text communication platform. Monorepo with pnpm workspaces: Node.js/Express backend, React/Tauri 2 desktop client, standalone admin dashboard, a shared types package, and a Rust/WASM end-to-end encryption engine.

**Version:** 2.0.0 (2.1.0 in preparation)
**Date:** 2026-10-27

## Project Structure

```
Voxium/
├── apps/
│   ├── server/           # Express API + Socket.IO + mediasoup SFU
│   ├── desktop/          # Tauri 2 + React 19 + Vite (cross-platform desktop)
│   └── admin/            # Standalone admin dashboard (React + Vite, port 8082)
├── packages/
│   ├── shared/           # TypeScript types, validators, constants
│   └── crypto-engine/    # Rust/WASM E2E engine (vodozemac), committed pkg/
├── docker-compose.yml    # Redis + coturn STUN server
└── CLAUDE.md             # Conventions and commands
```

## Key Features Implemented

- Real-time text messaging with editing, deletion, reactions, replies, search (a field in each chat header), @mentions with autocomplete search + styled mention badges + mention highlight + distinct notification sound; @everyone pings only when the server flagged the message and the author holds Mention Everyone
- **mediasoup SFU voice** (server channels) + WebRTC P2P DM calls with global call status panel (visible from any view), push-to-talk, noise suppression, screen sharing, silence detection (producer pause/resume), voice quality selector (low/medium/high bitrate), adaptive bandwidth caps
- Space/channel/category management with drag-and-drop reordering; categories show a heading over a rail down the left of their channels, with always-visible create controls
- **Spaces strip** — a 64 px bar across the top in two captioned zones: Messages (a labelled tab and the three most recent conversations as presence avatars) and Spaces (tabs, +N overflow, a dashed New space tab that opens the create-or-join dialog), with Find a space and Explore at the right end (icon-only below 1200 px). The Appearance setting 'Spaces strip' (`spacesStripMode`: pinned by default, or auto) folds it into a small notch under the title bar; a chamfered panel slides out on hover, focus, Ctrl+Shift+L or tap and folds after the pointer leaves or 1.5 s after a choice
- **Advanced permission system** — Bitmask roles with 22 permission flags (VIEW_CHANNEL, SEND_MESSAGES, MANAGE_CHANNELS, MANAGE_ROLES, KICK_MEMBERS, MUTE_MEMBERS, ATTACH_FILES, ADMINISTRATOR, etc.), role hierarchy enforcement (actors cannot modify roles at or above their position), channel-level permission overrides (allow/deny/inherit tri-state per role), @everyone default role per server with restricted defaults (no ATTACH_FILES, CREATE_INVITES, CHANGE_NICKNAME), permission calculator resolves @everyone base → OR all role permissions → channel overrides (ADMINISTRATOR bypasses everything), VIEW_CHANNEL enforcement on channel list filtering, message access, and socket auto-join, role CRUD + member role assignment + channel override management UI
- **Voice moderation** — server mute/deafen with Redis persistence (`voice:server_muted:{serverId}:{userId}`), re-applied on voice:join, cannot be self-bypassed, deafen implies mute (both server-side and client-side), cross-channel force-move, role hierarchy enforcement on moderation actions
- **Per-space nicknames** — `ServerMember.nickname` nullable field, CHANGE_NICKNAME permission for self-nickname, MANAGE_NICKNAMES for managing others, displayed in MemberSidebar, voice panel, and message author names (falls back to displayName)
- JWT auth with refresh tokens, password reset, Remember Me
- S3 file uploads (avatars, space icons, message attachments) with presigned URLs; attachments proxied through server (S3 URL never exposed to client); `?inline` proxy for avatars/server-icons (used by notifications); 3-day retention with daily 4 AM cleanup job + email report; expired attachments show placeholder in chat
- Direct messages with typing indicators, reactions, unread tracking
- Friend request system with real-time notifications
- Unread indicators (channel + server level, persistent via DB)
- Two-tier admin dashboard (admin + superadmin roles) with user/server/ban management, storage tools (avatars/server-icons/attachments with top uploaders, file browser, orphan cleanup), live metrics, audit log, moderation queue (reports), support ticket management, rate limit controls, feature flags
- Admin user deletion with server ownership transfer
- Comprehensive security hardening: JWT algorithm pinning (`HS256`), token purpose validation, IDOR prevention on message routes, admin role hierarchy enforcement, email enumeration prevention (generic registration errors + timing-safe password reset), email verification gate, TOTP replay protection (Redis), bcrypt 72-byte input limit, Tauri CSP, socket payload runtime type validation, presigned URL content-type enforcement, trust proxy conditional, GitHub Actions injection prevention
- Rate limiting (per-endpoint + socket-level, admin-editable via Redis-backed registry) and input sanitization
- Feature flags (registration, invites, space creation, voice, DM voice, support, space discovery, webhooks) — Redis-backed, toggleable from admin dashboard without redeploying
- Per-space invite lock (owners/admins can lock/unlock invites independently of global flag)
- Tauri 2 desktop wrapper with native notifications (avatar support: WinRT circular icon on Windows, blob URL icon in browser), auto-update with signed builds via `tauri-plugin-updater`
- Support ticket system (one-per-user, real-time chat with staff, admin claim/close workflow)
- **Dynamic resource limits** — 3-tier resolution (per-server override > global config > hardcoded defaults) for max channels, voice users, categories, members and webhooks; admin UI for global + per-space management; read-only limits tab in Space Settings
- Custom frameless title bar with system tray (close-to-tray with graceful fallback on Linux — quit cleanly if tray unavailable), splash screen window, infrastructure server management with interactive 3D globe visualization in admin geography dashboard
- **Community themes** — create, publish, browse, install/uninstall themes with live preview editor, JSON import/export, marketplace with search/sort/tag filtering, admin moderation (remove)
- **Internationalization (i18n)** — 11 languages (en, fr, es, pt, de, ru, uk, ko, zh, ja, ar) with RTL support for Arabic, browser language detection, localStorage persistence, language settings tab
- **End-to-end encryption** — DMs sealed on the sending device (vodozemac via the Rust/WASM crypto engine), encrypted attachments, device linking with a displayed code, cross-signing with safety numbers, encrypted key backup, E2E-sealed DM call signaling; no plaintext fallback
- **Secure channels** — invite-only E2E space channels invisible to non-members (owners and admins included); **secure voice channels** encrypt audio per frame with rotating keys (audio only)
  - Secure channel pickers list the whole space from the member directory (search on the server, 100 a page) and show picked members as chips
- **Space discovery (Explore)** — searchable directory with tags, sorts, Featured row, Bronze to Diamond activity badges, approval-first join requests, removal = ban, admin Feature/Block curation, `server_discovery` flag
- **Incoming webhooks** — secret URL per text channel (Space Settings → Integrations, Manage Webhooks permission), Discord-format payloads plus a signed GitHub type, APP tag, no third-party fetches, `webhooks` flag
- **Screen-share annotations and privacy masks** — live pen, highlighter, shapes, captions and image overlays as vector data; masks composited on the sharer's machine and failing closed
- **Registration abuse defenses** — canonical emails, invisible proof-of-work, daily IP/subnet/domain budgets, mail caps, 7-day unverified sweep, admin Registrations panel
- **Space-first wording** — a community is a space in every user-facing string (11 locales, landing page, legal documents in English and French); code, API and admin keep 'server'

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express 5, TypeScript, Prisma 7, PostgreSQL, Redis, Socket.IO |
| Frontend | React 19, Vite 8, Zustand, Tailwind CSS 4, Tauri 2 |
| Voice | mediasoup SFU (server), WebRTC P2P (DM), RNNoise WASM noise suppression |
| E2E crypto | Rust/WASM engine (wasm-bindgen over vodozemac), OS keychain session storage in Tauri |
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
- [x] ~~E2E encryption for DMs~~ (done in 2.0.0 — also secure channels, secure voice and sealed call signaling)
- [ ] Prometheus + Grafana monitoring

## Recent Changes

- **v2.1.0 (unreleased) — Spaces navigation and wording** (2026-10-27) -- Two-zone spaces strip (Messages | Spaces) with pinned/auto modes; message search moved into the chat headers; categories with rails and visible create controls; two-column secure-channel dialog with member-directory pickers; 'space' wording in every user-facing string (11 locales, landing page, legal EN+FR), guarded by spaceWording.test.ts. Also in 2.1.0: space discovery, incoming webhooks, annotations and masks, registration abuse defenses.

- **v2.0.0 — End-to-end encryption and redesign** (2026-08-16) -- E2E DMs, secure channels and secure voice, sealed call signaling, redesigned interface, Voxium Community License 1.0.

- **RNNoise Suppression Production Fix** (2026-04-10) -- Fixed WASM noise suppression silencing audio in production builds via CSP `wasm-unsafe-eval`, Vite ES worker format, and `processorerror` fallback detection.

- **v1.7.0 — Linux Desktop Fix + Landing Page + UX Polish** (2026-03-26)
  - **Linux Tauri fix (CORS):** Removed unnecessary `withCredentials: true` from Axios — auth uses Bearer tokens, not cookies. The strict CORS mode it triggered broke on Linux webkit2gtk where the Tauri custom protocol origin (`http://tauri.localhost`) may not be echoed correctly. Server CORS middleware now echoes the first allowed origin on null-origin requests instead of `*` (which is forbidden with `credentials: true`).
  - **Linux Tauri fix (system tray):** `TrayIconBuilder::build()` error now handled gracefully (`.is_ok()` instead of `?`). On Linux GNOME/Wayland without `libappindicator`, the app no longer crashes on startup. Close behavior adapts: tray available → hide to tray; no tray → quit cleanly.
  - **Landing page comparison table:** Added "Custom Themes" row (Voxium ✓, Discord ✗, TeamSpeak "TS3 Addons", Matrix "JSON Themes") and "Role Permissions + Channel Overrides" row (Voxium ✓, Discord ✓, TeamSpeak ✓, Matrix "Power Levels"). All values fact-checked against free tiers.
  - **Landing page footer:** Contributing link now points to GitHub CONTRIBUTING.md. Status link commented out (placeholder for future Uptime Kuma deployment).
  - **Message area horizontal scroll fix:** Added `!overflow-x-hidden` to Virtuoso scroller (overrides inline `overflow: auto`) and `min-w-0` to ChatArea/DMChatArea root flex containers. Prevents useless horizontal scrollbar in both server and DM message lists.
  - **Server error translations:** New `utils/serverErrors.ts` maps 130+ server error messages to i18n keys. All error-displaying components updated to use `getTranslatedError()`.
  - **Production env template:** `.env.production.example` now documents all three Tauri CORS origins (Windows/macOS/Linux).
  - Translation keys added across all 11 locales for new comparison rows.
  - Version bump: 1.6.0 → 1.7.0 across all packages, Tauri config, and Cargo files.

- **Internationalization (i18n)** (2026-03-23) -- 11-language support (en, fr, es, pt, de, ru, uk, ko, zh, ja, ar) with RTL for Arabic; language selector in settings; i18next with browser detection and localStorage persistence.

- **Community Themes Review** (2026-03-21) -- Review found: patterns dropped on install (BUG), patterns not restored after preview (BUG), version not bumped for pattern-only changes, search missing debounce, empty catch blocks; see CONTEXT_CHANGELOG.md for full findings.

- **Community Themes** (2026-03-21) -- Theme creation, marketplace browsing, JSON import/export, live preview editor, install/uninstall tracking; backend CRUD + admin moderation + 49 tests.

- **Desktop UX + Admin Globe + Permission Enforcement** (2026-03-21) — Custom frameless title bar, system tray (close-to-tray), splash screen; admin infra server CRUD with cobe v2 globe; permission checks on voice produce/SPEAK, attachment proxy/VIEW_CHANNEL, force-move/CONNECT; input validation hardening on auth and infra routes.

- **Advanced Permission System** (2026-03-19) — Bitmask roles with 20 permission flags at the time, 22 since CREATE_SECURE_CHANNELS and MANAGE_WEBHOOKS (VIEW_CHANNEL, SEND_MESSAGES, MANAGE_CHANNELS, MANAGE_ROLES, KICK_MEMBERS, MUTE_MEMBERS, ATTACH_FILES, ADMINISTRATOR, etc.), role hierarchy enforcement, channel-level permission overrides (allow/deny/inherit tri-state), @everyone default role with restricted defaults, permission calculator (base → roles → channel overrides), VIEW_CHANNEL enforcement on channel list/messages/socket auto-join, voice moderation (server mute/deafen with Redis persistence, cross-channel force-move), per-server nicknames (CHANGE_NICKNAME/MANAGE_NICKNAMES), full CRUD API with role management UI in server settings + channel permission editor + member context menu for voice moderation. 119 permission system tests + 16 additional voice handler tests. Integration test script: `scripts/test-permissions.ts` (73 assertions, 11 phases).

- **Security: Timing Side-Channel Fix** (2026-03-17) — `requestPasswordReset` now performs crypto work (token generation + hashing) regardless of whether the email exists in the DB. Prevents attackers from measuring response time differences to enumerate registered email addresses.

- **Self-Hosted STUN + Desktop Test Suite** (2026-03-17) — Added coturn STUN-only server to docker-compose for cross-internet DM P2P calls (stateless NAT discovery, no media relay, privacy-first). STUN host auto-derived from `VITE_WS_URL`. Set up Vitest + jsdom for desktop app with 53 unit tests covering audio pipeline, voice store (pttActive lifecycle, DM user CRUD, peer cleanup), PTT logic (guard conditions, DM event routing, speaking indicator formula, STUN URL derivation, generation counter).

- **Audio Pipeline Refactor + PTT for DM Calls + Privacy** (2026-03-16) — Separated noise suppression (isolated RNNoise pipeline: clean `source → AudioWorklet → destination` pipeline) from speaking detection into isolated pipelines. Extended push-to-talk to DM calls with PTT speaking indicator override (`pttActive` state). Removed Google STUN servers (privacy-first). Live noise suppression toggle mid-call with generation counter to prevent race conditions. All empty catch blocks replaced with proper error logging.

- **Unit Test Suite** (2026-03-14) -- 635 unit and integration tests (582 server + 53 desktop) covering utils, middleware, routes, services, websocket, mediasoup config, and permission system. Vitest with process isolation (`pool: 'forks'`). CI pipeline updated to run tests.

- **Dependency Upgrades** (2026-03-14) -- Prisma 6->7 (adapter pattern via `@prisma/adapter-pg`, `prisma.config.ts`, generated client at `src/generated/prisma/client`), Express 4->5, Redis 4->5 (`sIsMember` returns number, `multi().exec()` type changes), Tailwind 3->4 (CSS-first `@theme` config, `@tailwindcss/vite` plugin, removed `tailwind.config.js`/`postcss.config.js`), Vite 6->7 with `@vitejs/plugin-react` 5, bcryptjs 2->3 (ships own types), dotenv 16->17, rate-limiter-flexible 5->9, lucide-react 0.469->0.577; removed nanoid (replaced with `crypto.randomBytes`), zod (unused), `@types/bcryptjs` (bundled), autoprefixer+postcss (built into Tailwind 4). Updated Dockerfile + docker-entrypoint.sh + CI workflows for Prisma 7.

- **Voice System Hardening + ESLint Zero Warnings** (2026-03-14) -- Transport connect ACK, auto-rejoin on DTLS failure (max 3 attempts), RNNoise gain gate bypass, consumer resume retry, live input device switching, voice cleanup on logout, toast notifications for voice errors. ESLint 153 warnings eliminated across all packages. Unread counter improvements: dedup mark-as-read calls, debounced while-viewing mark, tab-focus re-mark, lateral-join capped unread queries, rate-limited mark-read endpoints.

- **Unread Counter Bug Fixes** (2026-03-13) — Fixed phantom unread badges caused by failed fire-and-forget mark-as-read calls (added single retry), stale serverId in debounced timer closures after server switch, missing mark-as-read on reconnect, and no re-mark on tab focus regain.

- **Email Verification + Case-Insensitive Login** (2026-03-13) — New users must verify email before accessing the platform. Backend gate via `requireVerifiedEmail` middleware on all non-auth routes (including attachment proxy) + Socket.IO auth rejection. Frontend shows `EmailVerificationPendingPage` for unverified users with resend cooldown (reads `Retry-After` from 429, capped at 300s). `VerifyEmailPage` uses `processedTokenRef` guard (tracks last-processed token string, not boolean) to prevent StrictMode double-POST while allowing navigation to different tokens. Auth service queries use Prisma `select` to limit fetched fields (defense-in-depth against sensitive column exposure). Verification tokens: 256-bit entropy, SHA-256 hashed in DB, 24h expiry, format-validated (64 hex chars, normalized to lowercase). Reset-password tokens also normalized. Email addresses normalized to lowercase on registration, login, and password reset. `authStore.updateProfile` merges partial response to preserve `emailVerified`. Email sender uses Nodemailer structured `{ name, address }` to prevent header injection. Migration includes preflight duplicate-email check before case normalization. Dedicated rate limiters for verify-email (IP-based) and resend-verification (userId-based). Existing users backfilled as verified via migration. E2E: 9 verification tests + global teardown for PrismaClient cleanup + `registerViaUI` auto-verifies via DB (by email, no JWT parsing) + `registerViaUIUnverified` for pending-page tests.

- **Email Sender Name + CSP Fix** (2026-03-13) — Emails now show `"Voxium" <noreply@voxium.app>` instead of bare address. Added bare domain `https://voxium.app` to Tauri CSP `connect-src` and `img-src` (wildcard `*.voxium.app` doesn't match the apex domain). Added `tauriScript: pnpm tauri` to release workflow (was defaulting to npm).

- **Tauri Auto-Update** (2026-03-12) — Mandatory auto-update system via `tauri-plugin-updater` + `tauri-plugin-process`. Update modal blocks the app (no dismiss/skip — prevents client-server version mismatch). Phases: available → downloading (progress bar) → ready → restart. Signed builds via `tauri-apps/tauri-action@v0`, update manifest at GitHub releases `latest.json`. Minisign pubkey embedded in `tauri.conf.json`.

- **Copilot Review Fixes** (2026-03-12) — Misplaced import in `mediasoupManager.ts`; removed dead `maxContentLength` param from `s3.ts` (S3 `ContentLength` is exact, not a max); fixed video attachment size bug in `dm.ts` + `messages.ts` (was hardcoded 8MB instead of `getMaxAttachmentSize()` — videos 8-12MB were rejected); reversed S3 delete order in `attachmentCleanup.ts` (delete S3 first, then mark DB expired — prevents orphaned storage); fixed `MentionAutocomplete.tsx` stale closure + missing abort on mention dismiss; optimized `channel:join` from 2 DB queries to 1 via nested select.

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
- **`CHANGELOG.md`** — Release notes (2.0.0, Unreleased = 2.1.0)
- **`docs/e2e-dm-spec.md`** — End-to-end encryption protocol
- **`ARCHITECTURE.md`** — Detailed system architecture, database design, scalability strategy
- **`CONTEXT_CHANGELOG.md`** — Full feature-by-feature development history with file changes and review notes
