# Voxium - Project Context

## Overview

**Voxium** is a modern, open-source voice and text communication platform — a Discord alternative built from scratch. It enables users to create servers, organize channels, and communicate via real-time text messaging and voice chat.

## Project Status

**Version:** 0.2.6 (Real-Time Channel Management)
**Date:** 2026-02-23
**Stage:** Full TypeScript strict compliance across server and desktop, pre-commit type-check gate, real-time channel CRUD

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
  - `POST /api/v1/invites/servers/:id` — Create invite
  - `POST /api/v1/invites/:code/join` — Use invite
  - `GET /api/v1/invites/:code` — Preview invite
  - `GET /api/v1/users/:id` — User profile
  - `PATCH /api/v1/users/me/profile` — Update own profile

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
- [ ] Push-to-talk mode
- [ ] Notification sounds
- [ ] Unread message indicators
- [ ] Toast notifications in UI

### V0.3 - Enhanced Features
- [ ] Message editing/deletion UI
- [ ] File/image upload support
- [ ] Message reactions
- [ ] Direct messages (DMs)
- [ ] Friend system
- [ ] Server settings panel
- [ ] User settings/profile editing
- [ ] Role/permission management
- [ ] Channel categories
- [ ] Emoji picker integration
- [ ] Rich text / markdown in messages
- [ ] Message search
- [ ] Screen sharing

### V0.4 - Scalability
- [ ] mediasoup SFU for production-grade voice/video
- [ ] Redis-based voice state for multi-node deployment
- [ ] Horizontal scaling with sticky sessions
- [ ] CDN for static assets
- [ ] File storage (S3-compatible)
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
- **URL extraction:** `CreateServerModal` extracts the invite code from full URLs (e.g., `http://localhost:1420/invite/UsLnacI8`) using a regex match on `/invite/([^\s/]+)`.

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

### Known Issues / Suggestions
- `io.fetchSockets()` in `memberBroadcast.ts` retrieves ALL connected sockets. Fine for small deployments but at scale, use a `userId -> socketId[]` index or Redis adapter's `remoteJoin`/`remoteLeave`.
- The `member:joined` event sends `email: ''` to satisfy the `User` type in `ServerToClientEvents`. Consider a `PublicUser` type that omits `email`.
- Prisma `Invite` model still has `maxUses` and `uses` columns that are no longer used. Cleanup migration pending.
- `SaveAndRedirect` in `App.tsx` performs `localStorage.setItem` during render (not in `useEffect`). Functionally correct since `Navigate` redirects immediately, but technically impure.
