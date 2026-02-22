# Voxium - Project Context

## Overview

**Voxium** is a modern, open-source voice and text communication platform — a Discord alternative built from scratch. It enables users to create servers, organize channels, and communicate via real-time text messaging and voice chat.

## Project Status

**Version:** 0.2.0 (Voice Features & Stability)
**Date:** 2026-02-22
**Stage:** Voice features implemented, real-time stability hardening in progress

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
  - Main app layout (3-panel Discord-like design)
- **Components:**
  - `ServerSidebar` — Icon strip of servers with tooltips, active indicators, create/join modal
  - `ChannelSidebar` — Text and voice channel lists, inline channel creation
  - `ChatArea` — Message list with infinite scroll, grouped messages, typing indicators
  - `MessageInput` — Auto-resizing textarea with typing emission
  - `MemberSidebar` — Member list grouped by role with presence indicators
  - `VoicePanel` — Voice connection panel with mute/deaf controls, user list with speaking indicators
  - `CreateServerModal` — Dual-mode (create new / join via invite)
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
- [ ] Ongoing: real-time message delivery reliability after reconnects (diagnostics added, investigation in progress)
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

### New Files Added in v0.2
- `apps/desktop/src/services/audioAnalyser.ts` — Speaking detection via AudioContext
- `apps/desktop/src/stores/settingsStore.ts` — Audio device preferences with localStorage persistence
- `apps/desktop/src/components/settings/SettingsModal.tsx` — Audio device selection UI
- `apps/desktop/src/components/voice/ConnectionQuality.tsx` — Signal strength bars
- `apps/desktop/src/components/layout/ConnectionBanner.tsx` — Reconnecting/disconnected banner
- `apps/desktop/src/components/layout/ErrorBoundary.tsx` — React error boundary with recover UI
- `apps/desktop/src/hooks/useLocalAudioLevel.ts` — Real-time mic level for local avatar indicator
