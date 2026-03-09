# Voxium

**A free, open-source real-time communication platform built for privacy.**

> **Try it now:** [https://voxium.app](https://voxium.app)

Tired of handing over your phone number, ID, and personal data just to chat with friends? Voxium is built for people who believe privacy isn't a premium feature — it's a right. No phone verification, no identity checks, no data harvesting. Just real-time voice and text chat that works.

Self-host it, audit the code, and own your conversations. No corporation sitting between you and your community.

---

## Why Voxium?

- **Zero personal data required** — No phone number, no ID verification, no tracking
- **Fully open source** — Audit every line, self-host on your own infrastructure
- **Production-ready voice** — mediasoup SFU for servers, direct P2P for DM calls, with AI noise suppression (RNNoise ML)
- **Cross-platform** — Native desktop apps for Windows, macOS, and Linux via Tauri 2
- **Modern stack** — React 19, TypeScript, Zustand, Tailwind CSS, real-time WebSockets

---

## Features

| Category | Feature | Description |
|----------|---------|-------------|
| **Communication** | Servers & Channels | Create servers, organize with categories, text and voice channels, drag-and-drop reordering, single-use invite links |
| | Real-Time Messaging | Instant delivery, typing indicators, cursor-based pagination, unread badges per channel and server |
| | Message Replies | Reply with compact preview, click to scroll to original, graceful handling of deleted parents |
| | Message Editing & Deletion | Edit inline, delete with confirmation; admins can delete any message |
| | Reactions | Emoji reactions with grouped display and toggle support (channels and DMs) |
| | Direct Messages | 1-on-1 text with real-time delivery, typing indicators, reactions, persistent unread tracking, conversation deletion |
| | Message Search | Full-text search across server channels and DM conversations with jump-to-message navigation |
| **Voice** | Server Voice (SFU) | mediasoup Selective Forwarding Unit for scalable voice (25+ users per channel), speaking indicators, latency display |
| | DM Voice Calls | 1-on-1 WebRTC P2P audio with incoming call modal, ringtone, speaking indicators, call history as system messages |
| | Screen Sharing | Share screen in voice channels with real-time video and system audio, inline/floating viewer modes |
| | AI Noise Suppression | ML-powered RNNoise WASM filter removes keyboard, mouse, and background noise in real time via AudioWorklet |
| | Opus Optimization | DTX for bandwidth savings, in-band FEC for packet loss recovery, optimized bitrate |
| | Push-to-Talk | Configurable input mode with key binding picker; noise gate sensitivity slider for voice activity mode |
| | Audio Settings | Input/output device selection, live mic level meter, noise suppression toggle, persisted preferences |
| | Mute/Deaf Controls | Always-visible controls that persist across channel switches, server switches, and app restarts |
| **Social** | Friend System | Send, accept, decline, and remove friend requests with real-time notifications |
| | Roles & Permissions | Owner/Admin/Member hierarchy; role changes, member kicks, ownership transfer |
| | User Profiles | Avatars with online/offline status, display names, bios with real-time sync across all clients |
| | Presence | Real-time online/offline status for all server members and DM participants |
| **Admin** | Admin Dashboard | Two-tier admin/superadmin panel with user/server/ban management, storage management (avatars/icons/attachments with top uploaders and orphan cleanup), live metrics, audit log, moderation queue |
| | Resource Limits | Dynamic limits (max channels, voice users, categories, members) — global defaults with per-server overrides |
| | Feature Flags | Toggle registration, invites, server creation, voice, DM voice, support — Redis-backed, no redeploy needed |
| | Reports & Moderation | User/message reports, admin moderation queue with resolve/dismiss/ban workflows |
| | Support Tickets | One-per-user real-time chat with staff, admin claim/close workflow, audit logging |
| **Security** | Two-Factor Auth | TOTP 2FA with authenticator app support, QR code setup, 8 backup codes, 30-day trusted device tokens |
| | Authentication | JWT with refresh tokens, remember me, forgot/reset password via email, token version-based session invalidation |
| | Rate Limiting | Per-endpoint and per-socket rate limiting, admin-editable via Redis-backed registry |
| | Input Sanitization | HTML stripping, validation, CORS protection |
| **Platform** | File Uploads | S3-compatible storage for avatars, server icons, and message attachments with presigned URLs; attachments proxied through server (S3 URL never exposed); 3-day retention with automated daily cleanup + email report |
| | Notifications | In-app toasts, notification sounds for voice join/leave and messages, native desktop notifications |
| | Cross-Platform Desktop | Tauri 2 native apps (Windows, macOS, Linux) with Discord-inspired dark UI |
| | Landing Page | Public-facing page for browser visitors with animated SVG illustrations |

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Backend | Node.js, Express, Socket.IO, Prisma, PostgreSQL, Redis |
| Frontend | React 19, TypeScript, Vite, Zustand, Tailwind CSS |
| Desktop | Tauri 2 (Rust) |
| Voice | mediasoup SFU (server), WebRTC P2P (DM), RNNoise WASM, Web Audio API |
| Infrastructure | S3-compatible storage, Nodemailer (SMTP) |

---

## Quick Start

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | >= 20.x | JavaScript runtime |
| **pnpm** | >= 9.x | Package manager |
| **PostgreSQL** | >= 15.x | Database (local installation) |
| **Docker** & **Docker Compose** | Latest | Redis container |
| **Rust** | Latest stable | Required by Tauri for desktop builds |
| **Git** | Latest | Version control |

#### Platform-Specific Requirements

**Windows:**
- Microsoft Visual Studio C++ Build Tools
- WebView2 (included in Windows 11, install manually on Windows 10)

**macOS:**
- Xcode Command Line Tools: `xcode-select --install`

**Linux (Debian/Ubuntu):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

#### Install pnpm (if not installed)
```bash
npm install -g pnpm
```

#### Install Rust (if not installed)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

---

### 1. Clone the Repository
```bash
git clone <repository-url>
cd Voxium
```

### 2. Install Dependencies
```bash
pnpm install
```

### 3. Set Up PostgreSQL
```bash
psql -U postgres -c "CREATE DATABASE voxium;"
```

### 4. Start Redis
```bash
docker compose up -d
```

### 5. Configure Environment
```bash
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env` and set `DATABASE_URL` with your local PostgreSQL password:
```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/voxium?schema=public"
```

### 6. Set Up the Database
```bash
# Generate Prisma client
pnpm --filter @voxium/server db:generate

# Run database migrations
pnpm --filter @voxium/server db:migrate

# (Optional) Seed with demo data
pnpm --filter @voxium/server db:seed
```

### 7. Build Shared Package
```bash
pnpm run build:shared
```

### 8. Start Development Servers

**Option A: Start everything together**
```bash
pnpm run dev
```

**Option B: Start individually (recommended)**

Terminal 1 — Backend:
```bash
pnpm run dev:server
```

Terminal 2 — Frontend:
```bash
pnpm run dev:desktop
```

The backend runs on `http://localhost:3001` and the frontend on `http://localhost:8080`.

---

## Running as Desktop App (Tauri)

```bash
cd apps/desktop
pnpm tauri:dev
```

This compiles the Rust backend, starts the Vite dev server, and opens the native window.

---

## Building for Production

### Build the Backend
```bash
pnpm run build:server
```

Run in production:
```bash
cd apps/server
NODE_ENV=production node dist/index.js
```

### Build the Desktop App
```bash
cd apps/desktop
pnpm tauri:build
```

This creates platform-specific installers in `apps/desktop/src-tauri/target/release/bundle/`:
- **Windows:** `.msi` and `.exe` installers
- **macOS:** `.dmg` and `.app` bundle
- **Linux:** `.deb`, `.AppImage`, and `.rpm` packages

---

## Database Management

```bash
# Open Prisma Studio (visual database browser)
pnpm run db:studio

# Create a new migration
cd apps/server
npx prisma migrate dev --name your_migration_name

# Reset database (deletes all data)
npx prisma migrate reset

# Seed demo data
pnpm run db:seed
```

Demo seed creates:
- **Users:** `alice`, `bob`, `charlie` (password: `password123`)
- **Server:** "Voxium Community" with text and voice channels
- **Messages:** Sample messages in #general

---

## Testing the API

### Health Check
```bash
curl http://localhost:3001/health
```

### Register a User
```bash
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@example.com","password":"password123"}'
```

### Login
```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

### Use the Token
```bash
# Replace <TOKEN> with the accessToken from login response
curl http://localhost:3001/api/v1/servers \
  -H "Authorization: Bearer <TOKEN>"
```

---

## Configuration Reference

### Server Environment Variables (`apps/server/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_SECRET` | — | **Required.** Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | — | **Required.** Secret for signing refresh tokens |
| `JWT_EXPIRES_IN` | `15m` | Access token expiry |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token expiry |
| `PORT` | `3001` | HTTP server port |
| `NODE_ENV` | `development` | Environment mode |
| `CORS_ORIGIN` | `http://localhost:8080` | Allowed CORS origin(s) |
| `S3_ASSETS_ENDPOINT` | — | S3-compatible storage endpoint |
| `S3_ASSETS_REGION` | — | S3 bucket region |
| `S3_ACCESS_KEY` | — | S3 access key |
| `S3_SECRET_KEY` | — | S3 secret key |
| `S3_ASSETS_BUCKET` | — | S3 bucket name |
| `SMTP_HOST` | `localhost` | SMTP server host |
| `SMTP_PORT` | `1025` | SMTP server port |
| `SMTP_USER` | — | SMTP auth username |
| `SMTP_PASS` | — | SMTP auth password |
| `SMTP_FROM` | `noreply@voxium.app` | Sender email address |
| `CLIENT_URL` | `http://localhost:8080` | Frontend URL (used in emails) |
| `CLEANUP_REPORT_EMAIL` | — | Email address for daily attachment cleanup reports. If not set, no report is sent. |
| `TOTP_ENCRYPTION_KEY` | — | 32-byte hex key for encrypting TOTP secrets at rest. Generate with `openssl rand -hex 32`. Optional — if not set, TOTP secrets are stored unencrypted. |
| `MEDIASOUP_ANNOUNCED_IP` | — | Public IP address announced to WebRTC clients for mediasoup SFU connectivity. Required for production. |

### Frontend Environment Variables (`apps/desktop/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001/api/v1` | Backend API base URL |
| `VITE_WS_URL` | `http://localhost:3001` | WebSocket server URL |

### Admin Dashboard Environment Variables (`apps/admin/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001/api/v1` | Backend API base URL |
| `VITE_WS_URL` | `http://localhost:3001` | WebSocket server URL |

---

## Troubleshooting

### "Cannot find module '@voxium/shared'"
```bash
pnpm run build:shared
```

### Database connection refused
```bash
# Check PostgreSQL is running
psql -U postgres -c "SELECT 1;"

# Create database if it doesn't exist
psql -U postgres -c "CREATE DATABASE voxium;"

# Check Redis is running
docker compose ps
docker compose up -d
```

### Prisma client not generated
```bash
pnpm --filter @voxium/server db:generate
```

### Port already in use
Change the port in `.env` (server) or `vite.config.ts` (frontend).

### Tauri build fails
```bash
rustup update
```
On Linux, ensure all system dependencies are installed (see Prerequisites).

### WebSocket connection fails
1. Check that the backend server is running
2. Verify `CORS_ORIGIN` matches the frontend URL
3. Verify `VITE_WS_URL` points to the correct backend

---

## Scripts Reference

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start backend and frontend in parallel |
| `pnpm dev:server` | Start backend with hot reload |
| `pnpm dev:desktop` | Start frontend Vite dev server |
| `pnpm build` | Build all packages for production |
| `pnpm build:shared` | Build shared types package |
| `pnpm build:server` | Build backend TypeScript |
| `pnpm build:desktop` | Build frontend for production |
| `pnpm typecheck` | Run TypeScript type checking across all packages |
| `pnpm lint` | Run ESLint across all packages |
| `pnpm db:migrate` | Run Prisma migrations |
| `pnpm db:seed` | Seed database with demo data |
| `pnpm db:studio` | Open Prisma Studio |

---

## License

This project is open source. See the repository for license details.
