# Voxium - Project Context

## Overview

**Voxium** is a modern, open-source voice and text communication platform — a Discord alternative built from scratch. It enables users to create servers, organize channels, and communicate via real-time text messaging and voice chat.

## Project Status

**Version:** 0.4.0 (Password Reset & Change + Unread Badge)
**Date:** 2026-02-26
**Stage:** Full TypeScript strict compliance across server and desktop, pre-commit type-check gate, real-time channel CRUD, push-to-talk voice mode, notification sounds, unread message indicators with server-level count badges, toast notification system, message editing and deletion UI, message reactions with emoji picker, S3 file uploads with avatar and server icon support, real-time avatar and profile updates across all clients, forgot password flow with email reset tokens, authenticated password change from settings, token version-based refresh token invalidation

## What Has Been Done

### 1. Project Structure (Monorepo)

The project is organized as a **pnpm monorepo** with the following packages:

```
Voxium/
├── apps/
│   ├── server/           # Backend API + WebSocket + WebRTC signaling
│   └── desktop/          # Tauri 2 + React frontend (cross-platform desktop)
├── packages/
│   └── shared/           # Shared TypeScript types, validators, constants
├── docker-compose.yml    # PostgreSQL + Redis infrastructure
├── pnpm-workspace.yaml
└── package.json
```

### 2. Backend Server (`apps/server`)

A full Node.js + TypeScript backend has been implemented with:

- **HTTP API Framework:** Express.js with structured routing
- **Database:** PostgreSQL via Prisma ORM with full schema for users, servers, channels, messages, invites, and server members
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
  - `POST /api/v1/uploads/avatar` — Upload user avatar (S3)
  - `POST /api/v1/uploads/server-icon/:serverId` — Upload server icon (S3, owner only)
  - `GET /api/v1/uploads/*` — Stream file from S3 (unauthenticated, key-validated)

### 3. Frontend Desktop App (`apps/desktop`)

A complete React + TypeScript frontend with Tauri 2 desktop wrapper:

- **UI Framework:** React 19, TypeScript, Vite 6
- **Styling:** Tailwind CSS with custom dark theme (Discord-inspired purple/blue palette)
- **State Management:** Zustand stores for auth, servers, chat, and voice
- **Routing:** React Router v7
- **Desktop Wrapper:** Tauri 2.0 (Rust-based, ~10x smaller than Electron)
- **Pages:**
  - Login page with email/password
  - Registration page
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

### V0.2 - Polish & Stability (in progress)
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
- [ ] Direct messages (DMs)
- [ ] Friend system
- [x] Server settings panel
- [x] User settings/profile editing
- [ ] Role/permission management
- [ ] Channel categories
- [x] Emoji picker integration
- [ ] Rich text / markdown in messages
- [ ] Message search
- [ ] Screen sharing

### V0.4 - Scalability
- [ ] mediasoup SFU for production-grade voice/video
- [ ] Redis-based voice state for multi-node deployment
- [ ] Horizontal scaling with sticky sessions
- [ ] CDN for static assets
- [x] File storage (S3-compatible) — implemented in v0.3.2
- [ ] Rate limiting per endpoint

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

### Known Issues / Suggestions
- `io.fetchSockets()` in `memberBroadcast.ts` retrieves ALL connected sockets. Fine for small deployments but at scale, use a `userId -> socketId[]` index or Redis adapter's `remoteJoin`/`remoteLeave`.
- The `member:joined` event sends `email: ''` to satisfy the `User` type in `ServerToClientEvents`. Consider a `PublicUser` type that omits `email`.
- Prisma `Invite` model still has `maxUses` and `uses` columns that are no longer used. Cleanup migration pending.
- `SaveAndRedirect` in `App.tsx` performs `localStorage.setItem` during render (not in `useEffect`). Functionally correct since `Navigate` redirects immediately, but technically impure.
- PTT key press/release emits `voice:mute` on every toggle, which triggers a `voice:state_update` broadcast to the entire `server:{id}` room. For rapid PTT toggling, consider debouncing or rate-limiting these emissions.
- The PTT mode-switch subscription emits `voice:mute true` to the server but does not update `selfMute` in the voice store. This is intentional (`selfMute` represents the user's manual mute preference, not PTT transient state), but the mute icon in `VoicePanel`/`ChannelSidebar` may show "unmuted" while PTT is active and the key is not held.
- The `validateEmoji()` function accepts mixed strings containing at least one non-ASCII character (e.g., text+emoji). The 32-character length limit and React's JSX escaping mitigate risk, but a stricter validator could use Unicode emoji property matching.
- The `MAX_REACTIONS_PER_MESSAGE` limit check in the reaction toggle endpoint has a TOCTOU race: between the `groupBy` count and the `create`, another request could add a new distinct emoji, exceeding the limit. The unique constraint prevents true duplicates, but the soft limit can be exceeded by 1 under concurrent requests to different emoji. Acceptable for current scale.
- Pre-existing: `leavingUser` variable in `MainLayout.tsx` line 102 is assigned but never read (dead code from voice user left handler).
- The S3 utility (`s3.ts`) uses non-null assertions (`!`) on all env vars. If any are missing, the error surfaces as a cryptic AWS SDK error at runtime rather than a clear startup failure. Consider validating env vars at startup.
- The `GET /uploads/*key` route is unauthenticated, relying on key unguessability (CUID + timestamp). For truly private content, consider signed URLs or auth middleware on the serve route.
- The `multer` file filter checks both MIME type and file extension, but MIME types from `Content-Type` headers are client-controlled and can be spoofed. The sharp processing pipeline implicitly validates the actual image data (it will throw on non-image input), which provides defense in depth.
- The `PATCH /users/me/profile` route still accepts `avatarUrl` in the body, which could be used to set an arbitrary S3 key (same concern removed from server PATCH). Consider restricting profile avatar changes to the upload endpoint only.
- `ServerSettingsModal` and `CreateServerModal` duplicate the icon selection/preview/cleanup logic. Consider extracting a shared `ImageUploadButton` component.
- The `/forgot-password` endpoint has no rate limiting. An attacker could trigger mass emails to a valid address. Consider adding per-IP or per-email rate limiting when rate limiter infrastructure is implemented.
- Socket.IO authentication middleware validates the JWT signature at handshake time but does not check `tokenVersion` against the database. After a password change or reset, a revoked access token can maintain an existing WebSocket connection for its remaining lifetime. This is the standard JWT trade-off -- access tokens are stateless and short-lived (15 min). Periodic re-authentication on the socket would require architectural changes (middleware on every socket event or periodic disconnect/reconnect).
