# Voxium

**A free, source-available real-time communication platform built for privacy.**

> **Try it now:** [https://voxium.app](https://voxium.app)

Tired of handing over your phone number, ID, and personal data just to chat with friends? Voxium is built for people who believe privacy isn't a premium feature — it's a right. No phone verification, no identity checks, no data harvesting. Just real-time voice and text chat that works.

Self-host it, audit the code, and own your conversations. No corporation sitting between you and your community.

---

## Why Voxium?

- **Zero personal data required** — No phone number, no ID verification, no tracking
- **End-to-end encrypted** — Always-on E2E DMs, invite-only encrypted channels, and E2E-authenticated calls (Olm/Megolm double-ratchet via vodozemac); not even the server can read them
- **Fully auditable, source-available** — Read every line, self-host on your own infrastructure
- **Production-ready voice** — mediasoup SFU for servers (multi-node with crash takeover), direct P2P for DM calls (private STUN), AI noise suppression (RNNoise ML)
- **11 languages** — English, French, Spanish, Portuguese, German, Russian, Ukrainian, Korean, Chinese, Japanese, Arabic (RTL)
- **Theme engine** — 4 built-in themes, full custom theme editor with live preview, community marketplace
- **Cross-platform** — Native desktop apps for Windows, macOS, and Linux via Tauri 2
- **Modern stack** — React 19, TypeScript, Zustand, Tailwind CSS, real-time WebSockets

---

## Key Highlights

<table>
<tr>
<td width="50%">

### Advanced Permission System
Role-based access control with 22 granular permission flags, per-channel overrides (allow/deny/inherit), role hierarchy enforcement, and a permission calculator that resolves @everyone → role permissions → channel overrides. Admins manage roles, assign them to members, and configure channel-specific restrictions — all through the UI.

</td>
<td width="50%">

### Production-Ready Voice
mediasoup SFU, load-tested with 25 users per voice channel, with AI noise suppression (RNNoise ML), silence detection (70-94% bandwidth savings), push-to-talk, screen sharing with live annotations and source-composited privacy masks, and voice quality selector. DM calls use direct P2P WebRTC with Perfect Negotiation, routed through a private self-hosted STUN server (coturn) — no third-party relay.

</td>
</tr>
<tr>
<td width="50%">

### Theme Engine & Marketplace
4 built-in themes (Dark, Light, Midnight, Tactical) plus a full theme editor where users create custom themes with their own branding — colors, patterns, and CSS overrides. Live preview before applying, and a community marketplace to publish, browse, and install themes created by other users.

</td>
<td width="50%">

### 11 Languages
Fully translated interface with first-class support for English, French, Spanish, Portuguese, German, Russian, Ukrainian, Korean, Chinese, Japanese, and Arabic (with RTL layout). Language auto-detected from browser, switchable in settings. Every UI string is translated — not just labels but toasts, errors, modals, and voice indicators.

</td>
</tr>
<tr>
<td width="50%">

### Privacy-First Architecture
Zero third-party services — no Google STUN, no analytics, no CDNs. Self-hosted STUN via coturn, all media stays on your infrastructure. STUN URL derived from your server hostname — no hardcoded external endpoints. No phone number or ID required to sign up.

</td>
<td width="50%">

### Full-Stack Security
JWT with HS256 pinning, TOTP 2FA with encrypted secrets, bcrypt with 72-byte limit, timing-safe auth flows, IDOR prevention, runtime socket payload validation, rate limiting on every endpoint, email verification gate, and comprehensive input sanitization.

</td>
</tr>
<tr>
<td width="50%">

### End-to-End Encryption
All DMs are end-to-end encrypted by default — Olm/Megolm double-ratchet (vodozemac WASM), always on, with no plaintext fallback. Up to 5 devices per account with cross-signing, one safety number per account, device linking by short code, and instant revocation with re-keying. Invite-only **secure channels** bring E2E to spaces: not even the space owner or admins can read them. Encrypted attachments, encrypted key backup with a recovery key, and DM call signaling sealed in Olm envelopes so not even the relay can tamper with a call.

</td>
<td width="50%">

### Built for Multi-Node Scale
The code is multi-node capable: shared state lives in Redis, voice channels follow a node and survive a node crash, and DM calls work across nodes. Validated across nodes with the in-repo test script (`scripts/test-multi-node.ts`), including real voice media and a hard owner-crash takeover.

</td>
</tr>
</table>

---

## Features

| Category | Feature | Description |
|----------|---------|-------------|
| **Communication** | Spaces & Channels | Create spaces, organize with categories, text and voice channels, drag-and-drop reordering, single-use invite links |
| | Real-Time Messaging | Instant delivery, typing indicators, cursor-based pagination, unread badges per channel and space |
| | Message Replies | Reply with compact preview, click to scroll to original, graceful handling of deleted parents |
| | Message Editing & Deletion | Edit inline, delete with confirmation; members with Manage Messages can delete any message |
| | Reactions | Emoji reactions with grouped display and toggle support (channels and DMs) |
| | Direct Messages | 1-on-1 text with real-time delivery, typing indicators, reactions, persistent unread tracking, conversation deletion |
| | Message Search | Case-insensitive search from the header of every channel and DM conversation, with jump-to-message navigation; encrypted conversations search this device's decrypted history locally |
| | Space Discovery | Public space directory (Explore) with search, tags and transparent activity-based sorts; owners choose open joins or approval-based join requests and can hide their space from the directory |
| **Encryption** | E2E Direct Messages | Always-on end-to-end encryption for every DM (Olm/Megolm via vodozemac WASM) — no opt-in, no plaintext fallback; the server stores only ciphertext |
| | Multi-Device | Up to 5 devices per account with per-device key shares; link a new device with a short code; revoke any device and conversations re-key instantly |
| | Cross-Signing & Safety Numbers | One safety number per account, verified out-of-band; key changes surface loud warnings that must be explicitly accepted |
| | Secure Channels | Invite-only E2E-encrypted space channels — invisible and unreadable to non-members, including the space owner and admins; members are picked from the whole space directory; membership changes rotate keys, new members see no history |
| | E2E-Authenticated Calls | DM calls are P2P DTLS-SRTP with signaling sealed in Olm envelopes pinned to the peer's device — a compromised relay cannot substitute or inject call setup; plaintext signals abort the call |
| | Encrypted Attachments | DM and secure-channel attachments are encrypted client-side; the server stores opaque blobs with forced generic names |
| | Key & History Backup | Encrypted account-key backup with a recovery key, plus message-key backup so history follows the account to new devices |
| **Voice** | Server Voice (SFU) | mediasoup Selective Forwarding Unit for scalable voice (load-tested with 25 users per channel; per-channel cap configurable by admins), speaking indicators, latency display |
| | DM Voice Calls | 1-on-1 WebRTC P2P audio with Perfect Negotiation, E2E-authenticated signaling (Olm-enveloped, device-pinned), private STUN server (coturn), incoming call modal, ringtone, speaking indicators, call history as system messages |
| | Screen Sharing | Share screen in voice channels with real-time video and system audio, inline/floating viewer modes |
| | Screen Annotations & Overlays | Draw (pen/highlighter/shapes/text) and place movable image overlays (logos, promos) over a live share — rendered vector-crisp on every viewer, synced in real time, late joiners included |
| | Privacy Masks | Cover screen regions with black boxes composited into the video **on the sharer's machine** — covered pixels never leave it; masking fails closed (share pauses with a banner rather than exposing content) |
| | AI Noise Suppression | ML-powered RNNoise WASM filter removes keyboard, mouse, and background noise in real time via AudioWorklet |
| | Opus Optimization | DTX for bandwidth savings, in-band FEC for packet loss recovery, optimized bitrate |
| | Push-to-Talk | Configurable input mode with key binding picker; noise gate sensitivity slider for voice activity mode |
| | Audio Settings | Input/output device selection, live mic level meter, noise suppression toggle, persisted preferences |
| | Mute/Deaf Controls | Self mute/deaf persisted across sessions; server force-mute/deafen by moderators (persists via Redis, cannot be bypassed) |
| | Voice Moderation | Server mute/deafen (persists across reconnect via Redis), cross-channel force-move, role hierarchy enforcement |
| **Permissions** | Custom Roles | Create unlimited custom roles with names, colors, and granular permissions; role hierarchy enforcement prevents privilege escalation |
| | 22 Permission Flags | VIEW_CHANNEL, SEND_MESSAGES, MANAGE_CHANNELS, MANAGE_ROLES, KICK_MEMBERS, MUTE_MEMBERS, ATTACH_FILES, ADMINISTRATOR, and 14 more |
| | Channel Overrides | Per-channel permission overrides with allow/deny/inherit tri-state per role — restrict #announcements to read-only, hide #staff channels |
| | Permission Calculator | Layered resolution: @everyone base → OR all role permissions → channel overrides; ADMINISTRATOR bypasses everything |
| | Voice Moderation | Server mute/deafen (persists across reconnect via Redis), cross-channel force-move, role hierarchy enforcement |
| | Per-Space Nicknames | Members can set space-specific display names; admins can manage others' nicknames |
| **Social** | Friend System | Send, accept, decline, and remove friend requests with real-time notifications |
| | User Profiles | Avatars with online/offline status, display names, bios with real-time sync across all clients |
| | Presence | Real-time online/offline status for all space members and DM participants |
| **Admin** | Admin Dashboard | Two-tier admin/superadmin panel with user/space/ban management, storage management (avatars/icons/attachments with top uploaders and orphan cleanup), live metrics, audit log, moderation queue |
| | Resource Limits | Dynamic limits (max channels, voice users, categories, members, webhooks and secure channels per space) — global defaults with per-space overrides |
| | Feature Flags | Toggle registration, invites, space creation, voice, DM voice, support, space discovery and more — Redis-backed, no redeploy needed |
| | Reports & Moderation | User/message reports, admin moderation queue with resolve/dismiss/ban workflows |
| | Support Tickets | One-per-user real-time chat with staff, admin claim/close workflow, audit logging |
| **Security** | Two-Factor Auth | TOTP 2FA with authenticator app support, QR code setup, 8 backup codes, 30-day trusted device tokens |
| | Authentication | JWT with refresh tokens, remember me (desktop sessions kept in the OS credential store), forgot/reset password via email, token version-based session invalidation |
| | Rate Limiting | Per-endpoint and per-socket rate limiting, admin-editable via Redis-backed registry |
| | Anti-Bot Registration | Self-hosted proof-of-work (no captcha service — nothing leaves the platform), canonical-email dedupe (gmail dot/+tag aliases collapse to one account), daily per-IP/subnet/domain budgets, IP bans enforced at signup, per-inbox mail caps, 7-day unverified-account expiry, live abuse dashboard with spike alerts |
| | Input Sanitization | HTML stripping, validation, CORS protection |
| **Themes** | Built-in Themes | 4 built-in themes — Dark, Light, Midnight, Tactical — switchable instantly in settings |
| | Custom Theme Editor | Full visual editor: customize all colors, patterns, and CSS overrides to match your branding, judged on a scale model of the real app shell — or applied to the whole app with one click and taken back with Escape |
| | Theme Marketplace | Publish your custom themes for the community; browse, preview, and install themes created by other users |
| **Internationalization** | 11 Languages | English, French, Spanish, Portuguese, German, Russian, Ukrainian, Korean, Chinese, Japanese, Arabic (RTL) |
| | Auto-Detection | Language auto-detected from browser locale; switchable in settings; RTL layout for Arabic |
| **Platform** | File Uploads | S3-compatible storage for avatars, space icons, and message attachments with presigned URLs; attachments proxied through server (S3 URL never exposed); 3-day retention with automated daily cleanup + email report |
| | Notifications | In-app toasts, notification sounds for voice join/leave and messages, native desktop notifications |
| | Cross-Platform Desktop | Tauri 2 native apps (Windows, macOS, Linux) with polished dark UI |
| | Spaces Strip | A 64 px strip in two captioned zones: Messages (your most recent conversations as presence avatars, one click to the person) and Spaces (tabs, overflow, a dashed New space tab, Find a space and Explore). An Appearance setting folds it into a small notch under the title bar that slides out on hover, focus, Ctrl/Cmd+Shift+L or tap |
| | Multi-Node Capable | The code runs across several nodes with shared Redis state, voice channels that survive a node crash and cross-node DM calls — validated with `scripts/test-multi-node.ts` |
| | Self-Hosted STUN | Private coturn STUN server for P2P WebRTC — STUN URL derived from your server hostname (or set explicitly with `VITE_STUN_URL`), zero reliance on Google or third-party STUN/TURN services |
| | Landing Page | Public-facing page for browser visitors with animated SVG illustrations |

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Backend | Node.js, Express 5, Socket.IO 4, Prisma 7, PostgreSQL, Redis 7 |
| Frontend | React 19, TypeScript, Vite 8, Zustand 5, Tailwind CSS 4 |
| Desktop | Tauri 2 (Rust) |
| Voice | mediasoup SFU (server), WebRTC P2P (DM), RNNoise WASM, Web Audio API |
| Testing | Vitest, Supertest, Playwright (E2E) |
| Infrastructure | S3-compatible storage, Nodemailer (SMTP) |

---

## Quick Start

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | >= 24.x (26 LTS recommended) | JavaScript runtime |
| **pnpm** | >= 10.x | Package manager |
| **PostgreSQL** | >= 16.x | Database (local installation) |
| **Docker** & **Docker Compose** | Latest | Redis (and dev STUN) containers |
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

This starts Redis 7 and a self-hosted STUN server (coturn) for DM calls.

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
pnpm run dev       # backend + admin dashboard + Tauri desktop app (needs Rust; Tauri serves the web client on 8080 itself)
pnpm run dev:web   # backend + browser client only — no admin, no Rust build
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

The admin dashboard is a separate React app for managing users, spaces, bans, feature flags, resource limits, and viewing live metrics.

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

`pnpm tauri:build` builds the desktop app for **your** server. The settings below are read at build time; nothing in the repository needs editing.

```bash
cd apps/desktop
VITE_API_URL=https://chat.example.org/api/v1 \
VITE_WS_URL=https://chat.example.org \
TAURI_ASSET_ORIGIN=https://storage.example.org \
pnpm tauri:build
```

| Setting | Example | What it feeds |
|---------|---------|---------------|
| `VITE_API_URL` | `https://chat.example.org/api/v1` | **Required.** The API the app is compiled for. Its origin goes into the Content Security Policy's `connect-src` (requests) and `img-src` (avatars and icons are `<img>` loads from `/uploads/`). |
| `VITE_WS_URL` | `https://chat.example.org` | **Required.** The socket server. `connect-src` gets its origin in both forms the client uses: `https://` (polling) and `wss://` (WebSocket); `http://` gives `http://` + `ws://`. |
| `TAURI_ASSET_ORIGIN` | `https://storage.example.org` | Your object storage's origin (`https://host[:port]`, comma-separated for several). The server answers avatar and icon requests with a redirect there and uploads are sent straight to it, so it goes into `img-src` and `connect-src`. Without it, images and uploads work only if the storage answers on the API origin. |
| `TAURI_UPDATER_ENDPOINTS` | `https://updates.example.org/voxium/latest.json` | Optional, with `TAURI_UPDATER_PUBKEY`: your own update feed (`https` only, comma-separated for several; Tauri's `{{target}}` / `{{arch}}` / `{{current_version}}` placeholders work). |
| `TAURI_UPDATER_PUBKEY` | the `.pub` content `pnpm tauri signer generate` prints | Optional, with `TAURI_UPDATER_ENDPOINTS`: the public key your updates are signed with. |
| `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) | the private key from `tauri signer generate` | Needed only with your own feed: `tauri build` signs the update artifacts with it. |

The `VITE_*` values are read exactly as the frontend build reads them, through Vite (the environment first, then `apps/desktop/.env.production.local`, `.env.production`, `.env.local`, `.env`), so the policy always names the server the app talks to. The build stops with the reason when a URL is missing or malformed (no credentials, query or IPv6 literal), or when only one of the two updater settings is set.

**Content Security Policy.** Before `tauri build`, `scripts/tauri-build-config.mjs` writes an overlay to `src-tauri/target/tauri.self-hosted.json` that the Tauri CLI merges over `tauri.conf.json` (`tauri build --config`). Its `connect-src` and `img-src` name `'self'` (plus `blob:` / `data:` for images) and the origins above, nothing else: none of the Voxium project's own hosts, and no localhost unless your URLs point there. Every other directive stays as `tauri.conf.json` has it. To check it before building, run `node scripts/tauri-build-config.mjs`, which prints the overlay.

**Updater.** Without `TAURI_UPDATER_ENDPOINTS` / `TAURI_UPDATER_PUBKEY` the build has no updater: no update artifacts are produced, no signing key is asked for, and the app never checks for updates. To ship updates to your users, generate a key pair once (`pnpm tauri signer generate -w ~/.tauri/voxium.key`), keep the private key out of the repository, set the three settings above, and publish each release's `latest.json` and signed artifacts at your feed. When your feed announces a newer version, the app shows a mandatory "Update Required" dialog.

**Do not reuse the project's feed or key.** `tauri.conf.json` holds the official release's settings: the Voxium project's domains in the policy, its update feed (`https://github.com/Aizen93/voxium/releases/…`) and its public key. With that key no update you sign could ever install, and a build pointed at that feed would show your users a mandatory update at every upstream release, which then fails (with your own key, an update the project signed cannot install). `pnpm tauri:build` refuses the project's key, and refuses its feed as written in `tauri.conf.json`: that check only catches a value copied by accident, and another spelling of the same URL passes it, so do not rely on it. Do not build with a plain `pnpm tauri build` or `scripts/tauri-release-config.mjs` either: they produce the official configuration, with the project's hosts, feed and key. Without the project's private key, `tauri build` reports the missing `TAURI_SIGNING_PRIVATE_KEY` only after it has written the installers, and `--no-sign` skips that check altogether, so those installers exist and carry the project's feed, key and hosts. `pnpm tauri:build` is the supported way to build for your server. In a CI of your own, write the overlay with `node scripts/tauri-build-config.mjs --out <file>` and pass `--config <file>` to `tauri build`.

**A build for your server keeps its own data.** `pnpm tauri:build` gives the app an identifier of its own, `com.voxium.selfhosted.` followed by a digest of the origin of `VITE_API_URL`, so the same server gets the same identifier on every rebuild. The identifier names the app's data folders and its entries in the OS credential store: your build keeps its own sessions, end-to-end encryption vault and settings, separate from the official app's and from the builds made for other servers. Each stored session (and the two-factor "trusted device" token) also carries the address of the server that issued it, and a build only ever uses the ones of its own server.

- **On Windows**, your build installs in place of the official app (or the official app in place of yours), because the product name is the same: one entry in the installed apps, one install folder. Each keeps its own data: reinstalling the official app finds its session and vault where they were, unless the uninstaller's option to delete the app data was ticked.
- **Users of a desktop build you made before this change** start on a fresh profile once they update to a build made with it: they sign in again, and restore their message history with their recovery key.
- **Desktop notifications on Windows:** Windows shows an installed app's notifications only when its Start Menu shortcut carries the app's identifier. The installer writes the identifier on the shortcuts it creates and on the ones that already point at the app, so installing your build over the official app, the official app over your build, or updating in place a build made before this change, keeps its notifications.
- **What stays shared by design:** builds with the official identifier, the official app and `pnpm tauri:dev`, share one store; there the server address stamped on each session keeps one server's session from another's, and that check is made by the app, not by the operating system.

`pnpm tauri:dev` is not affected: the development build loads the Vite dev server directly, and Tauri adds its Content Security Policy only to the pages it serves itself, so no policy applies there and it reaches `localhost:3001` as before.

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
# Required: the server refuses to start in production without it
TOTP_ENCRYPTION_KEY=your_32_byte_hex_key

# ── S3 / Object Storage (required for file uploads) ──────────────────────────
S3_ASSETS_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_ASSETS_REGION=us-east-1
S3_ACCESS_KEY=your_access_key
S3_SECRET_KEY=your_secret_key
S3_ASSETS_BUCKET=your-bucket-name

# ── SMTP (required: email verification and password reset) ──────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
SMTP_FROM=noreply@yourdomain.com

# ── App ───────────────────────────────────────────────────────────────────────
PORT=3001
# CORS_ORIGIN must match the URL where your frontend is hosted.
# For local testing with the dev frontend, use: http://localhost:8080
# Add the Tauri desktop origins so the native apps can connect too:
# https://tauri.localhost (Windows), tauri://localhost (macOS), http://tauri.localhost (Linux)
CORS_ORIGIN=https://yourdomain.com,https://tauri.localhost,tauri://localhost,http://tauri.localhost
# The object-storage BUCKET needs the same origins in its own CORS rules (methods GET, PUT, HEAD;
# headers *): avatars, space icons and attachments are uploaded straight from the client to a
# presigned URL, and a bucket that allows only the web origin fails the desktop app's uploads
# with "Failed to fetch" while the images still display. scripts/setup-dev-bucket.ts shows the rule.
CLIENT_URL=https://yourdomain.com
# Set to true when running behind a reverse proxy (nginx etc.)
TRUST_PROXY=true

# ── mediasoup (Voice) ────────────────────────────────────────────────────────
# ANNOUNCED_IP must be your server's public IP for voice to work
# One WebRtcServer per worker (one worker per CPU core, max 8) on MIN_PORT + slot,
# udp+tcp — MIN..MIN+7 covers any host, and the compose file publishes exactly this range
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=YOUR_SERVER_PUBLIC_IP
MEDIASOUP_MIN_PORT=10000
MEDIASOUP_MAX_PORT=10007
```

See `.env.production.example` for the full list of options (S3 encryption, proxy hops, logging).

> **Important:** `MEDIASOUP_ANNOUNCED_IP` must be your server's public IP address. Voice channels will not work without this.

> **Windows users:** If ports 10000-10007 conflict with Hyper-V reserved ranges, use a different range like `20000-20007`.

### 3. Start the Stack

```bash
docker compose -f docker-compose.production.yml --env-file .env.production up -d
```

This starts three services:

| Service           | Description              | Port     |
| ----------------- | ------------------------ | -------- |
| `voxium-server`   | Backend API + WebSocket  | 3001, plus the mediasoup range (UDP + TCP) |
| `voxium-postgres` | PostgreSQL 16            | internal |
| `voxium-redis`    | Redis 7                  | internal |

Database migrations run **automatically** on every container start (`migrate deploy`) — no manual steps needed. On a new, empty database the first start applies all of them. Unless `VOXIUM_ALLOW_CUTOVER=1` is set (below), the container first reads `prisma migrate status` until the database answers (10 attempts, 3 s apart, each failed read logged with its error) and does not migrate a database it could not read: if PostgreSQL stays unreachable, the server container exits and its log shows the last error.

> **`VOXIUM_ALLOW_CUTOVER`:** one migration, the always-on E2E cutover (`20260801140000_e2e_always_on`), deletes all DM history and every E2E key, and there is no rollback. When a database that already holds an install (migrations applied before) still has it pending, the container refuses to start instead of applying it on an ordinary restart. Apply it deliberately, after a snapshot and inside a maintenance window, following `docs/e2e-always-on-plan.md` §7.7. On a database that holds DMs or E2E keys, setting `VOXIUM_ALLOW_CUTOVER=1` for that one start is not enough on its own: the migration also requires the authorisation that procedure describes (the `e2e_cutover_authorised` table), and without it the migration refuses and leaves a failed-migration record (P3009 naming the cutover), which is marked rolled back, never cleared by recreating the database. Remove the variable afterwards. A new, empty database never needs it. A first start that was interrupted part-way, or a second replica starting while the first one migrates, leaves a database that is no longer empty and reads as an existing one: the refusal message says how to go on when that database never served users.

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

The desktop installers are then built with `pnpm tauri:build`, which also takes your object storage's origin and, optionally, your own update feed: see [Build the Desktop App](#build-the-desktop-app).

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
- Open the mediasoup range (`MEDIASOUP_MIN_PORT` to `MEDIASOUP_MAX_PORT`) in your firewall — UDP, plus TCP as a fallback
- For better reliability, use a managed PostgreSQL instance (change `DATABASE_URL` in `docker-compose.production.yml` — its `environment:` entry takes precedence over `.env.production`)
- Set up regular database backups

---

## Database Management

```bash
# Open Prisma Studio (visual database browser)
pnpm run db:studio

# Create a new migration (Prisma 7 must run from apps/server)
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

> **Note:** usernames are kept case-insensitively unique by a functional index Prisma cannot express, so `prisma migrate dev` reports it as drift and may offer to reset the database or drop it. Do not accept — keep the index.

> **No update check:** the Prisma CLI reports to `checkpoint.prisma.io` on every run unless `CHECKPOINT_DISABLE` is set. `apps/server/prisma.config.ts` sets it, so every Prisma command run from `apps/server` (the ones above, CI, the Docker entrypoint) skips the check, and the Docker image sets it for both of its stages.

---

## Testing the API

### Health Check
```bash
curl http://localhost:3001/health
```

### Register a User

Registration cannot be done with a single `curl`: `POST /api/v1/auth/register` requires a solved proof-of-work (`GET /api/v1/auth/register-challenge`, solved with `solveRegistrationPow` from `@voxium/shared`) and explicit `acceptTerms: true` / `acceptPrivacy: true` consent, and it creates no account: it answers `202` with a `pendingId`, and the account is created by `POST /api/v1/auth/register/complete` with the 6-digit code mailed to the address. Register through the app, or log in with a seeded demo account as below.

### Login
```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"password123"}'
```

### Use the Token
```bash
# Replace <TOKEN> with data.accessToken from the login response
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
| `JWT_REFRESH_EXPIRES_IN` | `30d` | Refresh token expiry for "remember me" sessions (otherwise 24h); `.env.example` sets `7d` |
| `PORT` | `3001` | HTTP server port |
| `NODE_ENV` | `development` | Environment mode |
| `CORS_ORIGIN` | `http://localhost:8080` | Allowed CORS origin(s) |
| `S3_ASSETS_ENDPOINT` | — | S3-compatible storage endpoint |
| `S3_ASSETS_REGION` | — | S3 bucket region |
| `S3_ACCESS_KEY` | — | S3 access key |
| `S3_SECRET_KEY` | — | S3 secret key |
| `S3_ASSETS_BUCKET` | — | S3 bucket name |
| `S3_SSE` | — | Optional bucket-default encryption at rest: `AES256` or `aws:kms` |
| `SMTP_HOST` | `localhost` | SMTP server host |
| `SMTP_PORT` | `1025` | SMTP server port |
| `SMTP_USER` | — | SMTP auth username |
| `SMTP_PASS` | — | SMTP auth password |
| `SMTP_FROM` | `noreply@voxium.app` | Sender email address |
| `CLIENT_URL` | `http://localhost:8080` | Frontend URL (used in emails) |
| `CLEANUP_REPORT_EMAIL` | — | Email address for daily attachment cleanup reports. If not set, no report is sent. |
| `TOTP_ENCRYPTION_KEY` | — | 32-byte hex key for encrypting TOTP secrets at rest. Generate with `openssl rand -hex 32`. **Required in production** (the server refuses to start without it); in development it is optional and TOTP secrets are stored unencrypted with a warning. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers (always on when `NODE_ENV=production`) |
| `TRUST_PROXY_HOPS` | `1` | Number of reverse proxies in front of the server — must match your setup exactly |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | IP the mediasoup workers bind to |
| `MEDIASOUP_ANNOUNCED_IP` | `127.0.0.1` | IP address announced to WebRTC clients for mediasoup SFU connectivity. Set it to the machine's LAN IP for cross-machine voice in development, and its public IP in production. The Vite dev servers listen on localhost only; start them with `VOXIUM_DEV_LAN=1` to reach them from another machine. |
| `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` | `10000` / `59999` | mediasoup port range. Each worker (one per CPU core, max 8) binds one UDP + TCP port at `MIN_PORT + slot`, so only the first few ports are used |

### Frontend Environment Variables (`apps/desktop/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001/api/v1` | Backend API base URL |
| `VITE_WS_URL` | `http://localhost:3001` | WebSocket server URL |
| `VITE_STUN_URL` | `stun:<VITE_WS_URL host>:3478` | Optional STUN server for DM calls (`stun:`/`stuns:` only). Compiled into the build. |

The desktop installer build (`pnpm tauri:build`) requires `VITE_API_URL` and `VITE_WS_URL`, and also reads `TAURI_ASSET_ORIGIN`, `TAURI_UPDATER_ENDPOINTS` and `TAURI_UPDATER_PUBKEY` from the environment: see [Build the Desktop App](#build-the-desktop-app).

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

Voxium has three Vitest suites — over 4,200 server, 3,100 desktop and 140 admin unit and integration tests as of 2026-11-13 — plus a Playwright E2E suite.

### Running Tests

```bash
# Run all unit + integration tests (server, then desktop, then admin)
pnpm test

# Server suite in watch mode (re-runs on file changes)
pnpm test:watch

# Run with coverage report
pnpm --filter @voxium/server test:coverage

# Run E2E tests (Playwright starts the backend, desktop and admin apps itself,
# or reuses ones already running on 3001/8080/8082; needs PostgreSQL + Redis,
# plus an SMTP catcher on :1025 for the email-verification specs — e.g.
# docker run -p 1025:1025 axllent/mailpit — and a working S3 bucket for the
# encrypted-attachment upload in e2e-encryption.spec.ts)
pnpm test:e2e               # Headless
pnpm test:e2e:ui             # Interactive UI mode
pnpm test:e2e:headed         # Visible browser

# Cross-engine proof for encrypted voice (Gecko's RTCRtpScriptTransform path)
npx playwright test secure-voice --config=playwright-firefox.config.ts

# What CI gates on: everything except specs tagged @quarantine
npx playwright test --grep-invert @quarantine
```

E2E runs on every pull request and blocks merging. The job provisions
PostgreSQL, Redis, Mailpit and MinIO, applies migrations, and runs the suite on
Chromium plus the encrypted-voice spec on Firefox. A spec tagged `@quarantine`
still runs, but in a non-blocking step, with a note in the spec saying why it is
tagged; no spec is tagged at the moment.

### Test Coverage

- **Server** (`apps/server/src/__tests__/`) — API routes, middleware (auth, rate limiting, consent and email-verification gates), services (auth, TOTP), the permission system, voice and DM-voice socket handlers (including multi-node relay and secure voice), screen-share annotations, E2E key and secure-channel endpoints, registration abuse defenses, server discovery, scheduled cleanup jobs, migrations, and lazy-init regressions
- **Desktop** (`apps/desktop/src/__tests__/`) — Zustand stores (voice, chat, DM, E2E, annotations, discovery), the socket service, E2E crypto (DMs, secure channels, calls, key backup, the plaintext display gate), hooks, components, i18n key parity across all 11 locales, themes, and SEO/licence guards
- **Admin** (`apps/admin/src/__tests__/`) — admin dashboard components and store

### Test Architecture

- **Framework:** [Vitest](https://vitest.dev/) — fast, TypeScript-native, ESM-compatible
- **HTTP Testing:** [Supertest](https://github.com/ladjs/supertest) for Express route testing without starting a server
- **Mocking:** Prisma, Redis, S3, Socket.IO, and rate limiters are mocked for isolation
- **E2E:** [Playwright](https://playwright.dev/) with Chromium (plus Firefox for encrypted voice) against the real dev stack, in `tests/e2e/`
- **Test location:** `apps/server/src/__tests__/`, `apps/desktop/src/__tests__/` and `apps/admin/src/__tests__/` (server tests are excluded from the production `tsc` build and from ESLint)

---

## Scripts Reference

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start backend, admin dashboard and Tauri desktop app (which serves the web client on 8080) |
| `pnpm dev:web` | Start backend and browser client only (no admin, no Rust build) |
| `pnpm dev:server` | Start backend with hot reload |
| `pnpm dev:desktop` | Start frontend Vite dev server (browser at localhost:8080) |
| `pnpm dev:admin` | Start admin dashboard (browser at localhost:8082) |
| `pnpm build` | Build shared, server and desktop packages for production |
| `pnpm build:shared` | Build shared types package |
| `pnpm build:server` | Build backend TypeScript |
| `pnpm build:desktop` | Build frontend for production |
| `pnpm build:admin` | Build admin dashboard for production |
| `pnpm typecheck` | Run TypeScript type checking across all packages |
| `pnpm lint` | Run ESLint across all packages |
| `pnpm test` | Run all unit + integration tests (server, desktop and admin suites) |
| `pnpm test:watch` | Run server tests in watch mode |
| `pnpm test:e2e` | Run Playwright E2E tests (`test:e2e:ui` / `test:e2e:headed` for UI mode / visible browser) |
| `pnpm db:migrate` | Run Prisma migrations |
| `pnpm db:seed` | Seed database with demo data |
| `pnpm db:studio` | Open Prisma Studio |
| `npx tsx scripts/test-permissions.ts` | Run permission system integration test against a running backend (11 phases) |
| `npx tsx scripts/test-multi-node.ts` | Spawn two server nodes and validate cross-node behavior, including real voice media and owner-crash takeover |
| `npx tsx scripts/load-test-voice.ts` | Voice channel load test with real WebRTC media |
| `KEYSHARE_INBOX_CHECK=1 DATABASE_URL=<url> npx tsx scripts/check-keyshare-inbox.ts` | Check the key-share lease and acknowledgement statements on the migrated database `DATABASE_URL` names (the script reads no `.env`; build the shared package first), two-session races included (writes and then deletes rows of its own only); CI runs it in the e2e job |

---

## License

Voxium is **source-available** under the [Voxium Community License 1.0](LICENSE.md).

In short: run it, read it, audit it, modify it, share it — for yourself, your
community, or internally in your organization. Access to any instance must
stay free for its users: no paywalls, no gated features, no ads, no selling
of user data. Commercial exploitation (selling access, hosted/managed
offerings, bundling into paid products) is reserved to the project.
Individuals and nonprofits may accept voluntary donations as long as nothing
is gated behind them. If you deploy a modified version for people outside
your organization, publish your changes.

Releases up to `v1.7.3` were AGPL-3.0 and remain so — see
[NOTICE.md](NOTICE.md) for the full history, and [TRADEMARK.md](TRADEMARK.md)
for use of the Voxium name.
