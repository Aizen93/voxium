## Quality-of-life (low effort, high polish):
  - [x] Stabilizing the code, with better error handling and exception management. User friendly and smoother UI.  
  - [x] Push-to-talk — alternative to voice activity; just a keybind that mutes/unmutes, easy to add alongside the existing mute logic
  - [x] Notification sounds — play a tone on join/leave/message; the audio infrastructure is already there
  - [x] Unread indicators / mention badges — channel list currently has no unread state, which makes multi-channel usage painful
  - [x] When a new User joins the server, the members list is not updating in real time and needs a page refresh to see the new user in the members list (Right side panel)
  - [x] When a user (Alice) creates a new server, and joins a channel, she can't see her name in the channel list (Though she can speak and hear just fine)
  - [x] When creating a new voice channel or a new text channel, the other users does not see it in real time and require a page refresh
  - [x] Tauri client does not receive windows notifications, how do we activate them by default, or prompt the user to activate notifications. Our apps Settings has notifications enabled.
  - [x] Security : Throtling, xss, sql injections, and rate limiting, captcha. Rate limiting — rate-limiter-flexible is installed but not wired up. Protect auth, uploads, message send, and forgot-password endpoints.
  - [x] Password forgot + profile password change

## Core chat features (medium effort):
  - [] File & image uploads — drag-and-drop or paste images into chat, preview inline. Needs a storage backend (S3/local) and a new message — S3 infrastructure already exists. Add attachments to Message model, multer handler in messages route, drag-and-drop + paste in MessageInput, inline previews in
  - [x] Message reactions — emoji reactions on messages; very common expectation for a chat app
  - [x] Message editing & deletion UI — the server events (message:update, message:delete) are already wired, but I didn't see an edit/delete UI in the chat bubbles
  - [x] Message search — PostgreSQL full-text search (tsvector on message.content). Search modal with filters by channel/author/date. High ROI for any server with history.
  - [x] Channel categories — New ChannelCategory model with collapsible headers in ChannelSidebar. Small effort, big polish for servers with 10+ channels.
  - [x] Rich text / Markdown — Discord-style formatting (bold, italics, code blocks, links). Store raw markdown, render with react-markdown.

## Bigger features (high effort, high value):
  - [x] Direct messages (DMs) — 1:1 and group DMs outside of servers; this is a significant architecture addition but is probably the most-expected missing feature
  - [] Screen sharing — the WebRTC peer connections are already set up; adding a video track for screen capture is a natural extension
  - [x] Server roles & permissions — the MemberRole type exists (owner/admin/member) but I didn't see permission checks on the client for things like channel creation or member management



Quick Wins (high impact, low effort)

  1. [x] Server startup env var validation — S3 env vars use ! assertions; missing vars cause cryptic AWS errors. Add validation at boot.
  2. [x] PublicUser type — member:joined sends email: '' to satisfy the User type. A PublicUser (omitting email) fixes this properly.
  3. [x] Debounce PTT state broadcasts — Rapid PTT toggles flood the server:{id} room with voice:state_update. A 100ms debounce would cut traffic significantly.
  4. [x] Cleanup stale Prisma columns — Invite.maxUses and Invite.uses are unused. Quick migration to drop them.

  Security (should ship before any public release)
  10. [x] sanitization — Currently relying on JSX escaping alone. Add explicit sanitization for messages, bios, and server names.


V0.4 Scalability (longer-term)
  - mediasoup SFU for production voice/video
  - Redis-based voice state
  - Horizontal scaling

----------------------------------

Voxium v0.9.6 is feature-complete for initial launch. The user needs a step-by-step deployment guide to ship the full stack on a single OVH B2-7 instance in France (Europe), within a 50€/month budget. All
 services (PostgreSQL, Redis, Node.js backend, nginx serving frontend) run on one machine.

 What This Plan Produces

 A single markdown file — DEPLOYMENT.md — placed at the project root, containing a complete copy-pasteable deployment guide.

 Budget Breakdown

 ┌─────────────────────────────────────────────────────────┬─────────────────────────────┐
 │                          Item                           │            Cost             │
 ├─────────────────────────────────────────────────────────┼─────────────────────────────┤
 │ OVH B2-7 (2 vCores, 7GB RAM, 50GB SSD) — GRA/SBG region │ ~24€/month                  │
 ├─────────────────────────────────────────────────────────┼─────────────────────────────┤
 │ Domain name (.com or .chat)                             │ ~9€/year ≈ 0.75€/month      │
 ├─────────────────────────────────────────────────────────┼─────────────────────────────┤
 │ OVH S3 Object Storage (already in use)                  │ ~1-2€/month (minimal usage) │
 ├─────────────────────────────────────────────────────────┼─────────────────────────────┤
 │ Let's Encrypt SSL                                       │ Free                        │
 ├─────────────────────────────────────────────────────────┼─────────────────────────────┤
 │ Total                                                   │ ~26€/month                  │
 └─────────────────────────────────────────────────────────┴─────────────────────────────┘

 Architecture on Single Instance

 Internet → nginx (80/443)
               ├── / → static files (apps/desktop/dist/)
               ├── /api/v1/* → proxy to Node.js :3001
               └── /socket.io/* → proxy (WebSocket upgrade) to Node.js :3001

            Node.js :3001 (PM2)
               ├── PostgreSQL localhost:5432
               └── Redis localhost:6379

 Guide Sections (Table of Contents for DEPLOYMENT.md)

 1. Prerequisites & Infrastructure — Create OVH B2-7 instance (Ubuntu 24.04, GRA/SBG region), buy domain, configure DNS A record
 2. Initial Server Setup — SSH, create deploy user, disable root login, UFW firewall (22, 80, 443)
 3. Install System Dependencies — Node.js 20 LTS (via nodesource), pnpm 9, PostgreSQL 16, Redis 7, nginx, Certbot, git
 4. Configure PostgreSQL — Create voxium database and user, password auth, localhost-only binding
 5. Configure Redis — Verify localhost binding, systemd enabled
 6. Clone & Build Application — Clone repo, pnpm install, build shared → server → desktop
 7. Environment Configuration — Create apps/server/.env with all production values (DATABASE_URL, JWT secrets, S3 creds, SMTP, CORS pointing to domain)
 8. Frontend Environment — Create apps/desktop/.env with VITE_API_URL and VITE_WS_URL pointing to https://yourdomain.com, rebuild frontend
 9. Database Migration — Run npx prisma migrate deploy and optionally seed
 10. PM2 Setup — Install PM2 globally, start server with ecosystem config, pm2 startup + pm2 save for boot persistence
 11. Nginx Configuration — Server block with reverse proxy for API + WebSocket upgrade headers, serve static frontend, gzip compression
 12. SSL with Let's Encrypt — certbot --nginx, auto-renewal via systemd timer
 13. SMTP Configuration — Options: OVH email (free with domain), Brevo free tier (300 emails/day), or Mailgun
 14. Verification Checklist — curl health check, browser test, WebSocket, voice call, screen share
 15. Maintenance — PostgreSQL backups (pg_dump cron), app updates (git pull + rebuild + pm2 restart), log rotation, monitoring with pm2 monit
 16. Tauri Desktop Client — Update env vars to production URL, build installers with pnpm tauri:build
 17. Troubleshooting — Common issues (502, WebSocket fail, CORS, SSL renewal)

 Key Technical Decisions

 - B2-7 over B2-15: 2 vCores / 7GB RAM is plenty for initial launch (Node.js + PostgreSQL + Redis + nginx). Easy upgrade path if needed.
 - Local PostgreSQL: Saves ~20-30€/month vs managed DB. Guide includes automated pg_dump backup cron.
 - PM2: Node.js process manager with auto-restart, log rotation, pm2 startup for boot persistence. Simpler than raw systemd for Node.js.
 - nginx: Serves static frontend files + reverse proxies API/WebSocket. Standard approach, well-documented.
 - Single domain: Same domain serves frontend (/) and API (/api/v1/, /socket.io/). No CORS issues, simpler SSL.
 - Let's Encrypt: Free SSL with auto-renewal.
 - UFW: Simple firewall — only ports 22, 80, 443 open.

 File to Create

 ┌───────────────┬───────────────────────────────────────────────────────────────┐
 │     File      │                            Action                             │
 ├───────────────┼───────────────────────────────────────────────────────────────┤
 │ DEPLOYMENT.md │ New — complete step-by-step deployment guide (~300-400 lines) │
 └───────────────┴───────────────────────────────────────────────────────────────┘

 Verification

 After writing DEPLOYMENT.md:
 1. Every step should be copy-pasteable (exact commands)
 2. All 8 required env vars from index.ts validation are covered
 3. nginx config handles WebSocket upgrade (Upgrade, Connection headers)
 4. Frontend .env uses https:// URLs pointing to the production domain
 5. Firewall blocks everything except SSH + HTTP + HTTPS
 6. PM2 ecosystem file uses NODE_ENV=production
 7. PostgreSQL backup cron is included
 8. Troubleshooting section covers the most common deployment failures