# Voxium - Project Context

## Overview

**Voxium** is a modern, open-source voice and text communication platform — a Discord alternative. Monorepo with pnpm workspaces: Node.js/Express backend, React/Tauri 2 desktop client, standalone admin dashboard, and shared types package.

**Version:** 0.9.8
**Date:** 2026-03-05

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

- Real-time text messaging with editing, deletion, reactions, replies, search
- WebRTC P2P voice chat (server channels + 1-on-1 DM calls) with push-to-talk, noise suppression, screen sharing
- Server/channel/category management with drag-and-drop reordering
- JWT auth with refresh tokens, password reset, Remember Me
- S3 file uploads (avatars, server icons) with presigned URLs
- Direct messages with typing indicators, reactions, unread tracking
- Friend request system with real-time notifications
- Unread indicators (channel + server level, persistent via DB)
- Two-tier admin dashboard (admin + superadmin roles) with user/server/ban management, storage tools, live metrics
- Admin user deletion with server ownership transfer
- Rate limiting (per-endpoint + socket-level) and input sanitization
- Tauri 2 desktop wrapper with native notifications

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express, TypeScript, Prisma, PostgreSQL, Redis, Socket.IO |
| Frontend | React 19, Vite 6, Zustand, Tailwind CSS, Tauri 2 |
| Voice | WebRTC (mesh P2P), RNNoise WASM noise suppression |
| Storage | S3-compatible (presigned URL direct upload) |
| Admin | React 19, Vite, Zustand (standalone app, port 8082) |

## Remaining Work

- [ ] mediasoup SFU for production-grade voice/video
- [ ] Redis-based voice state for multi-node
- [ ] Horizontal scaling, CI/CD, monitoring
- [ ] Mobile app (React Native)
- [ ] End-to-end testing

## Related Documents

- **`CLAUDE.md`** — Commands, conventions, architecture patterns, important invariants
- **`Architecture.md`** — Detailed system architecture, database design, scalability strategy
- **`CONTEXT_CHANGELOG.md`** — Full feature-by-feature development history with file changes and review notes
