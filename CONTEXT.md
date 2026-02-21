# Voxium - Project Context

## Overview

**Voxium** is a modern, open-source voice and text communication platform — a Discord alternative built from scratch. It enables users to create servers, organize channels, and communicate via real-time text messaging and voice chat.

## Project Status

**Version:** 0.1.0 (Foundation)
**Date:** 2026-02-20
**Stage:** Initial architecture and codebase setup complete

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
  - Axios HTTP client with token interceptor and auto-refresh
  - Socket.IO client with typed events

### 4. Shared Package (`packages/shared`)

- All TypeScript interfaces and types for the entire platform
- Input validators (username, email, password, server name, channel name, message content)
- Constants (limits, event names, etc.)
- Used by both server and desktop packages

### 5. Infrastructure

- `docker-compose.yml` for PostgreSQL 16 + Redis 7
- Prisma migrations ready
- Database seed script with demo data (3 users, 1 server, sample messages)

## What Is NOT Yet Done (Planned for Next Iterations)

### V0.2 - Polish & Stability
- [ ] WebRTC audio peer connections (actual audio streaming via simple-peer/mediasoup)
- [ ] Message editing/deletion UI
- [ ] Server settings panel
- [ ] User settings/profile editing
- [ ] File/image upload support
- [ ] Emoji picker integration
- [ ] Notification system (desktop notifications)
- [ ] Error boundary and toast notifications in UI

### V0.3 - Enhanced Features
- [ ] Video calls
- [ ] Screen sharing
- [ ] Direct messages (DMs)
- [ ] Friend system
- [ ] Role/permission management
- [ ] Channel categories
- [ ] Message reactions
- [ ] Rich text / markdown in messages
- [ ] Message search

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
