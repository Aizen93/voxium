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

## Key Highlights

<table>
<tr>
<td width="50%">

### Advanced Permission System
Discord-style role-based access control with 20 granular permission flags, per-channel overrides (allow/deny/inherit), role hierarchy enforcement, and a permission calculator that resolves @everyone → role permissions → channel overrides. Admins manage roles, assign them to members, and configure channel-specific restrictions — all through the UI.

</td>
<td width="50%">

### Production-Ready Voice
mediasoup SFU handles 25+ users per voice channel with AI noise suppression (RNNoise ML), silence detection (70-94% bandwidth savings), push-to-talk, screen sharing, and voice quality selector. Voice moderation: server mute/deafen persists across reconnects via Redis, cross-channel force-move.

</td>
</tr>
<tr>
<td width="50%">

### Privacy-First Architecture
Zero third-party services — no Google STUN, no analytics, no CDNs. Self-hosted STUN via coturn, all media stays on your infrastructure. No phone number or ID required to sign up.

</td>
<td width="50%">

### Full-Stack Security
JWT with HS256 pinning, TOTP 2FA with encrypted secrets, bcrypt with 72-byte limit, timing-safe auth flows, IDOR prevention, runtime socket payload validation, rate limiting on every endpoint, email verification gate, and comprehensive input sanitization.

</td>
</tr>
</table>

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
| | Mute/Deaf Controls | Self mute/deaf persisted across sessions; server force-mute/deafen by moderators (persists via Redis, cannot be bypassed) |
| | Voice Moderation | Server mute/deafen (persists across reconnect via Redis), cross-channel force-move, role hierarchy enforcement |
| **Permissions** | Custom Roles | Create unlimited custom roles with names, colors, and granular permissions; role hierarchy enforcement prevents privilege escalation |
| | 20 Permission Flags | VIEW_CHANNEL, SEND_MESSAGES, MANAGE_CHANNELS, MANAGE_ROLES, KICK_MEMBERS, MUTE_MEMBERS, ATTACH_FILES, ADMINISTRATOR, and 12 more |
| | Channel Overrides | Per-channel permission overrides with allow/deny/inherit tri-state per role — restrict #announcements to read-only, hide #staff channels |
| | Permission Calculator | Discord-style resolution: @everyone base → OR all role permissions → channel overrides; ADMINISTRATOR bypasses everything |
| | Voice Moderation | Server mute/deafen (persists across reconnect via Redis), cross-channel force-move, role hierarchy enforcement |
| | Per-Server Nicknames | Members can set server-specific display names; admins can manage others' nicknames |
| **Social** | Friend System | Send, accept, decline, and remove friend requests with real-time notifications |
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
| Backend | Node.js, Express 5, Socket.IO, Prisma 7, PostgreSQL, Redis 5 |
| Frontend | React 19, TypeScript, Vite 7, Zustand, Tailwind CSS 4 |
| Desktop | Tauri 2 (Rust) |
| Voice | mediasoup SFU (server), WebRTC P2P (DM), RNNoise WASM, Web Audio API |
| Testing | Vitest, Supertest, Playwright (E2E) |
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

Open **`http://localhost:8080`** in your browser to use Voxium. No additional setup needed — the Vite dev server serves the full web client.

### 9. Admin Dashboard (Optional)

The admin dashboard is a separate React app for managing users, servers, bans, feature flags, resource limits, and viewing live metrics.

Start it in a new terminal:

```bash
pnpm run dev:admin
```

The admin dashboard runs on **`http://localhost:8082`**. It connects to the same backend server.

> **Note:** You need an admin account to log in. Use Prisma Studio (`pnpm db:studio`) to set a user's `role` field to `admin` or `superadmin`.

---

## Running as Desktop App (Tauri)

If you want to run Voxium as a native desktop app:

```bash
cd apps/desktop
pnpm tauri:dev
```

This starts both the Vite dev server (`http://localhost:8080`) and the native Tauri desktop window simultaneously. You can use either the browser or the desktop app — both connect to the same backend.

Requires [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (Rust toolchain + platform-specific dependencies listed in Prerequisites above).

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

## Docker Deployment (Production)

Docker packages the **backend server** alongside PostgreSQL and Redis. This is the easiest way to deploy Voxium on your own server.

### Prerequisites

- Docker 20+
- Docker Compose v2+

### 1. Create the Environment File

```bash
cp .env.production.example .env.production
```

### 2. Configure `.env.production`

Open `.env.production` and fill in all values:

```env
# ── Database ──────────────────────────────────────────────────────────────────
# Pick a strong password — used by both PostgreSQL and the server
POSTGRES_PASSWORD=your_strong_password_here

# ── Auth (generate with: openssl rand -hex 32) ───────────────────────────────
JWT_SECRET=your_random_64_char_secret
JWT_REFRESH_SECRET=another_random_64_char_secret

# ── TOTP (generate with: openssl rand -hex 32) ───────────────────────────────
TOTP_ENCRYPTION_KEY=your_32_byte_hex_key

# ── S3 / Object Storage (required for file uploads) ──────────────────────────
S3_ASSETS_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_ASSETS_REGION=us-east-1
S3_ACCESS_KEY=your_access_key
S3_SECRET_KEY=your_secret_key
S3_ASSETS_BUCKET=your-bucket-name

# ── SMTP (optional, for password reset emails) ───────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
SMTP_FROM=noreply@yourdomain.com

# ── App ───────────────────────────────────────────────────────────────────────
PORT=3001
# CORS_ORIGIN must match the URL where your frontend is hosted.
# For local testing with the dev frontend, use: http://localhost:8080
CORS_ORIGIN=https://yourdomain.com
CLIENT_URL=https://yourdomain.com

# ── mediasoup (Voice) ────────────────────────────────────────────────────────
# ANNOUNCED_IP must be your server's public IP for voice to work
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=YOUR_SERVER_PUBLIC_IP
MEDIASOUP_MIN_PORT=10000
MEDIASOUP_MAX_PORT=10100
```

> **Important:** `MEDIASOUP_ANNOUNCED_IP` must be your server's public IP address. Voice channels will not work without this.

> **Windows users:** If ports 10000-10100 conflict with Hyper-V reserved ranges, use a different range like `20000-20100`.

### 3. Start the Stack

```bash
docker compose -f docker-compose.production.yml --env-file .env.production up -d
```

This starts three services:

| Service           | Description              | Port     |
| ----------------- | ------------------------ | -------- |
| `voxium-server`   | Backend API + WebSocket  | 3001     |
| `voxium-postgres` | PostgreSQL 16            | internal |
| `voxium-redis`    | Redis 7                  | internal |

Database migrations run **automatically** on first startup — no manual steps needed.

### 4. Verify It's Running

```bash
docker compose -f docker-compose.production.yml ps
```

All services should show `healthy`. You can also check the health endpoint:

```bash
curl http://localhost:3001/health
```

### 5. Connect a Client

Point the Voxium desktop app (or web client) to your server by setting these in the client's `.env`:

```env
VITE_API_URL=http://YOUR_SERVER_IP:3001/api/v1
VITE_WS_URL=http://YOUR_SERVER_IP:3001
```

> **CORS:** The `CORS_ORIGIN` value in `.env.production` must match the URL your frontend runs on. If you're testing locally with `pnpm dev:desktop` (which serves at `http://localhost:8080`), set `CORS_ORIGIN=http://localhost:8080` in `.env.production` and restart the Docker server. Without this, the browser will block all requests.

### Managing the Docker Stack

```bash
# View server logs
docker compose -f docker-compose.production.yml logs -f server

# Stop all services
docker compose -f docker-compose.production.yml down

# Stop and remove all data (database, Redis, etc.)
docker compose -f docker-compose.production.yml down -v

# Rebuild after pulling new code
docker compose -f docker-compose.production.yml --env-file .env.production up -d --build
```

### Production Recommendations

- Put **nginx** or another reverse proxy in front for TLS/SSL termination
- Open UDP ports for the mediasoup range (`MEDIASOUP_MIN_PORT` to `MEDIASOUP_MAX_PORT`) in your firewall
- For better reliability, use a managed PostgreSQL instance (override `DATABASE_URL` directly)
- Set up regular database backups

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

## Testing

Voxium has a comprehensive test suite with 635 unit and integration tests covering API routes, middleware, utilities, voice handlers, permission system, and security edge cases.

### Running Tests

```bash
# Run all server tests (unit + integration, ~1.6s)
pnpm test

# Watch mode (re-runs on file changes)
pnpm test:watch

# Run with coverage report
pnpm --filter @voxium/server test:coverage

# Run E2E tests (requires backend + frontend + Redis running)
pnpm test:e2e               # Headless
pnpm test:e2e:ui             # Interactive UI mode
pnpm test:e2e:headed         # Visible browser
```

### Test Coverage

| Category | Tests | What's Covered |
|----------|-------|----------------|
| **Lazy Init Regression** | 44 | Prisma, S3, email, Redis, mediasoup, CORS — catches module-scope env var bugs |
| **Auth Routes** | 25 | Register, login, refresh, me, change-password, forgot-password, TOTP flow |
| **Auth Middleware** | 16 | JWT validation, HS256 algorithm pinning, token purpose rejection, email verification gate |
| **Error Handler** | 16 | Error-to-HTTP mapping, all error classes, production mode |
| **Server Routes** | 31 | CRUD, membership, permissions, feature flags, socket events |
| **Channel Routes** | 24 | CRUD, resource limits, categories, socket events |
| **Message Routes** | 26 | CRUD, IDOR prevention, sanitization, pagination, admin delete |
| **Invite Routes** | 16 | Create, join (single-use), preview, expiry, member limits |
| **DM Routes** | 18 | Conversations, messages, cascade delete, authorization |
| **Upload Routes** | 19 | S3 redirect/proxy, Express 5 wildcards, path traversal prevention |
| **Permission System** | 119 | Role CRUD, hierarchy enforcement, channel overrides, permission calculator, bitmask utilities |
| **Voice Handler** | 45 | Transport ACK on all code paths, join validation, mute/deaf/speaking, server_mute/deafen/force_move + deafen-implies-mute |
| **Auth Service** | 22 | Registration, login, tokens, password reset, email normalization |
| **TOTP Service** | 19 | Setup, enable, verify, disable, encrypt/decrypt roundtrip, backup codes |
| **Pure Utilities** | 75 | Sanitization, error classes, mentions, reactions, rate limiting |
| **Server Limits** | 10 | 3-tier resolution (server > global > hardcoded), fallthrough |
| **Feature Flags** | 6 | Defaults, overrides, unknown flags |
| **Attachment Cleanup** | 7 | 4 AM scheduling, timer lifecycle |

### Test Architecture

- **Framework:** [Vitest](https://vitest.dev/) — fast, TypeScript-native, ESM-compatible
- **HTTP Testing:** [Supertest](https://github.com/ladjs/supertest) for Express route testing without starting a server
- **Mocking:** Prisma, Redis, S3, Socket.IO, and rate limiters are mocked for isolation
- **E2E:** [Playwright](https://playwright.dev/) with Chromium against the real dev stack
- **Test location:** `apps/server/src/__tests__/` (excluded from production `tsc` and `eslint`)

---

## Scripts Reference

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start backend and frontend in parallel |
| `pnpm dev:server` | Start backend with hot reload |
| `pnpm dev:desktop` | Start frontend Vite dev server (browser at localhost:8080) |
| `pnpm dev:admin` | Start admin dashboard (browser at localhost:8082) |
| `pnpm build` | Build all packages for production |
| `pnpm build:shared` | Build shared types package |
| `pnpm build:server` | Build backend TypeScript |
| `pnpm build:desktop` | Build frontend for production |
| `pnpm typecheck` | Run TypeScript type checking across all packages |
| `pnpm lint` | Run ESLint across all packages |
| `pnpm test` | Run all server unit + integration tests |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:e2e` | Run Playwright E2E tests |
| `pnpm db:migrate` | Run Prisma migrations |
| `pnpm db:seed` | Seed database with demo data |
| `pnpm db:studio` | Open Prisma Studio |
| `npx tsx scripts/test-permissions.ts` | Run permission system integration test (73 assertions, 11 phases) |
| `npx tsx scripts/load-test-voice.ts` | Voice channel load test with real WebRTC media |

---

## License

This project is open source. See the repository for license details.
