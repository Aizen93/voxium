# Voxium - Project Context

## Overview

**Voxium** is a modern, open-source voice and text communication platform — a Discord alternative built from scratch. It enables users to create servers, organize channels, and communicate via real-time text messaging and voice chat.

## Project Status

**Version:** 0.9.8 (Auth Page Peeking Thief)
**Date:** 2026-03-03
**Stage:** Full TypeScript strict compliance across server and desktop, pre-commit type-check gate, real-time channel CRUD, push-to-talk voice mode, notification sounds, unread message indicators with server-level count badges (persistent across refresh/reconnect via server-side read tracking), toast notification system, message editing and deletion UI, message reactions with emoji picker, S3 file uploads with avatar and server icon support (presigned URL direct upload), real-time avatar and profile updates across all clients, forgot password flow with email reset tokens, authenticated password change from settings, token version-based refresh token invalidation, 1-on-1 direct messages with real-time delivery, typing indicators, reactions, persistent unread tracking, delete DM conversations with real-time sync, 1-on-1 DM voice calls with WebRTC P2P audio, friend request system with real-time notifications, comprehensive rate limiting (per-endpoint + socket-level), input sanitization (HTML stripping + validation), WebRTC perfect negotiation for glare-free DM calls, Tauri desktop icon integration, Remember Me login with dual-storage token management, Tauri native desktop notifications, message replies with reply preview and scroll-to-original, client-side image processing with presigned S3 uploads, looping incoming call ringtone, DM profile popup fallback via API fetch, DM call conversation hydration for brand-new conversations, channel categories with collapsible UI, drag-and-drop channel/category reordering, message search (server + DM) with jump-to-message navigation, screen sharing in server voice channels with inline/floating viewer modes, and ML-based noise suppression (RNNoise WASM AudioWorklet) with Opus SDP optimization

## What Has Been Done

### 1. Project Structure (Monorepo)

The project is organized as a **pnpm monorepo** with the following packages:

```
Voxium/
├── apps/
│   ├── server/           # Backend API + WebSocket + WebRTC signaling
│   ├── desktop/          # Tauri 2 + React frontend (cross-platform desktop)
│   └── admin/            # Standalone admin dashboard (React + Vite, port 8082)
├── packages/
│   └── shared/           # Shared TypeScript types, validators, constants
├── docker-compose.yml    # PostgreSQL + Redis infrastructure
├── pnpm-workspace.yaml
└── package.json
```

### 2. Backend Server (`apps/server`)

A full Node.js + TypeScript backend has been implemented with:

- **HTTP API Framework:** Express.js with structured routing
- **Database:** PostgreSQL via Prisma ORM with full schema for users, servers, channels, messages, invites, server members, and channel read tracking
- **Authentication:** JWT-based (access + refresh tokens) with bcrypt password hashing
- **Real-time:** Socket.IO for WebSocket connections handling:
  - Channel subscription/unsubscription
  - Live message broadcasting
  - Typing indicators
  - User presence (online/offline/idle/dnd)
  - Voice channel join/leave/mute/deaf/speaking events
  - WebRTC peer signaling relay
- **Voice:** WebRTC signaling server with in-memory voice state tracking (upgradeable to Redis for multi-node)
- **Cache/Presence:** Redis for online user tracking, socket-to-user mapping
- **Security:** Helmet, CORS, rate limiter infrastructure, input validation via shared validators
- **API Endpoints:**
  - `POST /api/v1/auth/register` — User registration
  - `POST /api/v1/auth/login` — User login
  - `POST /api/v1/auth/refresh` — Token refresh
  - `GET /api/v1/auth/me` — Current user profile
  - `POST /api/v1/auth/forgot-password` — Request password reset email (silent on unknown emails to prevent enumeration)
  - `POST /api/v1/auth/reset-password` — Reset password via token from email link
  - `POST /api/v1/auth/change-password` — Change password for authenticated user (requires current password)
  - `GET /api/v1/servers` — List user's servers
  - `POST /api/v1/servers` — Create server (auto-creates #general text + General voice channels)
  - `GET /api/v1/servers/:id` — Server details with channels
  - `GET /api/v1/servers/:id/members` — Paginated member list
  - `POST /api/v1/servers/:id/join` — Join a server
  - `POST /api/v1/servers/:id/leave` — Leave a server
  - `DELETE /api/v1/servers/:id` — Delete server (owner only)
  - `GET /api/v1/servers/:id/channels` — List channels
  - `POST /api/v1/servers/:id/channels` — Create channel (admin+)
  - `DELETE /api/v1/servers/:id/channels/:cid` — Delete channel (admin+)
  - `POST /api/v1/servers/:id/channels/:cid/read` — Mark channel as read (upserts ChannelRead timestamp)
  - `GET /api/v1/channels/:id/messages` — Paginated messages (cursor-based)
  - `POST /api/v1/channels/:id/messages` — Send message
  - `PATCH /api/v1/channels/:id/messages/:mid` — Edit message (author only)
  - `DELETE /api/v1/channels/:id/messages/:mid` — Delete message (author or admin)
  - `PUT /api/v1/channels/:id/messages/:mid/reactions/:emoji` — Toggle reaction on message (server members)
  - `POST /api/v1/invites/servers/:id` — Create invite
  - `POST /api/v1/invites/:code/join` — Use invite
  - `GET /api/v1/invites/:code` — Preview invite
  - `GET /api/v1/users/:id` — User profile
  - `PATCH /api/v1/users/me/profile` — Update own profile
  - `POST /api/v1/uploads/presign/avatar` — Get presigned PUT URL for avatar upload (S3)
  - `POST /api/v1/uploads/presign/server-icon/:serverId` — Get presigned PUT URL for server icon upload (S3, owner only)
  - `GET /api/v1/uploads/*` — Redirect to presigned S3 GET URL (unauthenticated, key-validated)

### 3. Frontend Desktop App (`apps/desktop`)

A complete React + TypeScript frontend with Tauri 2 desktop wrapper:

- **UI Framework:** React 19, TypeScript, Vite 6
- **Styling:** Tailwind CSS with custom dark theme (Discord-inspired purple/blue palette)
- **State Management:** Zustand stores for auth, servers, chat, and voice
- **Routing:** React Router v7
- **Desktop Wrapper:** Tauri 2.0 (Rust-based, ~10x smaller than Electron)
- **Pages:**
  - Login page with email/password + animated peeking thief character
  - Registration page + animated peeking thief character
  - Invite page (`/invite/:code`) — server preview card with member count, join button
  - Main app layout (3-panel Discord-like design)
- **Components:**
  - `ServerSidebar` — Icon strip of servers with tooltips, active indicators, create/join modal
  - `ChannelSidebar` — Text and voice channel lists, inline channel creation
  - `ChatArea` — Message list with infinite scroll, grouped messages, typing indicators
  - `MessageInput` — Auto-resizing textarea with typing emission
  - `MemberSidebar` — Member list grouped by role with presence indicators
  - `VoicePanel` — Voice connection panel with mute/deaf controls, user list with speaking indicators
  - `CreateServerModal` — Dual-mode (create new / join via invite); auto-extracts invite code from full URLs
- **Services:**
  - Axios HTTP client with token interceptor, auto-refresh queue pattern (concurrent 401s wait for a single refresh)
  - Socket.IO client with typed events, observable connection status, generation tracking
  - Audio analyser service for speaking detection via AudioContext + AnalyserNode

### 4. Voice Features (v0.2)

Full voice chat quality-of-life features:

- **Speaking detection:** AudioContext + AnalyserNode computes RMS audio levels every 50ms; emits `voice:speaking` events to the server with 300ms silence debounce to prevent flicker
- **Speaking indicator color:** Green (`#3eba68`) ring around the speaker's avatar in both `VoicePanel` and `ChannelSidebar`
- **Local voice activity:** `useLocalAudioLevel` hook drives instant green ring on the local user's avatar (no server roundtrip) via `requestAnimationFrame`
- **Latency measurement:** Client sends `ping:latency` every 5s, server echoes `pong:latency`; RTT displayed next to "Voice Connected" with color coding (green <100ms, yellow <200ms, red >200ms)
- **Connection quality bars:** `ConnectionQuality` component renders 3 signal-strength bars color-coded by latency
- **Audio device settings:** `SettingsModal` with input/output device dropdowns (via `enumerateDevices`), live mic level meter, noise gate sensitivity slider; persisted to localStorage via `settingsStore`
- **Persistent mute/deaf controls:** Mute and deaf state persisted to localStorage (`voxium_voice_prefs`) via `voiceStore`. On voice join, persisted state is sent to the server as an optional `state` parameter on `voice:join`. Controls are always visible in the `ChannelSidebar` user area (not gated by active voice channel), so users can pre-mute before joining. State survives app restarts and socket reconnections.
- **Device application:** Selected input device passed as `deviceId` constraint to `getUserMedia`; output device applied via `setSinkId` on remote audio elements (guarded for browser support)

### 5. Stability & Error Handling (v0.2)

Comprehensive hardening of real-time features:

- **Socket reconnection:**
  - `connectSocket()` protects auto-reconnecting sockets from teardown (`explicitlyDisconnected` flag)
  - Socket generation counter tracks instance replacements
  - Auth token refreshed from localStorage on every reconnect attempt
  - Dual-mechanism reconnect detection in MainLayout and ChatArea: direct `socket.on('connect')` + `onConnectionStatusChange` (Set-based), with deduplication by `socket.id`
  - `onAny`/`onAnyOutgoing` debug listeners log all WebSocket traffic for diagnostics
- **Server-side race condition fix:** All socket event handlers (`channel:join`, `channel:leave`, typing, voice, etc.) registered SYNCHRONOUSLY before any `await` in the connection handler — prevents early events from being silently dropped
- **Server-side diagnostics:** `channel:join`/`channel:leave` logged with userId and socketId; message broadcasts log room membership count and user IDs
- **Chat store:** AbortController cancels stale fetches on rapid channel switching; typing timers tracked per-user with proper cleanup; fetch deduplication by key
- **API interceptor:** Token refresh queue pattern — concurrent 401 responses wait for a single refresh call instead of stampeding
- **Voice store:** ICE restart on peer connection failure with retry timers; proper `pc.on*` handler nullification in peer cleanup; deferred peer creation with `setTimeout(0)`; auto voice re-join on socket reconnect
- **UI resilience:** `ConnectionBanner` shows yellow reconnecting/disconnected status; `ErrorBoundary` wraps the app with recover/reload UI

### 6. Shared Package (`packages/shared`)

- All TypeScript interfaces and types for the entire platform (including `ping:latency`/`pong:latency` events)
- Input validators (username, email, password, server name, channel name, message content)
- Constants (limits, event names, etc.)
- Used by both server and desktop packages

### 7. Infrastructure

- `docker-compose.yml` for PostgreSQL 16 + Redis 7
- Prisma migrations ready
- Database seed script with demo data (3 users, 1 server, sample messages)

## What Is NOT Yet Done (Planned for Next Iterations)

### V0.2 - Polish & Stability (complete)
- [x] Speaking detection via AudioContext
- [x] Latency measurement and connection quality display
- [x] Audio device selection and settings modal
- [x] Error boundary and connection status banner
- [x] Socket reconnection hardening
- [x] Ongoing: real-time message delivery reliability after reconnects
- [x] Real-time member join/leave notifications (member:joined / member:left events)
- [x] Real-time channel create/delete notifications (channel:created / channel:deleted events)
- [x] Role-based channel management UI (create/delete buttons visible to owner/admin only)
- [x] Push-to-talk mode
- [x] Notification sounds + desktop notifications
- [x] Unread message indicators
- [x] Toast notifications in UI

### V0.3 - Enhanced Features
- [x] Message editing/deletion UI
- [x] Message reactions with emoji picker
- [x] File/image upload support (S3 avatars and server icons)
- [x] Direct messages (DMs) -- text + voice calls
- [x] Friend system
- [x] Server settings panel
- [x] User settings/profile editing
- [x] Role/permission management
- [x] Channel categories (with drag-and-drop reordering)
- [x] Emoji picker integration
- [x] Rich text / markdown in messages
- [x] Message search (server + DM, with jump-to-message)
- [x] Screen sharing

### V0.4 - Scalability
- [ ] mediasoup SFU for production-grade voice/video
- [ ] Redis-based voice state for multi-node deployment
- [ ] Horizontal scaling with sticky sessions
- [ ] CDN for static assets
- [x] File storage (S3-compatible) — implemented in v0.3.2
- [x] Rate limiting per endpoint — implemented in v0.7.1

### V1.0 - Production
- [ ] End-to-end testing
- [ ] CI/CD pipeline
- [ ] Production Docker images
- [ ] Kubernetes manifests
- [ ] Monitoring (Prometheus + Grafana)
- [ ] Mobile app (React Native)

## Tech Decisions & Rationale

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Monorepo | pnpm workspaces | Simple, fast, native workspace support |
| Backend runtime | Node.js + TypeScript | Rapid development, large ecosystem, excellent WebSocket support |
| API framework | Express.js | Mature, well-documented, massive middleware ecosystem |
| Database | PostgreSQL | Robust, ACID-compliant, excellent for relational data |
| ORM | Prisma | Type-safe queries, automatic migrations, great DX |
| Cache/Presence | Redis | Fast in-memory store, pub/sub for multi-node scaling |
| Real-time | Socket.IO | Reliable WebSocket with fallbacks, rooms, namespaces |
| Voice | WebRTC + signaling server | Browser-native, low-latency, P2P for small groups |
| Frontend framework | React 19 | Dominant ecosystem, excellent tooling |
| State management | Zustand | Minimal boilerplate, TypeScript-first, no providers |
| Desktop wrapper | Tauri 2 | 10x smaller than Electron, Rust security, cross-platform |
| Styling | Tailwind CSS | Utility-first, fast iteration, consistent design system |
| Build tool | Vite | Fast HMR, ESM-native, excellent Tauri integration |
| Audio analysis | Web Audio API (AudioContext + AnalyserNode) | Browser-native, no dependencies, real-time RMS computation |
| Latency measurement | Custom ping/pong over Socket.IO | Simple, accurate RTT, no external dependencies |

## Key Architecture Notes

### Socket Reconnection Strategy
The client uses a **dual-mechanism** approach for handling socket reconnections:
1. **Direct `socket.on('connect')` listener** — attached to the socket instance; most reliable for auto-reconnect (same instance)
2. **`onConnectionStatusChange` (Set-based)** — fires on every status transition; catches socket replacement and initial connect

Both mechanisms are deduplicated by `socket.id` to prevent double-processing. This defense-in-depth approach ensures channel rooms are re-joined and event listeners are re-attached regardless of how the reconnection occurs (auto-reconnect, token refresh, page reload).

### Server Event Handler Registration
All socket event handlers (`channel:join`, `channel:leave`, typing, voice, etc.) are registered **synchronously** at the top of the `connection` handler, before any `await` calls. This prevents a race condition where early client events (sent immediately after connect) would be silently dropped if handlers hadn't been registered yet.

### Dynamic Server Room Management (v0.2.1–v0.2.3)

**Problem:** Socket.IO server rooms (`server:{id}`) were only joined during the initial socket connection handler. When a user created or joined a server mid-session, their socket was never added to the new server's room, breaking all server-scoped real-time features (voice user lists, speaking indicators, presence, member updates). Text messages still worked because they use `channel:{id}` rooms which are joined explicitly.

**Fix — critical invariant:** Every code path that makes a user a server member must also add their socket(s) to the `server:{id}` room. This is now handled in three places:
1. **Socket connect** (`socketServer.ts`) — joins rooms for all existing memberships (unchanged)
2. **Server join** (invite or direct) — `broadcastMemberJoined()` in `utils/memberBroadcast.ts` adds socket to room + emits `member:joined`
3. **Server create** (`servers.ts`) — `joinServerRoom()` adds socket to room (no broadcast needed, creator is the only member)

**Server-side changes:**
- `utils/memberBroadcast.ts` — centralized helpers: `broadcastMemberJoined`, `broadcastMemberLeft`, `joinServerRoom`. Uses `io.fetchSockets()` to find user's active sockets.
- `member:joined` / `member:left` events are now emitted (types existed but were never used before)
- `getVoiceStateForServer` in `voiceHandler.ts` now returns actual `selfMute`/`selfDeaf` state (previously hardcoded to `false`)

**Client-side changes:**
- `MainLayout.tsx` listens for `member:joined` and `member:left`, calls `serverStore.addMember` / `removeMember`
- `serverStore.ts` — new `addMember(serverId, user)` and `removeMember(serverId, userId)` methods with deduplication

### Invite Link Flow (v0.2.2)

- **Route:** `/invite/:code` renders `InvitePage` for authenticated users. Unauthenticated users are redirected to `/login` with the invite path saved to `localStorage` (`voxium_pending_redirect`). After login, `AuthRedirect` reads the saved path and navigates there automatically.
- **Invite lifecycle:** Invites are single-use. The join endpoint (`POST /invites/:code/join`) deletes the invite in a Prisma `$transaction` alongside member creation. Expired invites are also cleaned up on access (both preview and join). The `maxUses`/`uses` columns in the schema are no longer set by application code (cleanup migration pending).
- **URL extraction:** `CreateServerModal` extracts the invite code from full URLs (e.g., `http://localhost:8080/invite/UsLnacI8`) using a regex match on `/invite/([^\s/]+)`.

### New Files Added in v0.2–v0.2.3
- `apps/desktop/src/services/audioAnalyser.ts` — Speaking detection via AudioContext
- `apps/desktop/src/stores/settingsStore.ts` — Audio device preferences with localStorage persistence
- `apps/desktop/src/components/settings/SettingsModal.tsx` — Audio device selection UI
- `apps/desktop/src/components/voice/ConnectionQuality.tsx` — Signal strength bars
- `apps/desktop/src/components/layout/ConnectionBanner.tsx` — Reconnecting/disconnected banner
- `apps/desktop/src/components/layout/ErrorBoundary.tsx` — React error boundary with recover UI
- `apps/desktop/src/hooks/useLocalAudioLevel.ts` — Real-time mic level for local avatar indicator
- `apps/server/src/utils/memberBroadcast.ts` — Centralized member join/leave/room-join helpers
- `apps/desktop/src/pages/InvitePage.tsx` — Invite preview page with server card and join button

### Global & Persistent Mute/Deaf Controls (v0.2.4)

**Changes across 4 files:**
1. `packages/shared/src/types.ts` -- `voice:join` in `ClientToServerEvents` now accepts an optional second parameter `{ selfMute, selfDeaf }` so the client can send persisted state on join. Also fixed `voice:leave` signature from `(channelId: string)` to `()` to match actual server/client usage.
2. `apps/desktop/src/stores/voiceStore.ts` -- Added `VoicePrefs` interface, `loadPersistedVoicePrefs()`, and `persistVoicePrefs()` functions. Initial store state reads from localStorage. `toggleMute`/`toggleDeaf` persist after each toggle. `joinChannel` applies persisted mute state to audio tracks and sends it to the server. Reconnect handler also sends persisted state.
3. `apps/server/src/websocket/voiceHandler.ts` -- `voice:join` handler accepts optional `state` parameter, uses it (with `?? false` defaults) when creating the in-memory voice state entry and when broadcasting `voice:user_joined`.
4. `apps/desktop/src/components/channel/ChannelSidebar.tsx` -- Mute/deaf buttons moved from inside `VoicePanel` (only visible during active voice) to the user area at the bottom of `ChannelSidebar` (always visible). Both locations share the same `toggleMute`/`toggleDeaf` store actions.

### ServerSidebar Tooltip Fix (v0.2.4)

**Problem:** Server icon tooltips appeared as empty boxes at the bottom of the screen. The tooltip used `absolute` positioning inside the server list container which has `overflow-y: auto`. CSS automatically clips `overflow-x` when `overflow-y` is non-`visible`, so the tooltip content extending beyond the 72px sidebar was clipped.

**Fix:** Switched from `absolute` to `fixed` positioning. On `mouseEnter`, `getBoundingClientRect()` captures the button's viewport coordinates. The tooltip renders as a sibling outside the sidebar `div` with `fixed` position and `transform: translateY(-50%)` for vertical centering, 8px to the right of the button. Fixed positioning is relative to the viewport and unaffected by parent overflow.

### TypeScript Type Safety Hardening (v0.2.5)

Eliminated all TypeScript compilation errors across both server and desktop. Both `pnpm build:server` and `pnpm build:desktop` now pass with zero errors.

**Server fixes (5 categories, ~50 errors):**
1. **Express route params** — All 15 route handlers across `channels.ts`, `invites.ts`, `messages.ts`, `servers.ts`, `users.ts` now use typed `Request<{ paramName: string }>` generics instead of bare `Request`. Previously, `req.params` values typed as `string | string[]` caused cascading failures in Prisma queries (TS couldn't infer return types including relations like `server` and `_count`).
2. **JWT `expiresIn` type** — `authService.ts` `generateTokens()` now casts options `as jwt.SignOptions`. Newer `jsonwebtoken` types use a branded `StringValue` type from the `ms` package; generic `string` from env vars doesn't match without a cast.
3. **Message type alignment** — Shared `Message` type renamed `updatedAt` to `editedAt` to match Prisma schema field name. Frontend reference in `MessageList.tsx` updated accordingly.
4. **Socket.IO Date serialization** — `message:new` and `message:update` emits in `messages.ts` now cast Prisma results `as unknown as Message` at the serialization boundary. Prisma returns `Date` objects; Socket.IO serializes them to ISO strings over the wire, so the runtime behavior was always correct — this is a compile-time-only fix.
5. **`voice:leave` signature** — Fixed from `(channelId: string) => void` to `() => void` in shared types. Neither client nor server ever passed a channelId (the server tracks it via `socket.data.voiceChannelId`).

**Desktop fixes (3 errors):**
1. **`useRef()` in MessageInput.tsx** — Changed to `useRef<... | null>(null)`. React 19 types require an explicit initial value.
2. **`import.meta.env` unrecognized** — Created `apps/desktop/src/vite-env.d.ts` with `/// <reference types="vite/client" />`. The tsconfig `include: ["src"]` picks it up.
3. **`message.updatedAt`** — Updated to `message.editedAt` to match the shared type rename.

**Voice store guard** — `toggleMute`/`toggleDeaf` now only emit `voice:mute`/`voice:deaf` to the server when `activeChannelId` is set, avoiding unnecessary network traffic when toggling outside a voice channel.

### Regression Prevention Tooling (v0.2.5)

- **`pnpm typecheck`** — New root script. Runs `build:shared` then `tsc --noEmit` on both server and desktop. Catches all type errors without producing output files.
- **Git pre-commit hook** (`.git/hooks/pre-commit`) — Runs the full type-check pipeline (shared → server → desktop) before every commit. Blocks commits with type errors and prints which stage failed.

### New Files Added in v0.2.4–v0.2.5
- `apps/desktop/src/vite-env.d.ts` — Vite client type declarations (`/// <reference types="vite/client" />`)

### Real-Time Channel Create/Delete (v0.2.6)

**Problem:** When a user created or deleted a channel, other server members didn't see the change until they refreshed the page. The `channel:created` and `channel:deleted` socket events were defined in shared types/constants but never wired up.

**Server-side fix (`apps/server/src/routes/channels.ts`):**
- Imported `getIO()` from the socket server
- After `prisma.channel.create()`, emits `channel:created` to the `server:{serverId}` room with the full channel object
- After `prisma.channel.delete()`, emits `channel:deleted` to the `server:{serverId}` room with `{ channelId, serverId }`

**Client-side fix:**
- `stores/serverStore.ts` — Added `addChannel(channel)` (with dedup by `channel.id`, scoped to active server) and `removeChannel(channelId, serverId)` (clears `activeChannelId` if the deleted channel was selected). Added `deleteChannel(serverId, channelId)` API method.
- `stores/serverStore.ts` — `createChannel()` no longer updates local state; the socket `channel:created` event is the sole source of truth for all users (including the creator), preventing duplicate entries.
- `components/layout/MainLayout.tsx` — Added `channel:created` and `channel:deleted` to the socket event map, calling `addChannel` and `removeChannel` respectively.

**UI changes (`components/channel/ChannelSidebar.tsx`):**
- Added role-based visibility: `isAdmin` derived from current user's membership role in the members list
- Channel create (`+`) buttons only visible to owners/admins
- Delete button (trash icon) appears on hover for each text and voice channel, only for owners/admins
- Channel rows restructured: outer `<div>` with `group` class for hover state, inner click-to-select/join `<button>` + separate delete `<button>`

**Key pattern:** Both `createChannel` and `deleteChannel` in the store do NOT update local state — the socket broadcast is the single source of truth for all clients (including the caller). This eliminates race conditions and duplication.

### Push-to-Talk Mode (v0.2.7)

**New feature:** Users can switch between Voice Activity Detection (VAD) and Push-to-Talk (PTT) input modes via the Settings modal.

**Settings (`settingsStore.ts`):**
- `voiceMode: 'voice_activity' | 'push_to_talk'` — persisted to localStorage alongside existing audio settings
- `pushToTalkKey: string` — keyboard code (default: `Backquote` / backtick), configurable via key picker in the Settings modal

**PTT Hook (`hooks/usePushToTalk.ts`):**
- Global `keydown`/`keyup`/`blur` listeners on `window`, active only when `voiceMode === 'push_to_talk'`
- On key press: enables audio tracks, starts speaking detection, emits `voice:mute false`
- On key release (or window blur): disables audio tracks, stops speaking detection, emits `voice:mute true`
- Guards: `e.repeat` (prevents key repeat), `isTextInput()` (prevents activation in chat input), `selfMute` check (manual mute overrides PTT)
- Cleanup releases PTT on mode change or unmount

**Voice Store changes (`voiceStore.ts`):**
- `joinChannel`: In PTT mode, tracks start disabled and the server receives `selfMute: true` (not the user's persisted preference)
- `toggleMute`: In PTT mode, muting disables tracks and stops detection; unmuting does NOT enable tracks (PTT key handles that)
- Mode-switch subscription: switching to PTT disables tracks and emits server mute; switching to VAD re-enables tracks if not manually muted
- Reconnect handler: sends `selfMute: true` to server in PTT mode

**Settings UI (`SettingsModal.tsx`):**
- Toggle buttons for Voice Activity / Push to Talk modes
- `KeyBindingPicker` component: click to start listening, press any key to bind (Escape cancels). Captures via `useCapture: true` to override all handlers
- Mic sensitivity slider only shown in Voice Activity mode
- `formatKeyCode()` maps `KeyboardEvent.code` values to human-readable labels

**New file:** `apps/desktop/src/hooks/usePushToTalk.ts`

### Notification Sounds & Desktop Notifications (v0.2.7)

- **Notification sounds:** `services/notificationSounds.ts` provides `playMessageSound()`, `playJoinSound()`, `playLeaveSound()` using the Web Audio API. Sounds are triggered in MainLayout's socket event handlers for `message:new`, `voice:user_joined`, and `voice:user_left` (only for non-active channels / other users).
- **Desktop notifications:** When a `message:new` event arrives for a non-active channel from another user, a native `Notification` is shown with the server name, channel name, author, and truncated content. Permission is requested on mount.
- **Settings:** `settingsStore` has `enableNotificationSounds` and `enableDesktopNotifications` toggles (persisted to localStorage). The settings button is global (in `ServerSidebar`).

### Unread Message Indicators (v0.2.8)

**Feature:** Channel-level unread badges and server-level unread dot indicators, providing visual feedback when messages arrive in channels the user isn't viewing.

**Server-side change (`routes/messages.ts`):**
- `message:new` broadcast payload now includes `serverId: channel.serverId` so the client can track which server an unread message belongs to.

**Server Store (`stores/serverStore.ts`):**
- New state: `unreadCounts: Record<string, number>` (keyed by channelId), `serverUnreadCounts: Record<string, number>` (keyed by serverId)
- `incrementUnread(channelId, serverId)` — bumps both maps by 1
- `clearUnread(channelId)` — resets channel count to 0, decrements the server count accordingly, removes zero entries
- `setActiveChannel()` — auto-calls `clearUnread()` (natural "mark as read" trigger)

**MainLayout (`components/layout/MainLayout.tsx`):**
- `messageNew` handler only calls `addMessage()` when the message belongs to the active channel (prevents cross-channel message leakage — see bug fix below)
- Calls `incrementUnread()` for messages that are not from the current user and not in the active channel (same guard as notifications)
- Typing event handlers (`typingStart`/`typingStop`) now filter by `channelId === activeChannelId` (required after removing `channel:leave` — see below)

**ChannelSidebar (`components/channel/ChannelSidebar.tsx`):**
- Text channels with unreads show **bold white text** (`text-vox-text-primary font-semibold`) + a pill badge with the count (`bg-vox-accent-primary`, 18px round pill)
- Active channel never shows a badge

**ServerSidebar (`components/server/ServerSidebar.tsx`):**
- Server icons with unreads show an **orange left border** (`border-l-[3px] border-orange-500`) and a **red/orange count badge** on the bottom-right corner (`bg-orange-500`, rounded-full, `ring-2 ring-vox-sidebar`). Count displays as number up to 99, then `99+`.
- Badge and border hidden when the server is active

### Channel Room Subscription Fix (v0.2.8)

**Problem:** After a user visited a channel and switched away, they stopped receiving `message:new` events for that channel. The socket was auto-subscribed to all text channel rooms on connect (`socketServer.ts` line 132–139), but `ChatArea.tsx` emitted `channel:leave` when switching channels, which removed the socket from the room — permanently undoing the auto-subscription.

**Fix:**
1. **Removed `channel:leave` emits from `ChatArea.tsx`** — both on channel switch and on component unmount. Auto-subscription persists for the socket's lifetime.
2. **Kept `channel:join` in `ChatArea.tsx`** — still needed for channels created after the socket connected (auto-subscription only covers channels that exist at connect time).
3. **Added `channelId` filtering to typing handlers in `MainLayout.tsx`** — since the socket stays in all channel rooms, `typing:start`/`typing:stop` events from other channels would leak into the current chat's typing indicator without this filter. The server already includes `channelId` in the typing event payload.

**Secondary bug fix (message leakage):** `chatStore.addMessage()` was called for every `message:new` event regardless of channel, causing messages from other servers/channels to appear in the current chat area. Fixed by guarding `addMessage()` with `message.channelId === activeChannelId` in the MainLayout handler.

### Toast Notification System (v0.2.9)

**New feature:** Global toast notifications for user-facing feedback on async operations (success/error/warning/info).

**Store (`stores/toastStore.ts`):**
- Zustand store managing a queue of up to 5 toasts with auto-dismiss via `setTimeout`
- Timer IDs tracked in a `Map<string, ReturnType<typeof setTimeout>>` outside the store; cleared on eviction (MAX_TOASTS overflow) and manual dismiss to prevent orphaned timers
- Convenience `toast.success()` / `toast.error()` / `toast.warning()` / `toast.info()` functions callable from anywhere (non-hook contexts) via `useToastStore.getState()`

**UI (`components/layout/ToastContainer.tsx`):**
- Fixed overlay in bottom-right corner, z-index 100, 320px wide
- Each toast has a colored accent bar, typed icon (lucide-react), message text, and dismiss button
- Slide-in-right animation on entry (keyframe in tailwind.config.js)
- ARIA `role="status"` and `aria-live="polite"` for screen reader accessibility

**Integration points (modified files):**
- `App.tsx` — `ToastContainer` mounted outside `ErrorBoundary` so toasts survive error states
- `ChannelSidebar.tsx` — `toast.success()` on channel create/delete success; `toast.error()` on channel create/delete failure
- `CreateServerModal.tsx` — `toast.success()` on server create/join success
- `MessageInput.tsx` — `toast.error()` on message send failure
- `SettingsModal.tsx` — `toast.error()` on microphone access failure

**New files:**
- `apps/desktop/src/stores/toastStore.ts`
- `apps/desktop/src/components/layout/ToastContainer.tsx`

### Message Editing & Deletion UI (v0.3.0)

**New feature:** Users can edit and delete their own messages inline in the chat. Server admins/owners can delete any message via a confirmation modal.

**Chat Store (`stores/chatStore.ts`):**
- `editMessage(channelId, messageId, content)` — PATCH API call; error propagated to caller
- `requestDeleteMessage(channelId, messageId)` — DELETE API call; error propagated to caller
- `updateMessage(message)` and `deleteMessage(messageId)` — local state mutators driven by socket events (already existed, now exercised by the UI)

**MessageItem (`components/chat/MessageItem.tsx`):**
- Extracted from `MessageList.tsx` into its own component for single responsibility
- Hover action toolbar: edit (pencil) and delete (trash) icons appear on hover in an absolute-positioned bar above the message
- Edit button shown only to message author (`isOwn`); delete button shown to author and admins (`canDelete`)
- Inline edit mode: textarea replaces message content, auto-resizes up to 200px, Escape to cancel, Enter to save
- Shared `editArea` JSX variable eliminates duplication between header and compact message layouts
- `(edited)` indicator shown in both header and compact message views when `editedAt` is set
- `isSaving` state disables textarea during API call; `toast.error()` on failure

**DeleteConfirmModal (`components/chat/DeleteConfirmModal.tsx`):**
- Fixed-position modal with backdrop click and Escape key to close
- Shows message preview (author, timestamp, content truncated to 3 lines)
- Delete button with loading state; toast on failure
- Uses existing `btn-secondary` and `btn-danger` CSS component classes

**MessageList (`components/chat/MessageList.tsx`):**
- Refactored to delegate rendering to `MessageItem`
- Computes `isOwn` and `canDelete` (owner/admin) per message and passes as props
- `shouldShowHeader` grouping logic unchanged

**MainLayout socket handler fix (`components/layout/MainLayout.tsx`):**
- `messageUpdate` handler now filters by `message.channelId === activeChannelId` before calling `updateMessage()`, consistent with the `messageNew` handler pattern
- `messageDelete` handler now filters by `channelId === activeChannelId` before calling `deleteMessage()`, using the `channelId` field included in the server's `message:delete` payload

**Key pattern:** `editMessage` and `requestDeleteMessage` in the store only perform the API call. Local state is NOT updated from the API response -- the server emits `message:update` / `message:delete` socket events which are the sole source of truth, consistent with the existing convention for server-mutating operations.

**New files:**
- `apps/desktop/src/components/chat/MessageItem.tsx`
- `apps/desktop/src/components/chat/DeleteConfirmModal.tsx`

### Message Reactions & Emoji Picker (v0.3.1)

**New feature:** Users can react to messages with emoji. Reactions display as grouped chips below messages, and an emoji picker is shared between the message input (for inserting emoji into text) and the reaction system.

**Database (`apps/server/prisma/schema.prisma`):**
- New `MessageReaction` model with composite unique constraint on `(messageId, userId, emoji)` to enforce one reaction per user per emoji
- Index on `messageId` for efficient aggregation queries
- Cascade deletes from both `Message` and `User`

**Shared package (`packages/shared`):**
- `ReactionGroup` type: `{ emoji, count, userIds }` for aggregated reaction data
- `Message` type updated with `reactions: ReactionGroup[]`
- `ServerToClientEvents` — new `message:reaction_update` event carrying `{ messageId, channelId, emoji, userId, action, reactions }`
- `LIMITS.MAX_REACTIONS_PER_MESSAGE` (20) and `LIMITS.MAX_EMOJI_LENGTH` (32) constants
- `validateEmoji()` validator rejects empty strings, overly long strings, and purely ASCII strings (ensures emoji content)

**Backend (`apps/server/src/routes/messages.ts`):**
- `PUT /:messageId/reactions/:emoji` — toggle endpoint: creates or deletes the reaction (idempotent toggle). Validates emoji, checks server membership, enforces distinct-emoji-per-message limit (20). After mutation, re-queries all reactions and broadcasts `message:reaction_update` to the channel room.
- `aggregateReactions()` helper groups raw `{ emoji, userId }` rows into `ReactionGroup[]`
- GET (messages list), PATCH (edit), and POST (send) now include reactions in their response/broadcast payloads

**Frontend store (`stores/chatStore.ts`):**
- `toggleReaction(channelId, messageId, emoji)` — PUT API call with error handling
- `updateMessageReactions(messageId, reactions)` — immutable state update replacing just the reactions array on the matched message

**Socket handler (`components/layout/MainLayout.tsx`):**
- `message:reaction_update` handler filters by `activeChannelId` before calling `updateMessageReactions()`, consistent with other message event handlers

**EmojiPicker (`components/common/EmojiPicker.tsx`):**
- Shared wrapper around `emoji-picker-react` (new dependency)
- **Portal-based rendering** via `createPortal` to `document.body` with `position: fixed` — avoids clipping by parent `overflow: hidden` containers
- Accepts `anchorRef` (ref to trigger button); computes position from `getBoundingClientRect()` with viewport-aware auto-flip (prefers below, falls back to above, clamps to edges)
- Repositions on window `resize` only — does NOT listen to `scroll` events (internal picker scrolling would cause stale anchor rect reads, snapping the picker to 0,0 when the anchor is in a hover-gated toolbar)
- Dark theme, click-outside and Escape to close
- Used in both `MessageInput` (insert emoji into text) and `MessageItem`/`ReactionDisplay` (add reaction)

**ReactionDisplay (`components/chat/ReactionDisplay.tsx`):**
- Renders grouped reaction chips below messages with count and highlight for user's own reactions
- "+" button opens inline emoji picker for adding new reactions
- Clicking an existing chip toggles the reaction (add/remove)

**MessageItem (`components/chat/MessageItem.tsx`):**
- SmilePlus button added to hover action toolbar (visible for all users, not just author/admin)
- Hover toolbar forced visible (`flex` instead of `hidden group-hover:flex`) while the reaction picker is open — prevents the toolbar from hiding when the mouse moves into the portaled picker, which would collapse the anchor button and break positioning

**New dependency:** `emoji-picker-react@^4.18.0`

**New files:**
- `apps/desktop/src/components/common/EmojiPicker.tsx`
- `apps/desktop/src/components/chat/ReactionDisplay.tsx`
- `apps/server/prisma/migrations/20260225153215_add_message_reactions/migration.sql`

### S3 File Uploads, Avatars & Server Icons (v0.3.2)

**New feature:** Users can upload avatars and server owners can upload server icons. Images are stored in S3-compatible object storage, processed via sharp, and served through a streaming proxy endpoint.

**Backend — S3 utility (`apps/server/src/utils/s3.ts`):**
- New module wrapping `@aws-sdk/client-s3` with three functions: `uploadToS3(folder, entityId, buffer)`, `streamFromS3(key)`, `deleteFromS3(key)`
- S3 client configured via env vars: `S3_ASSETS_ENDPOINT`, `S3_ASSETS_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_ASSETS_BUCKET`
- Uses `forcePathStyle: true` for MinIO/local S3 compatibility
- Key format: `{folder}/{entityId}-{timestamp}.webp` (immutable — timestamp makes keys unique for cache busting)

**Backend — Upload routes (`apps/server/src/routes/uploads.ts`):**
- `POST /uploads/avatar` — authenticated; multer memory storage (5 MB limit); file filter validates MIME + extension; sharp resizes to 256x256 webp; uploads to S3 under `avatars/` folder; updates `User.avatarUrl` in DB
- `POST /uploads/server-icon/:serverId` — authenticated + owner check; same image pipeline; uploads under `server-icons/` folder; updates `Server.iconUrl`; emits `server:updated` socket event for real-time sync
- `GET /uploads/*key` — unauthenticated streaming proxy; validates key against regex whitelist (`^(avatars|server-icons)/[\w-]+\.webp$`); sets aggressive cache headers (`immutable, max-age=31536000`); pipes S3 stream to response with client-disconnect cleanup
- Multer errors (file too large, unexpected field) handled in global `errorHandler.ts` middleware

**Backend — Server settings route (`apps/server/src/routes/servers.ts`):**
- `PATCH /:serverId` — now only accepts `name` field (removed `iconUrl` from body to prevent arbitrary S3 key injection; icon updates go through the dedicated upload endpoint)

**Backend — Auth service (`apps/server/src/services/authService.ts`):**
- `registerUser` select now includes `avatarUrl` in the returned user object

**Backend — Member broadcast (`apps/server/src/utils/memberBroadcast.ts`):**
- `broadcastMemberJoined` now includes `avatarUrl` in the user select for `member:joined` events

**Frontend — Avatar component (`apps/desktop/src/components/common/Avatar.tsx`):**
- Reusable `Avatar` component with four sizes (xs/sm/md/lg), fallback to initial letter, image error state, optional speaking ring indicator
- Constructs image URL from `avatarUrl` (S3 key) prefixed with `VITE_API_URL/uploads/`
- Used across: `ChannelSidebar` (user area, voice users), `ServerSidebar` (user section), `MemberSidebar` (member list), `MessageItem` (message author), `SettingsModal` (profile tab), `ServerSettingsModal` (icon preview)

**Frontend — Server settings modal (`apps/desktop/src/components/server/ServerSettingsModal.tsx`):**
- New modal for server owners: editable server name + icon upload with preview
- Object URL cleanup on unmount via `useEffect` return
- Calls `uploadServerIcon` then `updateServer` with proper error isolation

**Frontend — Create server modal (`apps/desktop/src/components/server/CreateServerModal.tsx`):**
- Icon picker added to server creation form; uploads icon after server creation succeeds
- Non-critical icon upload failure handled gracefully with `toast.warning`

**Frontend — Settings modal (`apps/desktop/src/components/settings/SettingsModal.tsx`):**
- Profile tab now shows clickable Avatar with upload overlay; calls `authStore.uploadAvatar`

**Frontend — Server sidebar (`apps/desktop/src/components/server/ServerSidebar.tsx`):**
- Server icons rendered from S3 URL when `iconUrl` is set; falls back to initials

**Frontend — Stores:**
- `authStore.ts` — new `uploadAvatar(file)` action: FormData POST to `/uploads/avatar`, updates local user state with returned key
- `serverStore.ts` — new `uploadServerIcon(serverId, file)`, `updateServer(serverId, fields)`, and `updateServerData(server)` methods; local state updated via `server:updated` socket event (single source of truth pattern)

**Shared package:**
- `Server` type already had `iconUrl: string | null`; `MessageAuthor` already had `avatarUrl: string | null`
- `ServerToClientEvents` already had `server:updated`; `WS_EVENTS.SERVER_UPDATED` constant already defined
- No shared package changes required for this feature

**Review fixes applied:**
1. Upload route now emits `server:updated` after icon upload (was missing -- other users would not see icon changes in real-time)
2. Removed `iconUrl` from `PATCH /servers/:serverId` body to prevent arbitrary S3 key injection (icon updates must go through the upload endpoint)
3. S3 file-serving key validation strengthened from `!key.includes('..')` to a regex whitelist matching only known folder/filename patterns
4. Upload-then-delete ordering: new file is uploaded and DB updated before deleting the old file, preventing data loss on upload failure
5. S3 stream cleanup on client disconnect to prevent resource leaks

**New files:**
- `apps/server/src/utils/s3.ts`
- `apps/server/src/routes/uploads.ts`
- `apps/desktop/src/components/common/Avatar.tsx`
- `apps/desktop/src/components/server/ServerSettingsModal.tsx`

**New dependencies:** `@aws-sdk/client-s3`, `sharp`, `multer`, `@types/multer`

### Real-Time Avatar & Profile Sync (v0.3.3)

**Problem 1 — Broken images after upload:** Avatar and server icon uploads succeeded (S3 key stored in DB) but rendered as broken images in the browser.

**Root cause (Express route pattern):** The upload serve route used `/*key` which is Express 5 syntax. In Express 4, this means a wildcard followed by a literal "key" suffix, so no requests matched. Fixed by changing the route pattern to `/*` and accessing the key via `req.params[0]`.

**Root cause (Helmet CORS):** Even after the route fix, cross-origin `<img>` loads failed. Helmet's default `Cross-Origin-Resource-Policy: same-origin` header blocked the browser from loading images cross-origin (frontend on `:8080`, API on `:3001`). Additionally, CSP `img-src 'self' data:` blocked cross-origin image sources. Fixed by configuring Helmet with `crossOriginResourcePolicy: { policy: 'cross-origin' }` and adding frontend origins to `imgSrc` and `connectSrc` directives.

**Problem 2 — Avatar change requires page refresh for current user:** `authStore.uploadAvatar` only updated the auth store. The member sidebar reads from `serverStore` and messages read from `chatStore`, so the UI was stale.

**Fix:** Cross-store propagation — `uploadAvatar` now also calls `serverStore.updateMemberAvatar(userId, key)` and `chatStore.updateAuthorAvatar(userId, key)` for immediate local UI updates. New store methods:
- `serverStore.updateMemberAvatar(userId, avatarUrl)` — updates the member's avatar in the member list
- `chatStore.updateAuthorAvatar(userId, avatarUrl)` — updates all messages from that author

**Problem 3 — Avatar/profile changes not visible to other users in real-time:** No socket event was emitted when a user changed their avatar or display name.

**Fix — `user:updated` event:**
- **Shared package:** Added `user:updated` event to `ServerToClientEvents` carrying `{ userId, displayName, avatarUrl }`. Added `USER_UPDATED` to `WS_EVENTS` constants.
- **Server (`routes/uploads.ts`):** After avatar upload, broadcasts `user:updated` to all `server:{id}` rooms the user belongs to.
- **Server (`routes/users.ts`):** After profile update (displayName/avatarUrl), broadcasts `user:updated` to all `server:{id}` rooms.
- **Frontend (`MainLayout.tsx`):** New `userUpdated` handler calls `serverStore.updateMemberProfile(userId, { displayName, avatarUrl })` and `chatStore.updateAuthorProfile(userId, { displayName, avatarUrl })` for real-time updates across all UI components.
- **Frontend stores:** New `serverStore.updateMemberProfile()` and `chatStore.updateAuthorProfile()` methods for batch-updating user fields across member lists and message histories.

**Additional changes:**
- **`bio` field in User type:** Added `bio: string | null` to the shared `User` interface (already existed in DB, now exposed in types). Added to `authService.ts` register select, `memberBroadcast.ts` select, and `serverStore.addMember` user construction.
- **Settings modal restructured:** Two-tab layout (My Account | Audio & Video) with left-nav. Profile tab has clickable avatar upload, displayName input, bio textarea, and Save button. Audio settings moved to second tab.
- **Avatar component fix:** Added `useEffect` to reset `imgError` state when `avatarUrl` prop changes (prevents stale broken-image state when a new avatar is uploaded).

**Files modified:**
- `packages/shared/src/types.ts` — `bio` on User, `user:updated` event on ServerToClientEvents
- `packages/shared/src/constants.ts` — `USER_UPDATED` in WS_EVENTS
- `apps/server/src/app.ts` — Helmet CORS configuration
- `apps/server/src/routes/uploads.ts` — Route pattern fix (`/*`), `user:updated` emit on avatar upload
- `apps/server/src/routes/users.ts` — `user:updated` emit on profile update
- `apps/server/src/services/authService.ts` — `bio` in register select
- `apps/server/src/utils/memberBroadcast.ts` — `bio` in select and emitted object
- `apps/desktop/src/stores/authStore.ts` — Cross-store propagation in `uploadAvatar`, new `updateProfile` method
- `apps/desktop/src/stores/serverStore.ts` — `updateMemberAvatar`, `updateMemberProfile` methods, `bio` in `addMember`
- `apps/desktop/src/stores/chatStore.ts` — `updateAuthorAvatar`, `updateAuthorProfile` methods
- `apps/desktop/src/components/common/Avatar.tsx` — `imgError` reset on prop change
- `apps/desktop/src/components/settings/SettingsModal.tsx` — Tab restructure with Profile tab
- `apps/desktop/src/components/layout/MainLayout.tsx` — `userUpdated` handler

### 15. Password Reset & Change (v0.4.0)

Full "forgot password" flow and authenticated password change:

**Backend:**
- Prisma schema: `resetToken` (unique, SHA-256 hashed) and `resetTokenExpiresAt` fields on User model, with migration
- `utils/email.ts`: Nodemailer transporter with configurable SMTP (defaults to local Mailhog on port 1025)
- `services/authService.ts`: `requestPasswordReset()` (generates 32-byte token, hashes with SHA-256 before storing, emails raw token to user; silent return on unknown email to prevent enumeration), `resetPassword()` (validates token, checks expiry, clears expired tokens, hashes new password), `changePassword()` (verifies current password, validates new password via shared validator)
- `routes/auth.ts`: Three new endpoints with input type guards (`/forgot-password`, `/reset-password`, `/change-password`)
- New env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `CLIENT_URL`
- New dependency: `nodemailer` + `@types/nodemailer`

**Frontend:**
- `pages/ForgotPasswordPage.tsx`: Email submission form with success/error states
- `pages/ResetPasswordPage.tsx`: New password form with confirmation, password visibility toggle, shared `LIMITS.PASSWORD_MIN` validation
- `App.tsx`: Routes for `/forgot-password` and `/reset-password/:token` (redirects to main if authenticated)
- `pages/LoginPage.tsx`: "Forgot password?" link
- `components/settings/SettingsModal.tsx`: Password change section in ProfileTab with current/new/confirm fields
- `stores/authStore.ts`: `forgotPassword()`, `resetPassword()`, `changePassword()` methods

**Files changed:**
- `apps/server/prisma/schema.prisma` — `resetToken` (unique) and `resetTokenExpiresAt` fields
- `apps/server/prisma/migrations/20260226154713_add_password_reset_fields/migration.sql`
- `apps/server/src/utils/email.ts` (new)
- `apps/server/src/services/authService.ts` — three new exported functions
- `apps/server/src/routes/auth.ts` — three new route handlers
- `apps/server/.env.example` — SMTP and CLIENT_URL vars
- `apps/desktop/src/stores/authStore.ts` — three new store methods
- `apps/desktop/src/pages/ForgotPasswordPage.tsx` (new)
- `apps/desktop/src/pages/ResetPasswordPage.tsx` (new)
- `apps/desktop/src/App.tsx` — two new routes
- `apps/desktop/src/pages/LoginPage.tsx` — forgot password link
- `apps/desktop/src/components/settings/SettingsModal.tsx` — password change section

### 15a. Token Version & Security Hardening (v0.4.0 follow-up)

Security hardening for the password reset/change feature:

**Token version-based refresh token invalidation:**
- Prisma schema: `tokenVersion Int @default(0)` on User model, with migration
- `generateTokens()` now embeds `tokenVersion` in both access and refresh JWTs
- `refreshTokens()` checks `tokenVersion` in JWT matches DB value; rejects mismatches with "Token has been revoked". Pre-migration tokens (missing `tokenVersion`) are treated as version 0 for backward compatibility.
- `resetPassword()` and `changePassword()` both increment `tokenVersion`, invalidating all existing refresh tokens across all devices/sessions
- `changePassword()` returns fresh tokens so the current session survives the version bump; frontend stores them in localStorage

**Other fixes:**
- `requestPasswordReset()` wraps `sendPasswordResetEmail` in try/catch to prevent SMTP failures from revealing email existence via 500 errors
- `resetPassword()` uses `findUnique` instead of `findFirst` on the `@unique` `resetToken` field
- `ChangePasswordForm` extracted as standalone component from `ProfileTab`
- `AuthPayload` interface includes `tokenVersion: number`
- `refreshTokens()` error handling re-throws `UnauthorizedError` instances (revoked tokens, user not found) while wrapping unexpected errors (DB failures) generically

**Files changed:**
- `apps/server/prisma/schema.prisma` — `tokenVersion` field
- `apps/server/src/middleware/auth.ts` — `tokenVersion` in `AuthPayload`
- `apps/server/src/services/authService.ts` — tokenVersion threading in all auth functions
- `apps/server/src/routes/auth.ts` — `change-password` route returns tokens
- `apps/desktop/src/stores/authStore.ts` — `changePassword` stores fresh tokens
- `apps/desktop/src/components/settings/SettingsModal.tsx` — `ChangePasswordForm` extraction

### 16. Server Sidebar Unread Badge (v0.4.0)

Enhanced unread indicators on the server sidebar:

- **Orange left border:** Servers with unread messages show `border-orange-500` instead of the previous barely-visible `border-white/30`
- **Count badge:** A rounded orange badge (`bg-orange-500`) appears at the bottom-right of the server icon displaying the unread message count. Capped at `99+` for overflow. Uses `ring-2 ring-vox-sidebar` for clean separation from the icon.
- Badge is hidden when the server is the active server

**Files changed:**
- `apps/desktop/src/components/server/ServerSidebar.tsx` — unread border color + count badge

### 17. Persistent Unread Tracking (v0.4.1)

**Problem:** Unread message counts were stored only in Zustand in-memory state. When the user refreshed the page or disconnected/reconnected, all unread information was lost.

**Solution:** Server-side read tracking via a `ChannelRead` table storing `lastReadAt` per user per channel. On socket connect, unread counts are computed via a single SQL query and emitted to the client. The existing live `incrementUnread`/`clearUnread` logic stays unchanged for real-time responsiveness.

**Database (`apps/server/prisma/schema.prisma`):**
- New `ChannelRead` model with composite PK `(userId, channelId)`, `lastReadAt` timestamp, cascade deletes from User and Channel
- Reverse relations added: `channelReads` on User, `reads` on Channel

**Shared package:**
- `UnreadCount` interface: `{ channelId, serverId, count }`
- `unread:init` event added to `ServerToClientEvents`
- `UNREAD_INIT` constant added to `WS_EVENTS`

**Backend — Socket handler (`apps/server/src/websocket/socketServer.ts`):**
- After auto-joining text channel rooms, executes a single raw SQL query computing unread counts across all channels in one DB round trip (messages after `COALESCE(lastReadAt, '1970-01-01')`)
- Emits `unread:init` with `{ unreads: UnreadCount[] }` only if there are unreads
- Uses existing `[channelId, createdAt]` index on messages table

**Backend — Channel route (`apps/server/src/routes/channels.ts`):**
- `POST /:channelId/read` — authenticated, membership-checked; upserts `ChannelRead` with `lastReadAt = now()`

**Backend — Server create/join seeding:**
- `routes/servers.ts` (create): Seeds `ChannelRead` for the creator on the default `#general` text channel
- `routes/servers.ts` (join): Seeds `ChannelRead` for all text channels in the joined server
- `routes/invites.ts` (invite join): Seeds `ChannelRead` for all text channels via `createMany`
- This prevents existing message history from showing as unread for new members

**Frontend — Server store (`stores/serverStore.ts`):**
- `initUnreadCounts(unreads)` — Full replace of `unreadCounts` and `serverUnreadCounts` from server data
- `markChannelRead(channelId)` — Fire-and-forget `api.post(/.../channels/:id/read)`
- `setActiveChannel()` — Now calls `markChannelRead()` after `clearUnread()` to persist read state

**Frontend — MainLayout (`components/layout/MainLayout.tsx`):**
- `unread:init` handler calls `initUnreadCounts(unreads)`, then clears/marks the active channel if the user is already viewing one

**Files changed:**
- `apps/server/prisma/schema.prisma` — `ChannelRead` model + reverse relations
- `apps/server/prisma/migrations/20260226170434_add_channel_reads/migration.sql`
- `packages/shared/src/types.ts` — `UnreadCount` interface, `unread:init` event
- `packages/shared/src/constants.ts` — `UNREAD_INIT` constant
- `apps/server/src/websocket/socketServer.ts` — unread count SQL query + emit
- `apps/server/src/routes/channels.ts` — `POST /:channelId/read` endpoint
- `apps/server/src/routes/servers.ts` — ChannelRead seeding on create and join
- `apps/server/src/routes/invites.ts` — ChannelRead seeding on invite join
- `apps/desktop/src/stores/serverStore.ts` — `initUnreadCounts`, `markChannelRead` methods
- `apps/desktop/src/components/layout/MainLayout.tsx` — `unread:init` handler

### 18. Direct Messages (DM) Feature

**Summary:** Full 1-on-1 direct messaging between users, with real-time delivery, typing indicators, reactions, unread tracking, and persistent read state.

**Database (`apps/server/prisma/schema.prisma`):**
- `Conversation` model: composite unique `(user1Id, user2Id)` with `user1Id < user2Id` invariant for deduplication
- `ConversationRead` model: composite PK `(userId, conversationId)`, `lastReadAt` timestamp, cascade deletes
- `Message` model: `channelId` made nullable, new nullable `conversationId` foreign key; index on `[conversationId, createdAt]`
- Reverse relations added on `User` for both conversation sides and reads

**Shared package (`packages/shared`):**
- `Conversation` interface with `participant` (the other user), `lastMessage` preview
- `DMUnreadCount` interface
- DM socket events added to `ServerToClientEvents` and `ClientToServerEvents`: `dm:message:new`, `dm:message:update`, `dm:message:delete`, `dm:typing:start/stop`, `dm:message:reaction_update`, `dm:unread:init`, `dm:join`
- `WS_EVENTS` constants for all DM events

**Backend — DM routes (`apps/server/src/routes/dm.ts`):**
- `GET /dm` — list conversations with last message preview, sorted by `updatedAt`
- `POST /dm` — create-or-get conversation (upsert pattern with `sortUserIds` for uniqueness)
- `GET /dm/:conversationId/messages` — cursor-paginated messages with reaction aggregation
- `POST /dm/:conversationId/messages` — send DM, emits `dm:message:new` to room
- `PATCH /dm/:conversationId/messages/:messageId` — edit own DM message
- `DELETE /dm/:conversationId/messages/:messageId` — delete own DM message
- `PUT /dm/:conversationId/messages/:messageId/reactions/:emoji` — toggle reaction
- `POST /dm/:conversationId/read` — mark conversation as read (upsert)
- All routes check conversation participation via `getConversationOrThrow()`

**Backend — Extracted utility (`apps/server/src/utils/reactions.ts`):**
- `aggregateReactions()` and `reactionInclude` extracted from messages route, shared by DM and channel message routes

**Backend — Socket handler (`apps/server/src/websocket/socketServer.ts`):**
- `dm:join` handler with authorization check (verifies conversation membership via DB query before joining room)
- `dm:typing:start/stop` handlers with `socket.rooms.has()` guard to prevent unauthorized emission
- Auto-join all conversation rooms on socket connect
- DM unread count computed via raw SQL query and emitted as `dm:unread:init`

**Frontend — DM store (`stores/dmStore.ts`):**
- Zustand store managing conversations list, active conversation, DM unread counts
- `fetchConversations()`, `openDM(userId)`, `setActiveConversation()`, `markConversationRead()`
- Unread tracking: `incrementDMUnread()`, `clearDMUnread()`, `initDMUnreadCounts()`, `totalDMUnread()`

**Frontend — DM components:**
- `DMList` — conversation list with unread badges, participant avatars, last message preview
- `DMChatArea` — DM chat view with header, message list, input; handles room join/reconnect
- `DMMessageList` — scrollable message list with cursor pagination, typing indicator, beginning-of-conversation marker

**Frontend — Modified components:**
- `MainLayout` — DM socket event handlers (message new/update/delete, typing, reactions, unread init); DM view rendering when no server is active
- `ServerSidebar` — DM unread badge on Voxium home button
- `MessageInput` — DM typing/send support via `conversationId` prop
- `MessageItem` — DM edit/delete/reaction support via `conversationId` prop
- `ReactionDisplay` — DM reaction toggle via `conversationId` prop
- `DeleteConfirmModal` — DM delete support via `conversationId` prop
- `UserProfilePopup` — "Message" button to open DM conversation

**Files added:**
- `apps/server/src/routes/dm.ts`
- `apps/server/src/utils/reactions.ts`
- `apps/desktop/src/stores/dmStore.ts`
- `apps/desktop/src/components/dm/DMList.tsx`
- `apps/desktop/src/components/dm/DMChatArea.tsx`
- `apps/desktop/src/components/dm/DMMessageList.tsx`

**Files modified:**
- `apps/server/prisma/schema.prisma`
- `packages/shared/src/types.ts`
- `packages/shared/src/constants.ts`
- `apps/server/src/app.ts`
- `apps/server/src/websocket/socketServer.ts`
- `apps/server/src/routes/messages.ts`
- `apps/desktop/src/stores/chatStore.ts`
- `apps/desktop/src/components/layout/MainLayout.tsx`
- `apps/desktop/src/components/server/ServerSidebar.tsx`
- `apps/desktop/src/components/chat/MessageInput.tsx`
- `apps/desktop/src/components/chat/MessageItem.tsx`
- `apps/desktop/src/components/chat/ReactionDisplay.tsx`
- `apps/desktop/src/components/chat/DeleteConfirmModal.tsx`
- `apps/desktop/src/components/common/UserProfilePopup.tsx`

**Review fixes applied:**
- CRITICAL: `dm:join` socket handler now verifies conversation membership via DB query before joining the room (was previously unauthenticated, allowing any user to eavesdrop on DM events)
- CRITICAL: `dm:typing:start/stop` handlers now check `socket.rooms.has()` to prevent unauthorized typing indicator injection
- Removed unused `currentUser` DB query in `POST /dm` route (fetched but never used)
- Fixed copy-paste bug in `DMMessageList` typing indicator text (multi-user branch was identical to single-user branch)

### Known Issues / Suggestions
- `io.fetchSockets()` in `memberBroadcast.ts` retrieves ALL connected sockets. Fine for small deployments but at scale, use a `userId -> socketId[]` index or Redis adapter's `remoteJoin`/`remoteLeave`.
- ~~The `member:joined` event sends `email: ''` to satisfy the `User` type in `ServerToClientEvents`. Consider a `PublicUser` type that omits `email`.~~ **Resolved** — `PublicUser` type added and `member:joined` uses it.
- ~~Prisma `Invite` model still has `maxUses` and `uses` columns that are no longer used. Cleanup migration pending.~~ **Resolved** — columns removed.
- ~~`SaveAndRedirect` in `App.tsx` performs `localStorage.setItem` during render (not in `useEffect`). Functionally correct since `Navigate` redirects immediately, but technically impure.~~ **Resolved** — wrapped in `useEffect`.
- ~~PTT key press/release emits `voice:mute` on every toggle, which triggers a `voice:state_update` broadcast to the entire `server:{id}` room. For rapid PTT toggling, consider debouncing or rate-limiting these emissions.~~ **Resolved** — PTT debounce implemented in `usePushToTalk.ts` with 150ms timeout on mute emission.
- The PTT mode-switch subscription emits `voice:mute true` to the server but does not update `selfMute` in the voice store. This is intentional (`selfMute` represents the user's manual mute preference, not PTT transient state), but the mute icon in `VoicePanel`/`ChannelSidebar` may show "unmuted" while PTT is active and the key is not held.
- The `validateEmoji()` function accepts mixed strings containing at least one non-ASCII character (e.g., text+emoji). The 32-character length limit and React's JSX escaping mitigate risk, but a stricter validator could use Unicode emoji property matching.
- The `MAX_REACTIONS_PER_MESSAGE` limit check in the reaction toggle endpoint has a TOCTOU race: between the `groupBy` count and the `create`, another request could add a new distinct emoji, exceeding the limit. The unique constraint prevents true duplicates, but the soft limit can be exceeded by 1 under concurrent requests to different emoji. Acceptable for current scale.
- ~~Pre-existing: `leavingUser` variable in `MainLayout.tsx` line 102 is assigned but never read (dead code from voice user left handler).~~ Fixed in DM voice bug fix review (2026-02-27).
- ~~The S3 utility (`s3.ts`) uses non-null assertions (`!`) on all env vars. If any are missing, the error surfaces as a cryptic AWS SDK error at runtime rather than a clear startup failure. Consider validating env vars at startup.~~ **Resolved** — startup env var validation in `index.ts` checks all S3 vars before boot.
- The `GET /uploads/*key` route is unauthenticated, relying on key unguessability (userId/serverId + timestamp) and regex validation. It now redirects (302) to presigned S3 GET URLs rather than streaming. The presigned URLs have a 1-hour expiry, limiting exposure of direct S3 access.
- ~~The `multer` file filter checks both MIME type and file extension, but MIME types from `Content-Type` headers are client-controlled and can be spoofed.~~ **Resolved in presigned URL migration** -- multer and server-side sharp removed; image processing moved to client, server no longer handles file bytes.
- ~~The `PATCH /users/me/profile` route still accepts `avatarUrl` in the body, which could be used to set an arbitrary S3 key.~~ **Resolved in presigned URL migration** -- ownership check added (`avatarUrl` must start with `avatars/{userId}-`), S3 key regex validation retained.
- ~~`ServerSettingsModal` and `CreateServerModal` duplicate the icon selection/preview/cleanup logic. Consider extracting a shared `ImageUploadButton` component.~~ **Resolved** — shared `ImageUploadButton` component extracted to `components/common/ImageUploadButton.tsx`.
- ~~The `/forgot-password` endpoint has no rate limiting. An attacker could trigger mass emails to a valid address. Consider adding per-IP or per-email rate limiting when rate limiter infrastructure is implemented.~~ **Resolved** — `rateLimitForgotPassword` (3 req/15min per IP) wired up.
- Socket.IO authentication middleware validates the JWT signature at handshake time but does not check `tokenVersion` against the database. After a password change or reset, a revoked access token can maintain an existing WebSocket connection for its remaining lifetime. This is the standard JWT trade-off -- access tokens are stateless and short-lived (15 min). Periodic re-authentication on the socket would require architectural changes (middleware on every socket event or periodic disconnect/reconnect).
- `io.fetchSockets()` in `routes/dm.ts` (POST /dm, conversation creation) iterates ALL connected sockets to find the two participants' sockets to join them to the new DM room. Same scalability concern as `memberBroadcast.ts`. Consider a `userId -> socketId[]` index.
- The `chatStore` uses module-level `activeFetchController` and `lastFetchKey` singletons shared between channel messages and DM messages. This works because only one view (channel chat or DM chat) is active at a time, but it's fragile -- if the UI ever renders both simultaneously, they would interfere with each other. Consider scoping these per-context.
- ~~DM `before` query parameter (cursor pagination) uses `new Date(before)` without validating the date string. An invalid date string like `"foo"` produces `Invalid Date`, which Prisma passes to PostgreSQL where it will throw. The existing channel messages route has the same pattern. Consider adding date validation.~~ **Resolved** — `parseDateParam()` utility added to `utils/errors.ts`, applied in `messages.ts`, `dm.ts`, and `search.ts`.
- `chatStore.sendDMMessage` has a fallback pattern that adds the sent message locally if not yet received via WebSocket. This can cause brief duplicates (the addMessage dedup check prevents permanent duplicates). The same pattern exists for channel messages and is acceptable.
- ~~The `UserProfilePopup` "Message" button only works when the user is viewing a server (it depends on `member` being found in the server store's member list). If the user is already in the DM view and opens a profile popup for someone not in the current server's member list, the popup renders `null`. Consider a fallback that fetches user data directly.~~ **Resolved** — fallback `GET /users/:userId` API fetch added for DM context; popup resolves from `member?.user ?? fetchedUser`.
- ~~DM conversations cannot currently be deleted or archived by users. The `Conversation` model has no soft-delete mechanism.~~ **Resolved in v0.7.0** — `DELETE /dm/:conversationId` endpoint with cascade delete (messages + reads) and real-time `dm:conversation:deleted` event.
- The `ChannelSidebar` `handleSelectTextChannel` calls `clearMessages()` then `fetchMessages()` manually rather than letting `setActiveChannel` drive the flow. If `setActiveChannel` is ever changed to also clear/fetch messages, this would double-fetch. Low risk but worth noting.
- ~~The channel PATCH endpoint only supports `categoryId` updates. If more fields need updating in the future (e.g., channel name, position reorder), consider expanding the PATCH to accept an update object rather than requiring `categoryId`.~~ **Resolved in v0.9.4** — bulk reorder endpoints (`PUT /reorder`) added for both channels and categories, handling position + categoryId updates in a single transaction.
- The `validateCategoryName` function only validates length (no character restriction). This is consistent with `validateServerName` but differs from `validateChannelName` which restricts to alphanumeric/underscore/hyphen. Category names may intentionally be more permissive (e.g., "Text Channels" with spaces).
- ~~New text channels created via the channel POST route (with or without `categoryId`) do not seed `ChannelRead` for existing members. This means existing message history in the channel appears as unread. However, this was a pre-existing behavior before the categories feature.~~ **Resolved** — `ChannelRead` records now seeded for all server members on text channel creation.

### Channel Categories Feature (v0.9.3 Review, 2026-02-28)

**What was changed:**
- New `Category` Prisma model with `id`, `name`, `serverId`, `position`, `createdAt`, `updatedAt`. `Channel.categoryId` (nullable FK, `onDelete: SetNull`).
- CRUD API at `/api/v1/servers/:serverId/categories` (POST, PATCH, DELETE). Rate-limited with `rateLimitCategoryManage`.
- Channel POST now accepts optional `categoryId`. New channel PATCH endpoint for moving channels between categories.
- Frontend `ChannelSidebar` rewritten with collapsible category sections, localStorage-persisted collapse state, inline create/delete UI for categories.
- Socket events `category:created`, `category:updated`, `category:deleted` with full real-time sync.
- Default server creation seeds "Text Channels" and "Voice Channels" categories.

**Review fixes applied:**
- Added missing rate limiter on `PATCH /channels/:channelId` (was unprotected).
- Added missing `sanitizeText` on channel name in `POST /channels` (pre-existing gap, fixed as part of this change).
- Fixed category deletion to re-read orphaned channels from DB after delete instead of emitting stale in-memory data with manually spread `categoryId: null`.

---

### Review: DM Voice Calls Implementation (2026-02-27)

**New files:**
- `apps/server/src/websocket/dmVoiceHandler.ts` -- Server-side DM voice signaling (in-memory state, conversation participant verification, cross-cleanup with server voice)
- `apps/desktop/src/components/dm/IncomingCallModal.tsx` -- Incoming call UI with accept/decline buttons
- `apps/desktop/src/services/notificationSounds.ts` -- `playCallSound()` added (ascending 3-tone pattern)

**Modified files:**
- `packages/shared/src/types.ts` -- Added 7 DM voice events to `ServerToClientEvents`, 6 to `ClientToServerEvents`
- `packages/shared/src/constants.ts` -- Added `DM_VOICE_*` constants to `WS_EVENTS`
- `apps/server/src/websocket/socketServer.ts` -- Registered `handleDMVoiceEvents` handler
- `apps/server/src/websocket/voiceHandler.ts` -- Exported `leaveCurrentVoiceChannel`, added `leaveCurrentDMVoiceChannel` cross-cleanup on `voice:join`
- `apps/desktop/src/stores/voiceStore.ts` -- Added DM call state (`dmCallConversationId`, `dmCallUsers`, `incomingCall`) and methods (`joinDMCall`, `leaveDMCall`, `acceptCall`, `declineCall`, `handleDMSignal`, `createDMPeer`)
- `apps/desktop/src/components/layout/MainLayout.tsx` -- Added 7 DM voice socket event handlers + `IncomingCallModal` render
- `apps/desktop/src/components/dm/DMChatArea.tsx` -- Added call/end-call button in header + active call banner
- `apps/desktop/src/components/voice/VoicePanel.tsx` -- Extended to render for DM calls (shows "DM Call" header, DM participant name, DM call users)

**Architecture decisions:**
- DM voice uses the same mesh P2P WebRTC approach as server voice channels
- Server and DM voice are mutually exclusive (joining one leaves the other via cross-cleanup on both server and client)
- DM voice state is in-memory on server (`dmVoiceUsers` Map + `userDMCall` reverse lookup), same approach as server voice
- Shared `peers` and `remoteAudios` maps in `voiceStore` are reused across server/DM voice (safe due to mutual exclusivity)
- Call offer broadcasts to `dm:{conversationId}` room (both participants are auto-joined on connect); ringing is a single sound, not a repeating ringtone
- Three `disconnecting` handlers are registered per socket (socketServer, voiceHandler, dmVoiceHandler) -- Socket.IO supports multiple handlers, all fire correctly

**Review fixes applied:**
- CRITICAL: Added `conversationId` guards to `dmVoiceJoined`, `dmVoiceLeft`, `dmVoiceStateUpdate`, `dmVoiceSpeaking`, and `dmVoiceSignal` handlers in `MainLayout.tsx`. Without these, DM voice events for conversations the user is not in a call for would leak through (since the socket is in `dm:{id}` rooms for ALL conversations for message delivery), causing phantom users in `dmCallUsers` and spurious peer connections.
- WARNING: Reordered `dm:voice:left` and `dm:voice:ended` emission in `dmVoiceHandler.ts` so `left` fires before `ended` when the last user departs. Previously `ended` fired first, which caused `leaveDMCall()` to clear all state before the `left` event arrived.
- WARNING: Added guard in `dmVoiceOffer` handler to ignore incoming calls when the user is already in a server voice channel or DM call, preventing the incoming call modal from overwriting state mid-call.

**Known issues / suggestions from this review:**
- ~~The call sound (`playCallSound`) plays once on offer receipt. For a real ringing experience, it should loop until accepted/declined/timed out. Consider a repeating interval with auto-cancel.~~ **Resolved** — `startCallRingtone()`/`stopCallRingtone()` with looping pattern implemented in `notificationSounds.ts`, lifecycle managed by `IncomingCallModal`.
- ~~There is no call timeout. If User A calls User B and B never answers, the `incomingCall` modal persists indefinitely and User A sits in a solo call forever. Consider a server-side or client-side timeout (e.g., 30s) that auto-cancels the offer.~~ **Resolved** — server-side 30s timeout in `dmVoiceHandler.ts` auto-ends unanswered calls via `leaveCurrentDMVoiceChannel()`.
- ~~The `declineCall` method only clears `incomingCall` locally -- it does not notify the caller that the call was declined. The caller will remain in the call alone with no feedback. Consider emitting a `dm:voice:decline` event.~~ **Resolved** — `declineCall()` now emits `dm:voice:decline` to server, which ends the call for the caller via `leaveCurrentDMVoiceChannel()`.
- The `createDMPeer` method is largely a copy-paste of `createPeer` with `dm:voice:signal` instead of `voice:signal`. The two methods share 90%+ identical code. Consider extracting a shared `createPeerConnection(targetUserId, initiator, signalEvent)` factory to reduce duplication and ensure bug fixes apply to both paths.
- The `joinDMCall` method duplicates the audio setup logic from `joinChannel` (getUserMedia, PTT handling, speaking detection). Consider extracting a shared `acquireAudioStream()` helper.
- `handleDMSignal` is also a near-exact duplicate of `handleSignal` with different emit events. Same refactoring opportunity as `createDMPeer`.
- DM voice `disconnecting` handlers fire in all three places (socketServer, voiceHandler, dmVoiceHandler). The dmVoiceHandler's own `disconnecting` handler is redundant since `leaveCurrentDMVoiceChannel` is idempotent (checks `userDMCall.get(userId)` first). Not a bug, but unnecessary registration.
- Server-side `dm:voice:join` handler has an `await` for conversation verification, meaning a brief window where early signals could arrive before the user is fully registered. In practice, the other party hasn't received `dm:voice:joined` yet so they won't send signals, but worth noting for robustness.

---

### Review: DM Voice Bug Fixes & UI Update (2026-02-27)

**Modified files:**
- `apps/server/src/websocket/dmVoiceHandler.ts` -- Fixed join flow (emit both offer AND joined for first user) and leave flow (always end 1-on-1 calls, clean up remaining user state)
- `apps/desktop/src/components/layout/MainLayout.tsx` -- Fixed `dmVoiceEnded` handler to do inline cleanup instead of calling `leaveDMCall()` (avoids emitting `dm:voice:leave` back to server); removed unused `leavingUser` variable
- `apps/desktop/src/components/voice/VoicePanel.tsx` -- Reverted to server-voice-only (removed DM call rendering)
- `apps/desktop/src/components/dm/DMChatArea.tsx` -- Replaced small "In call" banner with `DMCallPanel` component

**New files:**
- `apps/desktop/src/components/dm/DMCallPanel.tsx` -- Discord-style call UI with large avatars, speaking indicators, mute/deaf/hangup controls

**Architecture decisions:**
- DM call UI is now rendered inline in `DMChatArea` (via `DMCallPanel`) rather than in the fixed-position `VoicePanel`. This separates concerns: `VoicePanel` handles server voice only, `DMCallPanel` handles DM calls only.
- `dmVoiceEnded` handler in `MainLayout.tsx` performs inline cleanup (stop latency, stop speaking detection, stop tracks, destroy peers, reset state) instead of calling `leaveDMCall()` to prevent emitting `dm:voice:leave` back to the server when the call was already ended server-side.

**Review fixes applied:**
- CRITICAL: `destroyAllPeers()` in `voiceStore.ts` now clears ICE restart timers (`iceRestartTimers.forEach/clear`). Previously, the inline `dmVoiceEnded` cleanup called `destroyAllPeers()` but did not clear ICE restart timers (they were module-private). A pending timer could fire after cleanup and act on destroyed peers or emit signals on a dead call. Redundant timer clears removed from `leaveChannel()` and `leaveDMCall()` since `destroyAllPeers()` now handles it centrally.
- CRITICAL: `leaveCurrentDMVoiceChannel()` in `dmVoiceHandler.ts` now removes the remaining user's socket from the `dm:voice:{conversationId}` room. Previously, only the leaving user's socket was removed; the other participant's socket stayed in the voice room indefinitely, causing a resource leak and potential issues on subsequent calls.
- WARNING: Removed unused `leavingUser` variable in `MainLayout.tsx` `voiceUserLeft` handler (dead code).

**Known issues / suggestions from this review:**
- The redundant `callUsers.size === 0` check in `leaveCurrentDMVoiceChannel` (after the loop that deletes remaining users) is a harmless safety net but makes the code harder to follow. Consider consolidating the cleanup logic.
- `createDMPeer` and `createPeer` remain near-identical code (flagged in previous review). The new `DMCallPanel` increases the surface area relying on this duplicated WebRTC logic.

---

### Review: DM Voice System Messages & Participant Status (2026-02-27)

**Modified files:**
- `apps/server/prisma/schema.prisma` -- Added `type String @default("user")` to Message model for distinguishing system vs user messages
- `apps/server/src/websocket/dmVoiceHandler.ts` -- Added `createSystemMessage()` helper to persist "Voice call started" / "Voice call ended" system messages to DB and broadcast via `dm:message:new`
- `packages/shared/src/types.ts` -- Added optional `type?: string` to Message interface
- `apps/desktop/src/stores/chatStore.ts` -- Removed ephemeral `addSystemMessage` and `SYSTEM_AUTHOR_ID` (system messages now come from server as persisted DB records)
- `apps/desktop/src/stores/dmStore.ts` -- Added `participantStatuses` map and `updateParticipantStatus` method for tracking DM partner online/offline status
- `apps/desktop/src/stores/voiceStore.ts` -- ICE timer cleanup centralized in `destroyAllPeers`, speaking detection mode parameter propagated correctly
- `apps/desktop/src/services/audioAnalyser.ts` -- Added `mode` parameter to `startSpeakingDetection` for dm vs server speaking events
- `apps/desktop/src/components/layout/MainLayout.tsx` -- `presenceUpdate` handler now also calls `useDMStore.getState().updateParticipantStatus()` for real-time status dot updates; added `stopSpeakingDetection` import for inline `dmVoiceEnded` cleanup
- `apps/desktop/src/components/dm/DMChatArea.tsx` -- Added `UserHoverTarget` on header avatar/name, status dot indicator using `participantStatuses`, initial status fetch via API
- `apps/desktop/src/components/dm/DMCallPanel.tsx` -- Simplified to avatar-only layout with speaking ring indicators
- `apps/desktop/src/components/dm/DMMessageList.tsx` -- System message rendering for `message.type === 'system'` with phone icon pill and formatted timestamp
- `apps/desktop/src/components/voice/VoicePanel.tsx` -- Reverted to server-voice-only rendering

**Database changes:**
- Migration `20260227020932_add_message_type` adds `type TEXT NOT NULL DEFAULT 'user'` column to `messages` table

**Architecture decisions:**
- System messages are now server-authoritative (persisted in DB with `type: 'system'`) rather than client-side ephemeral. This means call history is visible across sessions and to both participants.
- The `createSystemMessage` helper is fire-and-forget (errors logged but not propagated), ensuring voice flow is never blocked by message persistence failures.
- Participant presence status is tracked in `dmStore.participantStatuses` map, seeded on mount via API call and kept current via `presence:update` socket events.

**Review fixes applied:**
- Cleaned up unused destructured variables (`dmCallConversationId`, `localStream`, `localUserId`, `peers`) in `addDMCallUser` method of `voiceStore.ts`. The `setTimeout` callback correctly reads fresh state via `get()`, making the outer destructuring dead code.

**Known issues / suggestions from this review:**
- The `as unknown as Message` double cast in `createSystemMessage` (dmVoiceHandler.ts line 33) works but is fragile. A shared type assertion helper or Prisma return type mapping would be cleaner.
- The `VoiceState` interface in `voiceStore.ts` has grown to 38 members, mixing server voice, DM voice, and peer management concerns. While acceptable for Zustand's flat store pattern, this could benefit from logical grouping via nested objects in the future.
- `createDMPeer` and `createPeer` remain near-identical (flagged in two previous reviews). Consider extracting a shared `createPeerConnection(targetUserId, initiator, signalEvent)` function.
- `joinDMCall` and `joinChannel` share duplicated audio setup logic (getUserMedia, PTT handling, noise gate, speaking detection). A shared `acquireAudioStream()` helper would reduce duplication.

### Friend Request System (v0.6.0)

**New feature:** Users can send, accept, decline, and remove friend requests. The system supports real-time notifications via Socket.IO, with a dedicated Friends view in the DM panel and friend action buttons in user profile popups.

**Database (`apps/server/prisma/schema.prisma`):**
- New `Friendship` model with `requesterId`, `addresseeId`, `status` ("pending" | "accepted"), timestamps
- `@@unique([requesterId, addresseeId])` composite unique constraint (directional -- server code checks both directions via `OR` queries)
- `@@index([addresseeId])` for efficient lookup of incoming requests
- Cascade deletes from both `User` relations

**Server routes (`apps/server/src/routes/friends.ts`):**
- `GET /friends` -- List all friendships (pending + accepted) for the current user
- `POST /friends/request` -- Send friend request by username (case-insensitive). Auto-accepts if a reverse pending request exists.
- `POST /friends/:friendshipId/accept` -- Accept incoming request (addressee only)
- `DELETE /friends/:friendshipId` -- Remove/cancel/decline friendship (either party)
- `GET /friends/status/:userId` -- Check friendship status with a specific user

**Shared types (`packages/shared/src/types.ts`):**
- `FriendshipStatus`, `FriendUser`, `Friendship` interfaces
- `ServerToClientEvents`: `friend:request_received`, `friend:request_accepted`, `friend:removed`
- `WS_EVENTS` constants for all three friend events

**Frontend store (`apps/desktop/src/stores/friendStore.ts`):**
- Zustand store managing `friends`, `pendingIncoming`, `pendingOutgoing` arrays
- API methods: `fetchFriends`, `sendRequest`, `acceptRequest`, `removeFriendship`
- Socket handlers: `handleRequestReceived`, `handleRequestAccepted`, `handleFriendRemoved`
- `updateFriendStatus` for presence sync, `getFriendshipStatus` for UI lookups
- `showFriendsView` flag controls FriendsView rendering in the main layout

**Frontend components:**
- `FriendsView.tsx` -- Tabbed interface (Online / All / Pending / Add Friend) with count badges
- `FriendListItem.tsx` -- Row component with avatar, status dot, name, and context-appropriate action buttons (message/accept/decline/cancel/remove)
- `AddFriendForm.tsx` -- Username input with loading state and toast feedback
- `DMList.tsx` -- Added "Friends" button with pending count badge
- `UserProfilePopup.tsx` -- Friend action buttons (Add Friend / Pending / Accept+Decline / Unfriend) based on friendship status
- `MainLayout.tsx` -- Socket handlers for all three friend events, `fetchFriends` on reconnect, presence update propagation to friend store, FriendsView conditional rendering

**New files:**
- `apps/server/src/routes/friends.ts`
- `apps/desktop/src/stores/friendStore.ts`
- `apps/desktop/src/components/friends/FriendsView.tsx`
- `apps/desktop/src/components/friends/FriendListItem.tsx`
- `apps/desktop/src/components/friends/AddFriendForm.tsx`
- `apps/server/prisma/migrations/20260227151703_add_friendships/migration.sql`

**Review fixes applied:**
- Removed unused `isUserOnline` import from `friends.ts`
- Fixed `DELETE /friends/:friendshipId` to emit `friend:removed` to the other user for ALL statuses (pending + accepted), not just accepted friendships. Without this, declining a pending request or cancelling an outgoing request left stale entries in the other user's UI until page refresh.

**Known issues / suggestions from this review:**
- ~~`AddFriendForm` always toasts "Friend request sent" even when the request was auto-accepted (reverse pending existed). The `sendRequest` store method does not communicate the auto-accept outcome back to the form component. Minor UX issue.~~ **Resolved** — `sendRequest` now returns `'pending' | 'accepted'`; callers show appropriate toast.
- The `fetchFriends` filter logic (`f.addresseeId !== f.user.id` / `f.requesterId !== f.user.id`) is correct but unintuitive -- it relies on the fact that `f.user` is always the "other" user. A comment explaining the reasoning or comparing against the current user ID (passed as a parameter) would improve readability.
- Socket emission in REST routes uses `io.fetchSockets()` + loop to find target user sockets. This is O(n) over all connected sockets. For large deployments, consider using user-specific Socket.IO rooms (e.g., `user:{id}`) for O(1) targeted emission.

### Delete DM Conversation (v0.7.0)

**New feature:** Users can delete a DM conversation from the sidebar. Deleting removes the conversation for both participants (shared `Conversation` row), with Prisma cascade deletes automatically cleaning up all Messages and ConversationRead records. No schema changes were needed.

**Shared package (`packages/shared`):**
- Added `DM_CONVERSATION_DELETED: 'dm:conversation:deleted'` to `WS_EVENTS`
- Added `'dm:conversation:deleted'` to `ServerToClientEvents`

**Backend (`apps/server/src/routes/dm.ts`):**
- `DELETE /dm/:conversationId` — verifies participant via `getConversationOrThrow()`, deletes conversation (cascades messages + reads), emits `dm:conversation:deleted` to the `dm:{conversationId}` room, then removes all sockets from the room

**Frontend store (`apps/desktop/src/stores/dmStore.ts`):**
- `deleteConversation(conversationId)` — calls `DELETE /dm/:id`, then runs local cleanup
- `handleConversationDeleted(conversationId)` — removes from `conversations` array, clears `activeConversationId` if it matches, removes unread count entry

**Frontend UI (`apps/desktop/src/components/dm/DMList.tsx`):**
- X button on each conversation row, visible on hover via `opacity-0 group-hover:opacity-100`
- `onClick` uses `e.stopPropagation()` to prevent opening the conversation

**Frontend socket wiring (`apps/desktop/src/components/layout/MainLayout.tsx`):**
- Added `dmConversationDeleted` handler calling `useDMStore.getState().handleConversationDeleted()`
- Added `['dm:conversation:deleted', handlers.dmConversationDeleted]` to event map

**Files modified:**
- `packages/shared/src/constants.ts`
- `packages/shared/src/types.ts`
- `apps/server/src/routes/dm.ts`
- `apps/desktop/src/stores/dmStore.ts`
- `apps/desktop/src/components/dm/DMList.tsx`
- `apps/desktop/src/components/layout/MainLayout.tsx`

---

### DM Chat Loading Race Condition Fix (v0.7.0)

**Bug:** DM chat sometimes appeared empty (no messages) even when the conversation had messages. The issue was intermittent — a page refresh might or might not fix it.

**Root cause:** `clearMessages()` was called in multiple places (`DMList.handleOpenConversation`, `FriendListItem.handleMessage`, `UserProfilePopup.handleOpenDM`, `ServerSidebar` home button) *before* `setActiveConversation()`, but `DMChatArea`'s fetch effect used a `prevConvRef` guard that skipped refetching when the conversation ID hadn't changed. This created two failure modes:
1. **Same-conversation re-click:** `clearMessages()` wiped loaded messages, but the effect guard saw the same conversation ID and skipped the refetch — messages stayed empty permanently.
2. **Reconnect wipe:** `joinAndFetch()` in `DMChatArea` called `clearMessages()` before `fetchDMMessages()` on every reconnect. If the subsequent refetch failed (network timing, auth refresh), messages were gone with no retry mechanism.

**Fix — centralized `clearMessages()` ownership:**
- `dmStore.setActiveConversation()` now calls `clearMessages()` only when the conversation ID actually changes (guards with `get().activeConversationId !== conversationId`)
- `dmStore.clearActiveConversation()` now calls `clearMessages()` only when there was an active conversation
- Removed redundant `clearMessages()` calls from: `DMList.handleOpenConversation`, `DMList.handleOpenFriends`, `FriendListItem.handleMessage`, `UserProfilePopup.handleOpenDM`, `ServerSidebar` home button click
- Removed `clearMessages()` from `DMChatArea.joinAndFetch` — `fetchDMMessages()` atomically replaces messages on success; on failure, old messages are preserved instead of being wiped
- Cleaned up unused `useChatStore` imports from `DMList`, `FriendListItem`, `UserProfilePopup`, `ServerSidebar`

**Files modified:**
- `apps/desktop/src/stores/dmStore.ts` — centralized `clearMessages()` in `setActiveConversation` and `clearActiveConversation`
- `apps/desktop/src/components/dm/DMChatArea.tsx` — removed `clearMessages` from `joinAndFetch`, switched to selector for `fetchDMMessages`
- `apps/desktop/src/components/dm/DMList.tsx` — removed `clearMessages()` from `handleOpenConversation` and `handleOpenFriends`
- `apps/desktop/src/components/friends/FriendListItem.tsx` — removed `clearMessages()` from `handleMessage`
- `apps/desktop/src/components/common/UserProfilePopup.tsx` — removed `clearMessages()` from `handleOpenDM`
- `apps/desktop/src/components/server/ServerSidebar.tsx` — removed `clearMessages()` from home button click

**Design principle established:** `clearMessages()` should only be called by the store that owns the view transition (`dmStore.setActiveConversation` / `clearActiveConversation`), never by UI components directly. This prevents the "clear without refetch" race condition.

### Security Hardening (Input Validation, Sanitization, Rate Limiting)

**New shared validators** (`packages/shared/src/validators.ts`):
- `validateDisplayName()` — enforces non-empty after trim, max `LIMITS.DISPLAY_NAME_MAX` (64) characters
- `validateBio()` — enforces max `LIMITS.BIO_MAX` (500) characters

**New sanitize utility** (`apps/server/src/utils/sanitize.ts`):
- `stripHtml()` — regex-based HTML tag removal (defense-in-depth, since React escapes by default)
- `sanitizeText()` — strips HTML + trims whitespace; safely handles non-string inputs by returning empty string

**New rate limiter middleware** (`apps/server/src/middleware/rateLimiter.ts`):
- 8 rate limiters using `RateLimiterRedis` with lazy initialization
- In-memory `insuranceLimiter` fallback (100 req/60s) if Redis is unavailable
- Fail-open design: unexpected errors pass through to avoid blocking legitimate users
- Limiters: login (5/60s, 300s block), register (3/60s, 600s block), forgot-password (3/900s), reset-password (5/900s), message-send (30/60s), upload (10/60s), friend-request (20/60s), general (100/60s)
- Key strategies: `byIp` for unauthenticated routes, `byUserId` (falls back to IP) for authenticated routes

**Wiring into routes:**
- `auth.ts` — `rateLimitRegister` on POST /register, `rateLimitLogin` on POST /login, `rateLimitForgotPassword` on POST /forgot-password, `rateLimitResetPassword` on POST /reset-password
- `messages.ts` — `rateLimitMessageSend` on POST (send) + `sanitizeText` on POST (send) and PATCH (edit)
- `dm.ts` — `rateLimitMessageSend` on POST send DM + `sanitizeText` on POST (send) and PATCH (edit)
- `uploads.ts` — `rateLimitUpload` on POST avatar and POST server-icon
- `friends.ts` — `rateLimitFriendRequest` on POST /request
- `app.ts` — `rateLimitGeneral` on all `/api/v1` routes + JSON body limit reduced to 100kb

**Profile validation/sanitization** (`users.ts`):
- PATCH /me/profile validates `displayName` and `bio` with type guards, sanitization, and shared validators

**Server name sanitization** (`servers.ts`):
- POST / and PATCH /:serverId sanitize server name via `sanitizeText` + `validateServerName`

**Files created:**
- `apps/server/src/middleware/rateLimiter.ts`
- `apps/server/src/utils/sanitize.ts`

**Files modified:**
- `packages/shared/src/validators.ts` — added `validateDisplayName`, `validateBio`
- `apps/server/src/app.ts` — added `rateLimitGeneral`, reduced JSON limit to 100kb
- `apps/server/src/routes/auth.ts` — wired rate limiters
- `apps/server/src/routes/messages.ts` — wired rate limiter + sanitization
- `apps/server/src/routes/dm.ts` — wired rate limiter + sanitization
- `apps/server/src/routes/uploads.ts` — wired rate limiter
- `apps/server/src/routes/friends.ts` — wired rate limiter
- `apps/server/src/routes/users.ts` — added validation + sanitization for profile fields
- `apps/server/src/routes/servers.ts` — added sanitization for server name

### Rate Limiting Hardening & Avatar Validation (v0.7.1)

**Improvements from code quality review follow-up -- five warning-level issues addressed:**

**1. Trust proxy (`apps/server/src/app.ts`):**
- Added `app.set('trust proxy', 1)` so `req.ip` returns the real client IP behind reverse proxies instead of the proxy's IP. Without this, all rate limiting was keyed to a single IP when behind nginx/load balancers.

**2. Per-limiter memory fallbacks (`apps/server/src/middleware/rateLimiter.ts`):**
- Rewrote rate limiter module from a single shared insurance limiter to per-limiter fallbacks. Each `RateLimiterRedis` now has its own `RateLimiterMemory` with matching `points`, `duration`, and `blockDuration`. Previously, if Redis went down, all endpoints fell back to a single memory limiter with generic settings.
- Added `rateLimitRefresh` (10 requests/min by IP) for token refresh endpoint.
- Added `rateLimitChangePassword` (5 requests/min by IP, 5-minute block on exhaustion) for password change endpoint.

**3. Token refresh rate limiting (`apps/server/src/routes/auth.ts`):**
- Wired `rateLimitRefresh` on POST /refresh.
- Wired `rateLimitChangePassword` on POST /change-password (after `authenticate` middleware).

**4. Avatar URL validation (`apps/server/src/routes/users.ts`):**
- PATCH /me/profile now validates `avatarUrl`: must be `null` (to clear) or match the regex `^(avatars|server-icons)\/[\w-]+\.webp$` (matching the S3 key format from `uploadToS3`). This prevents arbitrary S3 key injection via the profile update endpoint.

**5. Socket.IO rate limiting (`apps/server/src/middleware/rateLimiter.ts` + `apps/server/src/websocket/socketServer.ts`):**
- New `socketRateLimit(socket, event, maxPerMinute)` function using a WeakMap keyed by socket objects. Each socket gets a Map of event-name to `{ count, resetAt }` buckets (fixed-window approach). When a socket disconnects and is garbage-collected, all its rate limit state is automatically cleaned up via WeakMap semantics.
- Applied to: `channel:join` (60/min), `channel:leave` (60/min), `typing:start`/`typing:stop` (shared `typing` key, 30/min), `dm:join` (60/min), `dm:typing:start`/`dm:typing:stop` (shared `dm:typing` key, 30/min).
- Voice events intentionally not rate-limited (high-frequency by nature).

### S3 Key Regex Extraction & Voice Signal Rate Limiting (v0.7.2)

**S3 key regex deduplication:**
- Extracted `VALID_S3_KEY_RE = /^(avatars|server-icons)\/[\w-]+\.webp$/` to `apps/server/src/utils/s3.ts` as a shared constant
- Replaced inline regex in `routes/uploads.ts` and `routes/users.ts` with the shared constant

**Voice signal rate limiting:**
- Added `socketRateLimit` on `voice:signal` (300/min) in `websocket/voiceHandler.ts`
- Added `socketRateLimit` on `dm:voice:signal` (300/min) in `websocket/dmVoiceHandler.ts`
- 300/min is generous for WebRTC signaling (ICE candidates, SDP) but prevents flood abuse

**Files modified:**
- `apps/server/src/utils/s3.ts` — added `VALID_S3_KEY_RE` export
- `apps/server/src/routes/uploads.ts` — imported shared regex
- `apps/server/src/routes/users.ts` — imported shared regex
- `apps/server/src/websocket/voiceHandler.ts` — added voice signal rate limiting
- `apps/server/src/websocket/dmVoiceHandler.ts` — added DM voice signal rate limiting

### WebRTC Perfect Negotiation for DM Calls (v0.8.0)

**Bug:** DM voice calls intermittently failed with `InvalidStateError: Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Failed to set remote answer sdp: Called in wrong state: stable`. This was an **offer glare** condition — both peers simultaneously created offers when initiating a DM call.

**Root cause:** When user A calls user B, the `dm:voice:offer` event causes B to call `acceptCall()` → `createDMPeer(A, true)` (as initiator). Meanwhile, A already called `createDMPeer(B, true)` (also as initiator). Both peers send offers; when one receives an answer while in `stable` state (having already processed the other's offer), the `setRemoteDescription` fails.

**Fix — WebRTC Perfect Negotiation pattern** (`apps/desktop/src/stores/voiceStore.ts`):
- Assigns **polite/impolite roles** based on userId comparison: `isPolite = localUserId < remoteUserId`
- On incoming offer, detects **collision** (`makingOffer || signalingState !== 'stable'`)
- **Impolite peer** ignores colliding offers (keeps its own offer)
- **Polite peer** rolls back its own offer via `setLocalDescription({ type: 'rollback' })`, then accepts the incoming offer
- On incoming answer, guards `signalingState === 'have-local-offer'` — stale answers from rolled-back offers are safely ignored
- Added `makingOffer` flag to `PeerConnection` tracking object to detect outgoing offer in-flight

**Files modified:**
- `apps/desktop/src/stores/voiceStore.ts` — rewrote `handleSignalInternal` with perfect negotiation pattern

### DM Call Accept Navigation (v0.8.0)

**Bug:** When accepting an incoming DM call via `IncomingCallModal`, the user wasn't navigated to the DM conversation — the call connected but the UI stayed on the current view.

**Fix:** `IncomingCallModal.handleAccept` now navigates to the DM conversation after accepting:
1. Clears active server (`activeServerId = null, activeChannelId = null`)
2. Closes friends view (`setShowFriendsView(false)`)
3. Sets active conversation (`setActiveConversation(conversationId)`)

**Files modified:**
- `apps/desktop/src/components/dm/IncomingCallModal.tsx` — added navigation on accept

### DMList Nested Button HTML Fix (v0.8.0)

**Bug:** Browser console error: `In HTML, <button> cannot be a descendant of <button>`. The DM conversation row was a `<button>` containing a delete `<button>`.

**Fix:** Changed the outer conversation row from `<button>` to `<div role="button" tabIndex={0}>` with `onKeyDown` handler for keyboard accessibility (Enter/Space triggers click).

**Files modified:**
- `apps/desktop/src/components/dm/DMList.tsx` — changed outer button to div with role="button"

### Tauri Desktop Icon Configuration (v0.8.0)

**Problem:** Tauri desktop client wasn't showing the Voxium logo in the window title bar or Windows taskbar.

**Fix:**
- Generated proper icon files from `logo_static.svg` using sharp: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png` (512x512), `icon.ico` (multi-resolution), `icon.icns`
- Added `image-png` feature flag to tauri dependency in `Cargo.toml`
- Set window icon programmatically in `lib.rs` via `tauri::include_image!("icons/icon.png")` macro in the `.setup()` hook
- Configured bundle icons in `tauri.conf.json`

**Files modified:**
- `apps/desktop/src-tauri/Cargo.toml` — added `image-png` feature to tauri
- `apps/desktop/src-tauri/src/lib.rs` — set window icon via `include_image!` macro
- `apps/desktop/src-tauri/tauri.conf.json` — configured bundle icon list
- `apps/desktop/src-tauri/icons/` — generated proper icon files from SVG

### Connection Banner "Reconnecting" Stuck Fix (v0.8.0)

**Bug:** After a user disconnects and reconnects, the "Reconnecting to Voxium..." banner at the top of the window stays visible permanently, even though the socket is connected and working fine.

**Root cause:** In `services/socket.ts`, `connectSocket()` has an early return path when the socket is already connected (`socket?.connected` is true). This path returned the socket without calling `setStatus('connected')`. If the status was still `'connecting'` from a prior connection attempt, the `ConnectionBanner` component would remain visible.

**Fix:** Added `setStatus('connected')` to the early return path in `connectSocket()`.

**Files modified:**
- `apps/desktop/src/services/socket.ts` — added `setStatus('connected')` in already-connected early return

### Remember Me Feature (v0.8.1)

**Feature:** Users can choose whether to persist their login session across app restarts via a "Remember me" checkbox on the login page.

**Architecture:**
- **Dual-storage abstraction** (`apps/desktop/src/services/tokenStorage.ts`): New module centralizing all token access. `rememberMe=true` stores in `localStorage` (persists across restart); `rememberMe=false` stores in `sessionStorage` (cleared on window close). Auto-detection logic preserves the original choice during token refresh.
- **Backend token expiry**: Refresh token expiry varies by `rememberMe` — 30 days (remembered) vs 24 hours (session-only). The `rememberMe` flag is embedded in the refresh token JWT payload so it survives refresh cycles.
- **Access token is clean**: `rememberMe` is stripped from access tokens since it is only relevant for refresh logic.
- **Backward compatible**: Existing refresh tokens (without `rememberMe` field) default to `rememberMe=true` via `payload.rememberMe ?? true`.

**Files created:**
- `apps/desktop/src/services/tokenStorage.ts` — dual-storage token abstraction with `getAccessToken()`, `getRefreshToken()`, `setTokens()`, `isRemembered()`, `clearTokens()`

**Files modified:**
- `packages/shared/src/types.ts` — added `rememberMe?: boolean` to `LoginRequest`
- `apps/server/src/middleware/auth.ts` — added `rememberMe?: boolean` to `AuthPayload`
- `apps/server/src/services/authService.ts` — `generateTokens()` accepts `rememberMe` param, `loginUser()` forwards it, `refreshTokens()` reads it from refresh token payload, `changePassword()` accepts and forwards it
- `apps/server/src/routes/auth.ts` — login and change-password routes extract `rememberMe` from request body
- `apps/desktop/src/stores/authStore.ts` — uses `tokenStorage` helpers; `changePassword` sends `isRemembered()` to server
- `apps/desktop/src/services/api.ts` — uses `tokenStorage` helpers in request/response interceptors
- `apps/desktop/src/services/socket.ts` — uses `getAccessToken()` for reconnect token refresh
- `apps/desktop/src/pages/LoginPage.tsx` — added Remember Me checkbox UI (default: checked)

### Native Desktop Notifications (v0.8.1)

**Feature:** Tauri native notification support with Web API fallback for browser dev mode.

**Files created:**
- `apps/desktop/src/services/notifications.ts` — `initNotifications()` for permission setup, `notify()` for sending with automatic Tauri/Web API fallback

### Landing Page (v0.8.1)

**Feature:** Public-facing landing page for browser visitors at `/`. Tauri desktop clients skip it entirely and go straight to login or the app.

**Routing (`apps/desktop/src/App.tsx`):**
- Tauri detection via `'__TAURI_INTERNALS__' in window` at module level
- New `<Route path="/">` before the `/*` catch-all with three-way logic:
  - Authenticated users (any context) → `MainLayout`
  - Unauthenticated + Tauri → `Navigate to /login`
  - Unauthenticated + Browser → `LandingPage`

**CSS (`apps/desktop/src/styles/globals.css`):**
- `landing-scroll` CSS class overrides the global `overflow: hidden` on `html, body, #root` to enable document scrolling. Toggled via `useEffect` in the landing page component (added on mount, removed on unmount).

**Landing page (`apps/desktop/src/pages/LandingPage.tsx`):**
- Single-file component (~550 lines) with internal section components
- Uses only existing dependencies (`react-router-dom`, `lucide-react`, Tailwind theme)

**Sections:**
1. **Navbar** — Fixed top, blurred background, Voxium logo (`/logo.svg`), Sign In + Get Started links
2. **Hero** — Full viewport with animated mesh network background (`NetworkMeshSvg`), large logo, headline ("Talk. Connect. Build." with gradient accent), animated waveform decoration, 3 download buttons (placeholder), browser launch link, animated mock UI panel
3. **Features** — 6-card responsive grid (voice, messaging, privacy, servers, DM calls, performance) with particle separator and hover effects
4. **Why Voxium** — 3 value prop columns (data ownership, open source, community-driven) + animated shield with checkmark highlights + decorative orbit rings
5. **Final CTA** — Gradient background with orbit rings, logo, "Ready to experience communication, reimagined?" headline, register + download buttons
6. **Footer** — 4-column grid (brand, product, legal, community links), copyright bar

**Animated SVG illustrations (inline React components, CSS `@keyframes`):**
- `NetworkMeshSvg` — 8 floating nodes with connecting lines, nodes drift on independent timing curves, lines pulse opacity
- `WaveformSvg` — 12 equalizer bars bouncing with staggered timing (audio waveform visualization)
- `OrbitRingsSvg` — 3 elliptical rings rotating at different speeds with pulsing orbit dots
- `ParticlesSvg` — 8 particles rising upward with fade in/out (section separator)
- `ShieldSvg` — Shield with gradient fill, scanning line, glow pulse, and checkmark

**Animated mock UI panel (hero section):**
- Staggered message timeline: Alice (0.8s) → Bob (1.8s) → reaction pop on Alice's message (3s) → Charlie (4s)
- Continuous ambient animations: typing indicator (3 bouncing dots), blinking cursor in message input, voice channel speaking rings (staggered), online presence dots (pulsing), active channel glow
- Voice channel section with connected users (Alice + Bob with speaking ring animations)
- Message timestamps, emoji reactions, and message input bar

**Uses the actual Voxium logo:**
- Navbar: `/logo.svg` (animated with pulsing sound waves)
- Hero: large `/logo.svg` above headline
- Mock UI panel: `/logo_static.svg` in fake title bar and sidebar
- CTA section: `/logo.svg`
- Footer: `/logo_static.svg`

**Responsiveness:**
- Hero text: `text-4xl sm:text-5xl md:text-7xl`
- Download buttons: `flex-wrap` for stacking on mobile
- Features: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- Mock UI panel: `hidden md:block`
- Footer: `grid-cols-2 md:grid-cols-4`

**Files created:**
- `apps/desktop/src/pages/LandingPage.tsx`

**Files modified:**
- `apps/desktop/src/App.tsx` — `LandingPage` import, `isTauri` constant, new `/` route
- `apps/desktop/src/styles/globals.css` — `landing-scroll` CSS class override

### Role/Permission Management

Server members now have roles (`owner`, `admin`, `member`) with hierarchical permissions. The system supports role changes, member kicks, and ownership transfer.

**Backend:**
- `apps/server/src/utils/permissions.ts` — Role hierarchy utility (`ROLE_LEVEL`, `outranks()`, `isAdminOrOwner()`)
- Three new REST endpoints in `apps/server/src/routes/servers.ts`:
  - `PATCH /:serverId/members/:memberId/role` — Change member role (owner only, cannot change own role or owner's role)
  - `POST /:serverId/members/:memberId/kick` — Kick a member (admin or owner, must outrank target, force-leaves voice if on same server)
  - `POST /:serverId/transfer-ownership` — Transfer server ownership (owner only, uses Prisma transaction, emits role updates for both users + server:updated)
- All three endpoints use `rateLimitMemberManage` (20 req/60s, userId-based)
- Socket events: `member:role_updated` and `member:kicked` (WS_EVENTS constants in shared package)
- Kick route verifies voice channel belongs to kicked server before force-disconnecting

**Frontend:**
- `MemberContextMenu` component — Right-click context menu on members in MemberSidebar with promote/demote/kick/transfer actions, double-click confirmation for destructive actions, portaled via `createPortal` to `document.body`
- `MemberSidebar` — Grouped by role (Owner / Admins / Members) with context menu integration
- `ServerSettingsModal` — Converted to tabbed layout (General / Members tabs), Members tab shows all members with inline role management actions
- `serverStore` — New methods: `updateMemberRole`, `kickMember`, `transferOwnership`, `handleMemberRoleUpdated`, `handleMemberKicked`
- `MainLayout` — Socket handlers for `member:role_updated` (updates member list) and `member:kicked` (leaves voice if in kicked server, removes server from list, shows toast)

**Shared:**
- `packages/shared/src/constants.ts` — `MEMBER_ROLE_UPDATED`, `MEMBER_KICKED` event constants
- `packages/shared/src/types.ts` — `MemberRole` type, `ServerMember` interface, `ServerToClientEvents` for role_updated and kicked

### Message Replies (v0.9.0)

**New feature:** Users can reply to messages in both server channels and DMs. Replies show a compact preview of the referenced message above the reply content, with click-to-scroll navigation to the original message.

**Database (`apps/server/prisma/schema.prisma`):**
- Added `replyToId String? @map("reply_to_id")` to Message model
- Self-relation: `replyTo Message? @relation("MessageReply", fields: [replyToId], references: [id], onDelete: SetNull)` and `replies Message[] @relation("MessageReply")`
- `onDelete: SetNull` — deleting the original message nullifies the reference; the reply stays and shows "[Original message was deleted]"

**Shared package (`packages/shared/src/types.ts`):**
- `Message` interface extended with `replyToId?: string | null` and `replyTo?: { id: string; content: string; author: MessageAuthor } | null`
- `replyToId` enables distinguishing "never a reply" (`undefined`) from "reply to deleted message" (`replyToId` set but `replyTo` is `null`)

**Backend (`apps/server/src/routes/messages.ts`):**
- All message queries (GET list, POST create, PATCH edit) include `replyTo` with nested `{ id, content, author }` select
- POST accepts optional `replyToId` in body; validates that the referenced message exists and belongs to the same channel
- Created message payload includes `replyTo` data, so socket broadcasts carry the reply preview

**Backend (`apps/server/src/routes/dm.ts`):**
- Same changes as channel messages: `replyTo` include on GET/POST/PATCH, `replyToId` acceptance on POST with conversation-scoped validation
- Shared `replyToSelect` constant to avoid duplication

**Frontend store (`apps/desktop/src/stores/chatStore.ts`):**
- New state: `replyingTo: Message | null`
- New actions: `setReplyingTo(message)`, `clearReplyingTo()`
- `sendMessage()` and `sendDMMessage()` include `replyToId` in POST body when `replyingTo` is set; clear reply state after successful send
- `clearMessages()` resets `replyingTo` to `null` (channel/conversation switches clear reply state)

**Frontend — MessageItem (`apps/desktop/src/components/chat/MessageItem.tsx`):**
- Reply button (lucide `Reply` icon) added as first button in hover toolbar, hidden for system messages
- Compact reply preview rendered above message content when `message.replyTo` exists: author name + truncated content (80 chars), left border accent, muted colors
- Clicking the reply preview scrolls to the original message (via `data-message-id` attribute + `scrollIntoView`) and briefly highlights it with accent background
- When `message.replyToId` exists but `message.replyTo` is null (parent deleted), shows "[Original message was deleted]" in muted italic

**Frontend — MessageInput (`apps/desktop/src/components/chat/MessageInput.tsx`):**
- Reply bar rendered above the input container when `replyingTo` is set: "Replying to **{displayName}**" + truncated content + X cancel button
- Input container border radius adapts (flat top when reply bar is shown)
- Textarea auto-focuses when reply is set
- Escape key cancels the active reply

**Frontend — MessageList (`apps/desktop/src/components/chat/MessageList.tsx`) & DMMessageList (`apps/desktop/src/components/dm/DMMessageList.tsx`):**
- `shouldShowHeader()` now breaks message grouping for messages with `replyToId` (replies always show full header with avatar)

**Files modified:**
- `apps/server/prisma/schema.prisma` — `replyToId` field + self-relation
- `apps/server/prisma/migrations/20260228035448_add_message_reply/migration.sql`
- `packages/shared/src/types.ts` — `replyToId` and `replyTo` on Message
- `apps/server/src/routes/messages.ts` — replyTo include + replyToId creation
- `apps/server/src/routes/dm.ts` — replyTo include + replyToId creation + `replyToSelect` constant
- `apps/desktop/src/stores/chatStore.ts` — reply state + actions + send integration
- `apps/desktop/src/components/chat/MessageItem.tsx` — Reply button + reply preview + scroll-to-original
- `apps/desktop/src/components/chat/MessageInput.tsx` — Reply bar + auto-focus + Escape cancel
- `apps/desktop/src/components/chat/MessageList.tsx` — grouping break for replies
- `apps/desktop/src/components/dm/DMMessageList.tsx` — grouping break for replies

---

### Presigned URL Migration (v0.9.1)

**What changed:** File upload architecture migrated from server-proxied uploads (multer + sharp on server) to presigned S3 URLs with client-side image processing. The server no longer handles file bytes -- it generates presigned PUT URLs for uploads and presigned GET URLs for downloads.

**Backend changes:**
- `apps/server/src/utils/s3.ts` -- Removed `uploadToS3()` and `streamFromS3()`. Added `generatePresignedPutUrl()` and `generatePresignedGetUrl()`. `deleteFromS3()` retained for old-asset cleanup. New dependency: `@aws-sdk/s3-request-presigner`.
- `apps/server/src/routes/uploads.ts` -- Replaced multer upload routes with presign endpoints (`POST /presign/avatar`, `POST /presign/server-icon/:serverId`). GET route now does 302 redirect to presigned S3 GET URL instead of streaming.
- `apps/server/src/routes/users.ts` -- Added ownership check on `avatarUrl` (must start with `avatars/{userId}-`). Added old avatar S3 cleanup after DB update.
- `apps/server/src/routes/servers.ts` -- Added `iconUrl` to PATCH endpoint with ownership check (must start with `server-icons/{serverId}-`). Added old icon S3 cleanup after DB update.
- `apps/server/src/middleware/errorHandler.ts` -- Removed multer error handling (no longer needed).
- `apps/server/package.json` -- Removed `multer` and `sharp` dependencies; added `@aws-sdk/s3-request-presigner`.

**Frontend changes:**
- `apps/desktop/src/utils/imageProcessing.ts` -- New utility: Canvas-based image resize (256x256 cover fit) and WebP conversion at 0.85 quality. Uses `OffscreenCanvas` and `createImageBitmap` APIs.
- `apps/desktop/src/stores/authStore.ts` -- `uploadAvatar()` now: (1) gets presigned PUT URL, (2) processes image client-side, (3) uploads directly to S3, (4) confirms key in DB via PATCH /users/me/profile.
- `apps/desktop/src/stores/serverStore.ts` -- `uploadServerIcon()` now follows same presigned URL flow.

**Architecture decisions:**
- Server no longer processes file bytes, reducing CPU/memory load and eliminating the `sharp` native dependency
- Image validation moved to client-side Canvas API (rejects non-image input implicitly via `createImageBitmap`)
- S3 key ownership enforced server-side: avatar keys must match `avatars/{userId}-*`, server icon keys must match `server-icons/{serverId}-*`
- Old assets cleaned up fire-and-forget after DB update confirmed (`.catch(() => {})`)
- GET /uploads/* is unauthenticated (same as before) but now returns a 302 redirect instead of streaming -- reduces server bandwidth to zero for file serving

**Review fixes applied:**
- CRITICAL: Added S3 upload response status check in `authStore.ts` and `serverStore.ts` -- `fetch()` does not throw on HTTP errors; without `if (!uploadRes.ok)` check, a failed S3 upload (403 expired URL, 500 error) would silently proceed to save the orphan key in the DB
- WARNING: Removed dead `NoSuchKey` error handling in GET /uploads/* route -- `generatePresignedGetUrl()` only signs locally and never contacts S3, so `NoSuchKey` could never be thrown here; S3 404s now surface directly to the client after the 302 redirect
- WARNING: Fixed stale JSDoc comment in `s3.ts` that still referenced the removed `uploadToS3` function
- Updated CONTEXT.md: marked 3 stale known issues as resolved, updated API endpoint descriptions

**Remaining suggestions (not acted upon):**
- The presigned PUT URL ContentType constraint (`image/webp`) in the `PutObjectCommand` may not be enforced by all S3-compatible providers. The client sends the correct Content-Type header, but a malicious actor with the presigned URL could potentially upload non-WebP content. The ownership check and regex validation on the key mitigate this (only `.webp` extensions allowed), but the actual file content is not validated server-side. For defense in depth, consider a Lambda/webhook trigger that validates uploaded objects.
- ~~The GET /uploads/* presigned GET URL has a 1-hour default expiry. If the client caches the 302 redirect location (some browsers do for images in `<img>` tags), stale presigned URLs will return 403 from S3 after expiry. Consider using `Cache-Control: no-cache` on the 302 response itself (not on the S3 object), or increasing the presigned URL expiry.~~ **Resolved** — `Cache-Control: no-cache` added to the 302 redirect response.
- `OffscreenCanvas.convertToBlob({ type: 'image/webp' })` may fall back to PNG in browsers/WebView engines that lack WebP encoding support. Chromium (used by Tauri's WebView2 on Windows and WKWebView on macOS) supports WebP encoding, but this is not checked at runtime.

---

### Bug Fixes & Improvements (v0.9.2)

#### 1. Looping Incoming Call Ringtone

**Problem:** The incoming DM call sound played only once (a single ascending 3-tone chime), making it easy to miss if the user wasn't looking at the screen.

**Fix:**
- `apps/desktop/src/services/notificationSounds.ts` -- Replaced one-shot `playCallSound()` with `startCallRingtone()` / `stopCallRingtone()`. The ringtone plays the ascending 3-tone chime every 2 seconds via `setInterval` until explicitly stopped.
- `apps/desktop/src/components/dm/IncomingCallModal.tsx` -- Split into `IncomingCallContent` (inner component, mounts only when there's an active incoming call) and `IncomingCallModal` (thin wrapper with null guard). The inner component uses `useEffect` to start the ringtone on mount and stop on unmount. This covers all exit paths: accept, decline, and caller cancel.
- `apps/desktop/src/components/layout/MainLayout.tsx` -- Removed one-shot `playCallSound()` from `dmVoiceOffer` handler (ringtone lifecycle now owned by the modal).

#### 2. DM Call Conversation Hydration (Brand-New DM Calls)

**Problem:** When Alice calls Bob but no prior DM conversation exists between them, Bob accepts the call but sees "Select a conversation" instead of the call UI. This happened because `IncomingCallModal.handleAccept` set the active conversation to an ID that wasn't yet in Bob's local `dmStore.conversations` array.

**Fix:**
- `apps/desktop/src/components/dm/IncomingCallModal.tsx` -- `handleAccept` now checks if the conversation exists in the local store before navigating. If not found (brand-new DM), calls `dmStore.fetchConversations()` first, then sets the active conversation.
- `apps/desktop/src/components/layout/MainLayout.tsx` -- `dm:message:new` handler now checks if the conversation exists in the local store. If a message arrives for an unknown conversation (e.g. "Voice call started" system message for a brand-new DM), calls `fetchConversations()` to hydrate the store instead of silently dropping the message via `updateLastMessage()`.

#### 3. DM Profile Popup Not Showing

**Problem:** Hovering over a user in DMs showed no profile popup. It only worked after visiting a server first (because `serverStore.members` was populated). The popup returned `null` when the user wasn't found in `serverStore.members`.

**Fix:**
- `apps/desktop/src/components/common/UserProfilePopup.tsx` -- Added API fallback: when the user isn't in `serverStore.members`, fetches profile from `GET /users/:userId`. Unified user resolution: `const user = member?.user ?? fetchedUser`. Server-specific fields (`role`, `joinedAt`) gracefully become `null` in DM context — role badges and "Joined Server" date simply don't render. `handleAddFriend` updated to work with either data source.

#### 4. Dependency Security Updates

- Added `pnpm.overrides` in root `package.json` for `rollup` (>=4.59.0) and `fast-xml-parser` (>=5.4.1) to resolve dependabot alerts (High and Low severity respectively)
- Moderate severity `glib` Rust alert cannot be resolved — pinned at 0.18.5 by Tauri's entire GTK bindings ecosystem; requires Tauri upstream update

**Files modified:**
- `apps/desktop/src/services/notificationSounds.ts` -- Looping ringtone (`startCallRingtone`/`stopCallRingtone`)
- `apps/desktop/src/components/dm/IncomingCallModal.tsx` -- Ringtone lifecycle via useEffect + conversation hydration on accept
- `apps/desktop/src/components/layout/MainLayout.tsx` -- Removed one-shot call sound, added conversation hydration in `dm:message:new`
- `apps/desktop/src/components/common/UserProfilePopup.tsx` -- API fallback for DM context
- `package.json` (root) -- pnpm overrides for security fixes, version bump
- All 4 `package.json` files -- Version bumped to 0.9.2
- `packages/shared/src/constants.ts` -- `APP_VERSION` bumped to 0.9.2

---

### Drag-and-Drop Channel & Category Reordering (v0.9.4)

**New feature:** Admins and owners can reorder channels and categories via drag-and-drop in the `ChannelSidebar`. Channels can be reordered within a category, moved between categories, and moved to/from uncategorized. Categories can be reordered among each other.

**New dependency:** `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` — modern React DnD library (tree-shakeable, accessible, no legacy deps).

**Backend — Bulk reorder endpoints:**
- `PUT /api/v1/servers/:serverId/categories/reorder` — admin/owner; body: `{ order: [{ id, position }] }`; validates all category IDs belong to the server; updates positions in a Prisma `$transaction`; emits `category:updated` for each changed category
- `PUT /api/v1/servers/:serverId/channels/reorder` — admin/owner; body: `{ order: [{ id, position, categoryId }] }`; validates all channel IDs and category IDs belong to the server; updates position + categoryId in a Prisma `$transaction`; emits `channel:updated` for each changed channel
- Both routes registered BEFORE `/:paramId` routes to avoid Express matching "reorder" as a param
- Both use `rateLimitCategoryManage` (20 pts/60s, userId-based)

**Frontend store (`apps/desktop/src/stores/serverStore.ts`):**
- `reorderCategories(serverId, order)` — optimistic local update of category positions, PUT to API, revert on failure
- `reorderChannels(serverId, order)` — optimistic local update of channel positions + categoryIds, PUT to API, revert on failure

**Frontend UI (`apps/desktop/src/components/channel/ChannelSidebar.tsx`):**
- Refactored from render functions to proper sub-components: `SortableChannelItem`, `SortableCategoryHeader`, `ChannelOverlay`, `CategoryOverlay`
- `DndContext` wraps the channels list with `closestCenter` collision detection and `PointerSensor` (5px activation distance to prevent accidental drags on clicks)
- Nested `SortableContext`s: outer for categories (sortable among themselves), inner per-category for channels
- Uncategorized channels have their own `SortableContext`
- Sortable IDs prefixed with `ch-` / `cat-` for type differentiation in `onDragEnd`
- `DragOverlay` renders a styled ghost of the dragged item (no drop animation for snappy feel)
- `onDragEnd` logic handles three cases: category reorder, same-container channel reorder, cross-container channel move
- Drag handles (grip icon via lucide `GripVertical`) visible only to admins/owners on hover
- Non-admin users see the sidebar identically to before (no drag affordances)
- Channels within each group sorted by position via `useMemo`

**Key pattern:** Reorder operations use the **optimistic update + revert** pattern rather than the "socket is sole source of truth" pattern used by create/delete. This is because reordering is a high-frequency UI interaction where waiting for the server round-trip would feel sluggish. The socket events (`channel:updated`, `category:updated`) still fire and update all other clients in real-time.

**Files modified:**
- `apps/desktop/package.json` — added `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`
- `apps/server/src/routes/categories.ts` — new `PUT /reorder` bulk endpoint
- `apps/server/src/routes/channels.ts` — new `PUT /reorder` bulk endpoint
- `apps/desktop/src/stores/serverStore.ts` — `reorderCategories()`, `reorderChannels()` actions
- `apps/desktop/src/components/channel/ChannelSidebar.tsx` — full DnD refactor with sub-components
- `packages/shared/src/constants.ts` — `APP_VERSION` bumped to 0.9.4

### Message Search with Jump-to-Message (v0.9.5)

**New feature:** Full-text message search across server channels and DM conversations, with the ability to click a search result to jump to that message in context (loads surrounding messages and highlights the target).

**Backend — Search endpoints (`apps/server/src/routes/search.ts`):**
- `GET /api/v1/search/servers/:serverId/messages` — search across all text channels in a server (or filtered to a specific channel); requires server membership; supports `q`, `channelId`, `authorId`, `before` (cursor pagination), `limit` query params; returns results with `channelName` for display
- `GET /api/v1/search/dm/:conversationId/messages` — search within a DM conversation; requires conversation participation; supports `q`, `before`, `limit`
- Both endpoints: rate-limited via `rateLimitSearch` (15 pts/60s, userId-based), sanitize query via `sanitizeText`, validate via `validateSearchQuery`, filter to `type: 'user'` messages only, use case-insensitive `contains` matching, cursor-based pagination via `before` (createdAt)

**Backend — "around" mode on existing message endpoints:**
- `GET /api/v1/channels/:channelId/messages?around=:messageId` — fetches messages before and after the target message, returns `hasMore`, `hasMoreAfter`, `targetMessageId`
- `GET /api/v1/dm/:conversationId/messages?around=:messageId` — same for DM conversations
- Both use a `half = floor(limit/2)` split, dedup by ID, and maintain chronological order

**Shared package (`packages/shared`):**
- `constants.ts` — `LIMITS.SEARCH_QUERY_MIN` (2), `LIMITS.SEARCH_QUERY_MAX` (200), `LIMITS.SEARCH_RESULTS_PER_PAGE` (25)
- `validators.ts` — `validateSearchQuery(query)` length validation
- `types.ts` — `SearchResult` interface (message subset with optional `channelName`)

**Frontend store (`apps/desktop/src/stores/chatStore.ts`):**
- `hasMoreAfter` state — tracks whether more messages exist after the loaded window (for `around` mode)
- `targetMessageId` state — the message ID to scroll to and highlight after fetch
- `fetchMessagesAround(channelId, messageId)` — fetches messages around a target, sets `hasMoreAfter` and `targetMessageId`
- `fetchDMMessagesAround(conversationId, messageId)` — same for DM
- `clearTargetMessage()` — clears `targetMessageId` after scroll/highlight completes

**Frontend UI (`apps/desktop/src/components/search/SearchModal.tsx`):**
- Modal with search input, debounced search (300ms), channel filter dropdown (server mode), infinite scroll pagination
- Results show author avatar, display name, channel name (server mode), timestamp, truncated content
- Click result: closes modal, navigates to correct channel/conversation, calls `fetchMessagesAround`, which triggers scroll-to-target effect

**Scroll-to-target effect (MessageList.tsx, DMMessageList.tsx):**
- `useEffect` watching `targetMessageId` — uses `requestAnimationFrame` + `querySelector('[data-message-id="..."]')` to scroll to and highlight the target message with a 2-second `bg-vox-accent-primary/10` highlight

**Global shortcut (MainLayout.tsx):**
- `Ctrl+K` / `Cmd+K` toggles the search modal; context-aware (server search if viewing a server, DM search if viewing a conversation)

**Files added/modified:**
- `apps/server/src/routes/search.ts` — new search route file
- `apps/server/src/app.ts` — mounted `searchRouter` at `/search`
- `apps/server/src/middleware/rateLimiter.ts` — added `rateLimitSearch`
- `apps/server/src/routes/messages.ts` — added `around` query param support
- `apps/server/src/routes/dm.ts` — added `around` query param support
- `apps/desktop/src/stores/chatStore.ts` — `hasMoreAfter`, `targetMessageId`, `fetchMessagesAround`, `fetchDMMessagesAround`, `clearTargetMessage`
- `apps/desktop/src/components/search/SearchModal.tsx` — new search modal component
- `apps/desktop/src/components/chat/MessageList.tsx` — scroll-to-target effect
- `apps/desktop/src/components/dm/DMMessageList.tsx` — scroll-to-target effect
- `apps/desktop/src/components/chat/ChatArea.tsx` — search button + modal integration
- `apps/desktop/src/components/dm/DMChatArea.tsx` — search button + modal integration
- `apps/desktop/src/components/layout/MainLayout.tsx` — Ctrl+K shortcut + global search modal
- `packages/shared/src/constants.ts` — search-related limits
- `packages/shared/src/validators.ts` — `validateSearchQuery`
- `packages/shared/src/types.ts` — `SearchResult` interface

### Server Deletion (v0.9.6)

**Feature:** Server owners can permanently delete their server. All channels, messages, members, categories, invites, and reactions are cascade-deleted. Voice users are ejected, sockets are removed from rooms, and S3 server icons are cleaned up.

**Backend (`apps/server/src/routes/servers.ts`):**
- `DELETE /:serverId` endpoint — owner-only authorization, voice user ejection via `leaveCurrentVoiceChannel`, `server:deleted` socket event broadcast to all members, room teardown for server and channel rooms, Prisma cascade delete, S3 icon cleanup
- Voice state query via `getVoiceStateForServer(serverId)` from `voiceHandler.ts`

**Shared (`packages/shared`):**
- `WS_EVENTS.SERVER_DELETED: 'server:deleted'` added to `constants.ts`
- `'server:deleted': (data: { serverId: string }) => void` added to `ServerToClientEvents` in `types.ts`

**Frontend store (`apps/desktop/src/stores/serverStore.ts`):**
- `deleteServer(serverId)` — API call, no local state update (socket event is source of truth)
- `handleServerDeleted(serverId)` — removes server from list, clears active server state if it was the deleted one

**Frontend socket handler (`apps/desktop/src/components/layout/MainLayout.tsx`):**
- `serverDeleted` handler: leaves voice if active voice channel belongs to deleted server, calls `handleServerDeleted`, shows toast

**Frontend UI (`apps/desktop/src/components/server/ServerSettingsModal.tsx`):**
- Danger zone section in GeneralTab (owner-only), requires typing exact server name to confirm deletion

**First review issues (all fixed):**
- Hoisted `fetchSockets()` to avoid nested loop calls (performance)
- Added `rateLimitMemberManage` to DELETE endpoint
- Added `cleanupServerVoice()` for silent voice ejection + `channelServerMap` cleanup
- `handleServerDeleted` now cleans up `unreadCounts` and `serverUnreadCounts`
- `handleServerDeleted` now calls `chatStore.clearMessages()` when active server is deleted
- Removed duplicate toast (modal no longer shows toast; socket handler shows it for all clients)
- Inline voice cleanup in MainLayout `serverDeleted` handler (no `voice:leave` emit back)
- `channelUsers` Map orphan cleanup for deleted server's voice channels

**Second review findings (2026-03-01):**
- All first-review fixes verified correct
- Race conditions: emit-before-room-cleanup ordering is sound; socket event reaches all members before rooms are torn down
- Owner-in-voice edge case: handled on both server (cleanupServerVoice clears socket.data.voiceChannelId) and client (inline cleanup)
- `io.sockets.sockets.get(socketId)` type-safe: returns `Socket | undefined`, properly null-checked
- Double-delete scenario: mitigated by rate limiter; second request gets Prisma P2025 error (500 not 404, acceptable)
- Modal `onClose()` timing: both orderings (socket first or API first) are graceful; modal returns null if server removed from store
- Non-active server unread: server-level unread cleaned for all servers; channel-level orphans are harmless (overwritten on reconnect)
- Memory leaks: none found; all Maps (voiceChannelUsers, channelServerMap, channelUsers, peers, remoteAudios) properly cleaned
- Minor suggestion: `as any` cast on `cleanupServerVoice(io as any, serverId)` is unnecessary (types match exactly)

**Files modified:**
- `packages/shared/src/constants.ts` — added `SERVER_DELETED` to `WS_EVENTS`
- `packages/shared/src/types.ts` — added `server:deleted` to `ServerToClientEvents`
- `apps/server/src/routes/servers.ts` — implemented DELETE `/:serverId` endpoint with rate limiting, voice cleanup, room teardown, S3 icon cleanup
- `apps/server/src/websocket/voiceHandler.ts` — added `cleanupServerVoice()` export for silent voice state cleanup
- `apps/desktop/src/stores/serverStore.ts` — added `deleteServer`, `handleServerDeleted` with full unread cleanup
- `apps/desktop/src/components/layout/MainLayout.tsx` — added `serverDeleted` socket handler with inline voice cleanup and channelUsers Map cleanup
- `apps/desktop/src/components/server/ServerSettingsModal.tsx` — added danger zone delete UI with name-confirmation gate

---

### 29. Screen Sharing in Server Voice Channels

**Date:** 2026-03-01

Screen sharing allows one user per voice channel to share their screen with all other participants. Uses `getDisplayMedia` for capture and adds video tracks to existing WebRTC peer connections via `addTrack`/`removeTrack` with `onnegotiationneeded` renegotiation.

**Architecture:**
- **One sharer per channel** — server enforces via `screenSharers` Map (`channelId -> userId`); second `voice:screen_share:start` is silently dropped
- **Server voice only** — screen sharing is limited to server voice channels (not DM calls)
- **WebRTC track-based** — screen share video (and optional system audio from `getDisplayMedia({ audio: true })`) added as additional tracks on existing peer connections, triggering `onnegotiationneeded` for SDP renegotiation
- **Viewer modes** — `inline` (replaces ChatArea) or `floating` (draggable/resizable portal over ChatArea)

**Server (`apps/server/src/websocket/voiceHandler.ts`):**
- `screenSharers` Map tracks `channelId -> userId` (in-memory, one sharer per channel)
- `voice:screen_share:start` handler: validates user is in voice channel, checks no existing sharer, registers and broadcasts to `server:{id}` room
- `voice:screen_share:stop` handler: validates user is the current sharer, cleans up and broadcasts
- `leaveCurrentVoiceChannel` cleanup: automatically stops screen share if the sharer leaves/disconnects
- `cleanupServerVoice` cleanup: deletes `screenSharers` entries for deleted server's channels
- `getScreenShareState(channelId)` export: returns current sharer userId or null (used for hydration)
- `voice:join` handler: emits `voice:screen_share:state` to the joining user if the channel has an active screen sharer (late-joiner hydration fix — without this, users joining a channel mid-share would not see the stream)
- Rate limited via `socketRateLimit(socket, 'voice:screen_share', 10)`

**Server (`apps/server/src/websocket/socketServer.ts`):**
- Connection hydration: after sending `voice:channel_users`, sends `voice:screen_share:state` with `sharingUserId` for any channel with an active screen share

**Shared types (`packages/shared/src/types.ts`):**
- `VoiceUser.screenSharing?: boolean` — optional flag for UI display (set client-side via socket handlers)
- S2C events: `voice:screen_share:start`, `voice:screen_share:stop` (both `{ channelId, userId }`), `voice:screen_share:state` (`{ channelId, sharingUserId: string | null }`)
- C2S events: `voice:screen_share:start`, `voice:screen_share:stop` (both parameterless — server derives channelId from `socket.data.voiceChannelId`)

**Frontend store (`apps/desktop/src/stores/voiceStore.ts`):**
- State: `screenStream`, `isScreenSharing`, `screenSharingUserId`, `remoteScreenStream`, `screenShareViewMode`
- `startScreenShare()` — calls `getDisplayMedia`, adds tracks to all peers via `addTrack`, registers `track.onended` for browser stop button, emits `voice:screen_share:start`
- `stopScreenShare()` — removes tracks from peers via `removeTrack`, stops stream, emits `voice:screen_share:stop`
- `setScreenSharingUser(channelId, userId)` — guards by `activeChannelId`, clears `remoteScreenStream` when userId is null
- `setScreenShareViewMode(mode)` — toggles between `'inline'` and `'floating'`
- `onnegotiationneeded` handler on peer connections: triggers renegotiation when tracks are added/removed (skips initial setup via `initialSetupDone` flag)
- `pc.ontrack` handler: detects video tracks as screen share, sets `remoteScreenStream`; handles screen share system audio via separate `<audio>` element keyed as `${userId}-screen`
- `destroyPeer` cleanup: removes screen audio element, clears `currentScreenSenders`, nulls `remoteScreenStream` if sharer
- `destroyAllPeers` cleanup: clears `currentScreenSenders`, nulls `remoteScreenStream`
- `leaveChannel` cleanup: calls `stopScreenShare()` if sharing, resets all screen share state
- Reconnect handler: stops screen sharing (stale peers cannot receive tracks), clears all screen share state
- `createPeerInternal`: adds screen share tracks to new peer connections if currently sharing

**Frontend socket handlers (`apps/desktop/src/components/layout/MainLayout.tsx`):**
- `voiceScreenShareStart` — sets sharing user, marks `screenSharing: true` in channelUsers
- `voiceScreenShareStop` — clears sharing user, marks `screenSharing: false` in channelUsers
- `voiceScreenShareState` — hydration handler, sets sharing user and marks flag
- `serverDeleted` handler updated to clear all screen share state in inline voice cleanup

**Frontend UI:**
- `VoicePanel` — screen share toggle button (Monitor/MonitorOff icons); disabled with visual indicator when another user is sharing
- `ChannelSidebar` — Monitor icon next to users who are screen sharing in voice channel user list
- `ScreenShareViewer` (NEW) — inline viewer replacing ChatArea; shows video with fullscreen button, pop-to-floating button, stop-sharing button (own shares only)
- `ScreenShareFloating` (NEW) — draggable/resizable floating panel via `createPortal` to `document.body`; min 240x180, default 400x300; constrained to viewport on window resize

**Review findings (2026-03-01):**
- Fixed stale `videoRef.current` in cleanup functions of `ScreenShareViewer` and `ScreenShareFloating` (captured ref at effect setup time instead of reading it during cleanup)
- Server-side authorization verified: `socket.data.voiceChannelId` is the trusted source set only by server-side `voice:join`; cannot be spoofed
- Race condition analysis (sharer leaves): both event orderings (`voice:screen_share:stop` before/after `voice:user_left`) are safe; `setScreenSharingUser(null)` and `destroyPeer` both independently clean up `remoteScreenStream`
- Screen share state hydration ordering verified: `voice:channel_users` (fresh user objects without `screenSharing`) followed by `voice:screen_share:state` (sets the flag) processes correctly due to single-threaded JS event loop
- `screenShareViewMode` persists between screen share sessions (not reset to `'inline'` when sharing ends) — acceptable UX behavior, rendering is guarded by `screenSharingUserId && voiceActiveChannelId`
- Memory leak analysis: `currentScreenSenders` Map properly cleaned in `destroyPeer`, `destroyAllPeers`, and `stopScreenShare`; screen audio elements cleaned in `destroyPeer`
- Rate limiting present: shared `voice:screen_share` key at 10/minute covers both start and stop events

**Files modified:**
- `packages/shared/src/constants.ts` — added `VOICE_SCREEN_SHARE_START`, `VOICE_SCREEN_SHARE_STOP`, `VOICE_SCREEN_SHARE_STATE` to `WS_EVENTS`
- `packages/shared/src/types.ts` — added `screenSharing?` to `VoiceUser`, 3 S2C events, 2 C2S events
- `apps/server/src/websocket/voiceHandler.ts` — added `screenSharers` Map, 2 socket handlers, cleanup in `leaveCurrentVoiceChannel` and `cleanupServerVoice`, `getScreenShareState` export
- `apps/server/src/websocket/socketServer.ts` — added screen share state hydration after `voice:channel_users`
- `apps/desktop/src/stores/voiceStore.ts` — added 5 state fields, 4 actions, `onnegotiationneeded` handler, video track detection in `ontrack`, screen track forwarding to new peers, cleanup in `leaveChannel`/`destroyPeer`/`destroyAllPeers`/reconnect
- `apps/desktop/src/components/layout/MainLayout.tsx` — added 3 socket handlers, conditional inline/floating viewer rendering, screen share state cleanup in `serverDeleted` handler
- `apps/desktop/src/components/voice/VoicePanel.tsx` — added screen share toggle button with disabled state
- `apps/desktop/src/components/channel/ChannelSidebar.tsx` — added screen share Monitor icon indicator
- `apps/desktop/src/components/voice/ScreenShareViewer.tsx` — NEW inline screen share viewer component
- `apps/desktop/src/components/voice/ScreenShareFloating.tsx` — NEW floating draggable/resizable viewer component

### 35. Production Deployment Guide

**Date:** 2026-03-01

Added `DEPLOYMENT.md` — a comprehensive single-server deployment guide targeting an OVH B2-7 VPS (Ubuntu 24.04). Covers 17 sections from infrastructure provisioning through troubleshooting.

**Key details:**
- Architecture: nginx reverse proxy (ports 80/443) to Node.js :3001 (PM2), PostgreSQL 16, Redis 7, all on one host
- UFW firewall opens only ports 22, 80, 443
- PM2 ecosystem uses `NODE_ENV=production` with `dist/index.js` entry point
- All 8 required server env vars (from `index.ts` validation) present in the .env template
- Frontend .env uses `https://` URLs for `VITE_API_URL` and `VITE_WS_URL`
- nginx config includes WebSocket upgrade headers for `/socket.io/` with 86400s timeout
- PostgreSQL daily backup cron (3:00 AM, 7-day retention) with `.pgpass` setup
- SSL via Let's Encrypt with auto-renewal
- SMTP options (Brevo free tier, OVH, Mailgun) for password reset emails
- Tauri desktop build instructions for platform-specific installers
- Troubleshooting section covers 502, WebSocket, CORS, SSL, DB, Redis, voice/WebRTC issues

**Review status:** Passed all 8 review criteria. No critical or warning-level issues found.

**Files added:**
- `DEPLOYMENT.md` — production deployment guide (871 lines)

---

### ML Noise Suppression & Opus SDP Optimization (v0.9.7)

**Date:** 2026-03-02

**What was changed:**
Production-grade ML-based noise suppression using RNNoise WASM AudioWorklet, Opus codec SDP optimization for voice chat, and a user-facing noise suppression settings toggle.

**New dependency:** `@timephy/rnnoise-wasm` ^1.0.0 — RNNoise ML noise suppression compiled to WASM, runs in an AudioWorklet thread for zero main-thread blocking.

**Architecture decisions:**
- **RNNoise integration via AudioWorklet:** The `NoiseSuppressorWorklet` WASM module runs in a separate audio thread. Loaded asynchronously -- the audio pipeline starts immediately without RNNoise (source -> analyser -> gain -> destination), and RNNoise is inserted once the worklet finishes loading (source -> RNNoise -> analyser -> gain -> destination). This avoids blocking the voice join flow.
- **Live toggle without pipeline teardown:** `setNoiseSuppression(enabled)` reconnects nodes via `rebuildPipeline()` without destroying the AudioContext or worklet. When toggled off, the RNNoise node is disconnected but kept alive for fast re-enable.
- **SDP munging for Opus optimization:** `optimizeOpusSDP()` sets `usedtx=1` (20x bandwidth reduction during silence), `useinbandfec=1` (packet loss recovery), `maxaveragebitrate=32000` (32kbps mono voice), `stereo=0`. Applied to all SDP creation paths: initial offers, answers, renegotiation offers, and ICE restart offers.
- **Consistent noise suppression state sync:** `setNoiseSuppression(settings.enableNoiseSuppression)` is called at all 3 voice entry points (joinChannel, joinDMCall, socket reconnect handler) to ensure the pipeline state matches the user's persisted preference.

**Audio pipeline (with RNNoise enabled):**
```
mic -> MediaStreamSource -> RNNoise AudioWorklet -> AnalyserNode -> GainNode (noise gate) -> MediaStreamDestination -> WebRTC peers
```

**Files added:**
- `apps/desktop/src/services/sdpUtils.ts` — `optimizeOpusSDP()` pure function for Opus codec parameter optimization in SDP offers/answers

**Files modified:**
- `apps/desktop/src/services/audioAnalyser.ts` — RNNoise AudioWorklet integration: `loadRNNoiseWorklet()`, `rebuildPipeline()`, `setNoiseSuppression()` export, worklet cleanup in `stopSpeakingDetection()`, orphan node cleanup on pipeline teardown during async load
- `apps/desktop/src/stores/settingsStore.ts` — `enableNoiseSuppression` persisted setting (default: true), live sync to audio analyser via dynamic import
- `apps/desktop/src/stores/voiceStore.ts` — `optimizeOpusSDP` applied at all 5 SDP creation points, `setNoiseSuppression` sync at all 3 voice entry points
- `apps/desktop/src/components/settings/SettingsModal.tsx` — AI Noise Suppression toggle in Audio tab with `AudioLines` icon
- `apps/desktop/src/vite-env.d.ts` — type declaration for `@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url` Vite import

**Review status:** Approved with suggestions. No critical or warning-level issues found.

**Known issues / suggestions:**
- `acquireAudioStream()` in `voiceStore.ts` sets browser-level `noiseSuppression: true` as a media constraint. When RNNoise is enabled, this means two noise suppression algorithms run in series (browser built-in + RNNoise), which may cause audio artifacts. Consider conditionally setting `noiseSuppression: false` when RNNoise is active.
- The speaking detection tick interval was reduced from 50ms to 20ms (2.5x more CPU for the detection loop). The CLAUDE.md documentation still references "50ms".
- When noise suppression is toggled off, the RNNoise AudioWorklet node is kept alive but disconnected. This is a deliberate tradeoff (fast re-enable vs. idle thread). Consider destroying the node on disable if memory is a concern.

---

### Auth Page Peeking Thief Character (v0.9.8)

**Date:** 2026-03-03

**What was changed:**
Added an animated SVG thief character that peeks over the top of the login/register card. The thief reacts to password input — eyes widen, look down toward the password field, and shake when the user types; blinks idly and looks to the side when not typing.

**Component: `PeekingThief` (`apps/desktop/src/components/auth/PeekingThief.tsx`):**
- Pure SVG character: dark beanie with pom-pom, rounded face, classic thief eye-mask (dark band across eyes), white eyes with dark pupils, two small hands gripping the card edge
- Single `isWatching: boolean` prop drives all visual state
- **Idle state (`isWatching=false`):** Small/relaxed eyes (r=6), pupils look to the side (cx offset), CSS blink animation every ~3s (`thief-blink` keyframe), normal position
- **Watching state (`isWatching=true`):** Large eyes (r=9), pupils snap to center and shift down (cy=40, looking at password), eye shake animation (`thief-eye-shake` keyframe — 0.4s jitter), slight upward lean (-4px translateY)
- All transitions smoothed with `transition: all 0.3s ease` on individual SVG attributes (cx, cy, rx, ry, r)
- Positioned absolutely above the card (`-top-[52px]`, centered via `left-1/2 -translate-x-1/2`), `pointer-events-none`

**Login/Register page changes:**
- `isPasswordFocused` state — `onFocus`/`onBlur` on password input
- `isTypingPassword` with 1.5s debounce — true on password `onChange`, resets via `setTimeout` after 1.5s idle
- Derived: `isWatching = isPasswordFocused && isTypingPassword`
- Card wrapper gains `pt-14` for thief headroom, inner `<div className="relative">` hosts the absolutely-positioned thief above the card
- Password input `onChange` uses `handlePasswordChange()` callback (sets value, clears error, triggers typing debounce)

**Files added:**
- `apps/desktop/src/components/auth/PeekingThief.tsx` — animated SVG thief component

**Files modified:**
- `apps/desktop/src/pages/LoginPage.tsx` — PeekingThief integration, password focus/typing tracking
- `apps/desktop/src/pages/RegisterPage.tsx` — PeekingThief integration, password focus/typing tracking

### Admin System (v0.9.8+)

**Overview:** A comprehensive admin dashboard for platform moderation and monitoring. Extracted from the desktop app into a standalone `apps/admin/` web application. Includes user management (ban/unban/delete), server management (view/delete), IP ban management, dashboard stats, live metrics via WebSocket, and signup/message charts.

**New app: `apps/admin/`**
- Standalone React 19 + Vite + Tailwind app on port 8082
- Login gated to `superadmin` role (client-side check after standard `/auth/login`, server-side enforced on all `/admin/*` routes)
- Socket.IO connection for live admin metrics (online users, voice channels, DM calls, messages/hour)
- Zustand stores: `authStore` (login/logout/checkAuth), `adminStore` (all CRUD + metrics), `toastStore` (notification queue)
- Pages: `AdminLoginPage` (email/password with error display)
- Components: `AdminGuard` (role check wrapper), `AdminLayout` (sidebar nav + content), `AdminDashboard` (stat cards + live metrics + SVG bar charts), `AdminUserList` (paginated table with search/filter/sort), `AdminUserDetail` (profile + IP history + ban/unban/delete actions), `AdminServerList` (paginated table with search + delete), `AdminBanList` (account bans + IP bans tabs with add/remove), `AdminConfirmModal` (reusable confirmation dialog), `AdminStatCard`, `AdminTable`, `ToastContainer`
- Services: `tokenStorage.ts` (localStorage/sessionStorage dual-storage), `api.ts` (Axios with token refresh interceptor), `socket.ts` (Socket.IO client)

**New server files:**
- `apps/server/src/routes/admin.ts` — Admin API routes (all gated by `authenticate` + `requireSuperAdmin` + `rateLimitAdmin`):
  - `GET /admin/stats` — Dashboard totals (users, servers, messages, online, banned)
  - `GET /admin/users` — Paginated user list with search/filter/sort
  - `GET /admin/users/:userId` — User detail with IP history and message/server counts
  - `POST /admin/users/:userId/ban` — Ban user (optional reason + IP ban), invalidates tokens, force-disconnects socket
  - `POST /admin/users/:userId/unban` — Unban user, releases IP bans (with shared-IP protection)
  - `DELETE /admin/users/:userId` — Delete user (cascade), force-disconnects socket
  - `GET /admin/servers` — Paginated server list with message counts
  - `DELETE /admin/servers/:serverId` — Delete server with voice cleanup, socket room eviction, and cascade
  - `GET /admin/bans` — Paginated banned user list
  - `GET /admin/ip-bans` — Paginated IP ban list
  - `POST /admin/ip-bans` — Create IP ban with IPv4/IPv6 validation
  - `DELETE /admin/ip-bans/:id` — Remove IP ban
  - `GET /admin/signups` — Chart data for signups per day (raw SQL)
  - `GET /admin/messages-per-hour` — Chart data for messages per hour (raw SQL)
- `apps/server/src/middleware/requireSuperAdmin.ts` — `requireSuperAdmin` and `requireAdmin` middleware functions
- `apps/server/src/websocket/adminMetrics.ts` — 5-second interval emitter for live metrics (checks room occupancy before querying)

**Modified server files:**
- `apps/server/src/middleware/auth.ts` — Now performs DB lookup on every request to check `bannedAt` and `tokenVersion` (security improvement, performance tradeoff)
- `apps/server/src/services/authService.ts` — IP ban error message changed to generic "banned" message (prevents information disclosure)
- `apps/server/src/websocket/socketServer.ts` — Added IP ban check during socket auth, added `admin:subscribe_metrics` / `admin:unsubscribe_metrics` socket events with role check, IP record upsert on connect
- `apps/server/src/middleware/rateLimiter.ts` — Added `rateLimitAdmin` (60 req/min, userId-based)
- `apps/server/src/app.ts` — Mounted `adminRouter` at `/api/v1/admin`
- `apps/server/src/index.ts` — Starts `adminMetricsEmitter` on boot

**Modified desktop files:**
- `apps/desktop/src/App.tsx` — Removed admin imports and `/admin` route (extracted to standalone app)
- `apps/desktop/src/components/server/ServerSidebar.tsx` — Removed admin shield icon and navigation
- `apps/desktop/src/services/socket.ts` — Added `force:logout` handler (dynamic import of authStore, calls logout + redirect)

**Database changes (migration `20260304002347_add_admin_system`):**
- `users` table: Added `banned_at` (timestamp), `ban_reason` (text), `role` (text, default "user")
- New `ip_records` table: tracks user IP addresses with `last_seen_at`, composite unique on `[user_id, ip]`, index on `ip`
- New `ip_bans` table: unique on `ip`, FK to banning user (`banned_by`)

**Shared type additions:**
- `ServerToClientEvents`: `admin:metrics`, `force:logout`
- `ClientToServerEvents`: `admin:subscribe_metrics`, `admin:unsubscribe_metrics`
- New interfaces: `AdminUser`, `AdminServer`, `BanRecord`, `IpBanRecord`, `AdminDashboardStats`, `AdminMetricsSnapshot`

**Resolved issues from first review:**
1. ~~Admin app socket does not handle `force:logout`~~ -- Fixed: admin socket.ts now handles `force:logout` (calls logout + redirects to /login)
2. ~~Deleting a user who owns servers does not emit `server:deleted` events~~ -- Fixed: delete route now iterates owned servers, calls `cleanupServerVoice`, emits `server:deleted`, and evicts sockets from rooms before cascade delete
3. ~~Live metrics stop updating after socket reconnection~~ -- Fixed: `subscribeMetrics` registers a reconnect callback via `onSocketReconnect` that re-emits `admin:subscribe_metrics` and re-registers the listener
6. ~~IPv6 validation regex is simplified~~ -- Fixed server-side: IP validation now uses Node.js `net.isIP()` which handles both IPv4 and IPv6 correctly

**Known issues from second-pass review:**
1. [WARNING] Metrics listener accumulation on reconnect: the reconnect callback in `adminStore.subscribeMetrics` calls `s.on('admin:metrics', metricsHandler)` without first calling `s.off()`, causing duplicate listeners after each reconnect
2. [WARNING] `fetchUserDetail`, `fetchBans`, and `fetchIpBans` in adminStore have no try/catch -- errors leave the UI in a permanent loading/blank state
3. [WARNING] `IpBan.creator` relation has `onDelete: Cascade` in schema -- deleting an admin user cascade-deletes all IP bans they created (may be unintentional)
4. CORS_ORIGIN must include the admin app's origin (e.g., `http://localhost:8082`) for both HTTP and WebSocket connections
5. Admin app shares localStorage token keys (`voxium_access_token`) with desktop app (collision risk if served from same domain; isolated by port in dev)
6. Auth middleware DB query on every request is a performance consideration at scale (could add Redis TTL cache for ban status)
7. Ban/delete user does not emit `member:left` for non-owned server memberships (cosmetic: banned user remains in member lists until page refresh)
8. Unused `date-fns` dependency in `apps/admin/package.json`
9. `stopAdminMetricsEmitter()` is not called during server shutdown (no real leak since `process.exit` follows)
10. Account ban login error in `authService.ts` line 73 includes ban reason string (inconsistent with generic IP ban message on line 63)

### Admin Storage "Top Uploaders" Feature (2026-03-04)

**What was changed:** Added a "Top Uploaders" leaderboard to the admin storage management page, showing which users and servers consume the most S3 storage.

**New/modified files:**
- `packages/shared/src/types.ts` -- Added `StorageTopUploader` interface (`entityId`, `entityName`, `type`, `fileCount`, `totalSize`)
- `apps/server/src/routes/admin.ts` -- Added `GET /admin/storage/top-uploaders` endpoint (lines 589-663). Parses entity IDs from S3 key filenames by splitting on last hyphen, aggregates file count and total size per entity, resolves entity names from DB, returns top 10 sorted by total size descending
- `apps/admin/src/stores/adminStore.ts` -- Added `topUploaders: StorageTopUploader[]` state and `fetchTopUploaders()` action
- `apps/admin/src/components/AdminStorage.tsx` -- Added `TopUploaders` component (splits uploaders by user vs server, shows top 5 each) and `UploaderPanel` component (ranked list with proportional bar chart)

**Architecture decisions:**
- S3 key parsing uses `lastIndexOf('-')` on the filename portion to separate entity ID from timestamp. This is safe because CUIDs (used by Prisma `@default(cuid())`) contain only alphanumeric characters -- no hyphens -- so the only hyphen in the filename is the separator before the Unix timestamp
- Top uploaders endpoint makes a full bucket listing (`listAllS3Objects()`) call, same as the existing `/storage/stats` endpoint. No caching layer. Acceptable at current scale but may need optimization if bucket grows large
- Entity name resolution falls back to `'Deleted'` for entities no longer in DB (orphaned S3 files from deleted users/servers)
- The endpoint returns a flat list of mixed user/server entries; the frontend `TopUploaders` component splits them into two panels using `useMemo` filters

**Resolved issues during review:**
1. [WARNING] `formatBytes` utility could produce `undefined` suffix for sizes >= 1 TB because `sizes` array only had 4 entries (`['B', 'KB', 'MB', 'GB']`) and the computed index could exceed bounds. **Fixed:** added `'TB'` to the sizes array and clamped index with `Math.min(i, sizes.length - 1)`

**Known issues from review (suggestions, not acted upon):**
1. [SUGGESTION] The `/storage/top-uploaders` endpoint scans the full S3 bucket on every request with no caching or pagination. For very large buckets this could be slow and memory-intensive. Consider adding a TTL cache or computing asynchronously
2. [SUGGESTION] `fetchTopUploaders` error handling in the admin store silently swallows errors with `console.error`. The UI shows no feedback if the fetch fails -- the `TopUploaders` section simply does not render (since `topUploaders.length > 0` guard in JSX). This is acceptable but could show a subtle error state
3. [SUGGESTION] The `useEffect` in `AdminStorage` has an empty dependency array (`[]`) and references `fetchStorageStats`, `fetchStorageFiles`, and `fetchTopUploaders` which are stable Zustand selectors, so no stale closure issue. However, the ESLint `react-hooks/exhaustive-deps` rule may warn about the missing dependencies
4. [SUGGESTION] `TopUploaders` component uses `import('@voxium/shared').StorageTopUploader` inline type syntax instead of importing from the top-level imports. This works but is inconsistent with the rest of the file which uses direct imports
