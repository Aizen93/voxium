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
- Two-tier admin dashboard (admin + superadmin roles) with user/server/ban management, storage tools, live metrics, audit log, moderation queue (reports), support ticket management
- Admin user deletion with server ownership transfer
- Rate limiting (per-endpoint + socket-level) and input sanitization
- Tauri 2 desktop wrapper with native notifications
- Support ticket system (one-per-user, real-time chat with staff, admin claim/close workflow)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express, TypeScript, Prisma, PostgreSQL, Redis, Socket.IO |
| Frontend | React 19, Vite 6, Zustand, Tailwind CSS, Tauri 2 |
| Voice | WebRTC (mesh P2P), RNNoise WASM noise suppression |
| Storage | S3-compatible (presigned URL direct upload) |
| Admin | React 19, Vite, Zustand (standalone app, port 8082) |

## Known Issues

- No duplicate report prevention (same user can submit multiple pending reports against the same target)
- Support ticket admin claim flow has a socket room join timing issue: status change and system message events are emitted to `support:{ticketId}` room BEFORE the claiming admin's socket is joined to that room, so the admin misses the real-time update (ticket list refresh via REST compensates)
- Support routes `POST /support/open` and `GET /support/ticket` lack per-endpoint rate limiting (only covered by global limiter)
- Admin support message endpoint hardcodes validation limits (1-2000) instead of using `LIMITS.SUPPORT_MESSAGE_MIN`/`LIMITS.SUPPORT_MESSAGE_MAX` from shared constants
- Admin viewing an unclaimed support ticket does not receive real-time message updates (socket only joined to `support:{ticketId}` room upon claiming)

## Remaining Work

- [ ] mediasoup SFU for production-grade voice/video
- [ ] Redis-based voice state for multi-node
- [ ] Horizontal scaling, CI/CD, monitoring
- [ ] Mobile app (React Native)
- [ ] End-to-end testing

## Recent Changes

- **Support Ticket System** (2026-03-05) — `SupportTicket` + `SupportMessage` Prisma models (one ticket per user via `@@unique([userId])`), user-facing `POST /support/open` (create/reopen), `GET /support/ticket` (fetch with cursor pagination), `POST /support/messages` (send with sanitization + rate limiting), admin routes for ticket listing/claiming/messaging/closing with audit logging (`support.claim`, `support.close`), real-time via `support:{ticketId}` Socket.IO rooms and `admin:support` subscription for ticket count updates, `supportStore.ts` Zustand store for desktop client, `SupportTicketView` chat UI, `AdminSupportTickets` admin panel with ticket queue + chat, socket auto-join for open/claimed tickets on connect, open tickets count on admin dashboard stat card, support audit actions in audit log labels.

- **Reports/Moderation Queue + Staff Badge** (2026-03-05) — `Report` model (type: message/user, status: pending/resolved/dismissed), user-facing `POST /reports` endpoint with rate limiting, admin report management (`GET /admin/reports`, `POST /admin/reports/:id/resolve` with optional ban, `POST /admin/reports/:id/dismiss`), real-time admin notifications via `report:new` socket event + `admin:reports` room subscription, `StaffBadge` component shown in message headers/member sidebar/DM list/profile popups for admin/superadmin users, `ReportModal` portaled component for message and user reports, `AdminReports` moderation queue page with filter tabs and resolve/dismiss workflows, `role` field added to message author selects across `messages.ts` and `dm.ts`, audit log entries for `report.resolve` and `report.dismiss`, pending reports count on admin dashboard.

- **Admin Audit Log** (2026-03-05) — `AuditLog` model, fire-and-forget `logAuditEvent()`, `GET /admin/audit-logs`, `AdminAuditLog` UI page. Logs all destructive admin actions.

## Related Documents

- **`CLAUDE.md`** — Commands, conventions, architecture patterns, important invariants
- **`Architecture.md`** — Detailed system architecture, database design, scalability strategy
- **`CONTEXT_CHANGELOG.md`** — Full feature-by-feature development history with file changes and review notes
