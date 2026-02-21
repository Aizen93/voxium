# Voxium - Setup Guide

## Prerequisites

Ensure you have the following installed on your system:

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | >= 20.x | JavaScript runtime |
| **pnpm** | >= 9.x | Package manager |
| **PostgreSQL** | >= 15.x | Database (local installation) |
| **Docker** & **Docker Compose** | Latest | Redis container |
| **Rust** | Latest stable | Required by Tauri for desktop builds |
| **Git** | Latest | Version control |

### Platform-Specific Requirements

**Windows:**
- Microsoft Visual Studio C++ Build Tools
- WebView2 (included in Windows 11, install manually on Windows 10)

**macOS:**
- Xcode Command Line Tools: `xcode-select --install`
- CLang and macOS development dependencies

**Linux (Debian/Ubuntu):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Install pnpm (if not installed)
```bash
npm install -g pnpm
```

### Install Rust (if not installed)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

---

## Quick Start

### 1. Clone the Repository
```bash
git clone <repository-url>
cd Voxium
```

### 2. Install Dependencies
```bash
pnpm install
```

### 3. Set Up PostgreSQL (local)

Voxium uses your locally installed PostgreSQL server. Create the database:

```bash
psql -U postgres -c "CREATE DATABASE voxium;"
```

### 4. Start Redis (Docker)
```bash
docker compose up -d
```

This starts:
- **Redis** on `localhost:6379`

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

**Option B: Start individually (recommended for development)**

Terminal 1 — Backend:
```bash
pnpm run dev:server
```

Terminal 2 — Frontend:
```bash
pnpm run dev:desktop
```

The backend runs on `http://localhost:3001` and the frontend on `http://localhost:1420`.

---

## Running as Desktop App (Tauri)

To run the native desktop application:

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

### Open Prisma Studio (visual database browser)
```bash
pnpm run db:studio
```

### Create a New Migration
```bash
cd apps/server
npx prisma migrate dev --name your_migration_name
```

### Reset Database (deletes all data)
```bash
cd apps/server
npx prisma migrate reset
```

### Seed Demo Data
```bash
pnpm run db:seed
```

Creates:
- **Users:** `alice`, `bob`, `charlie` (password: `password123` for all)
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
| `DATABASE_URL` | `postgresql://postgres:YOUR_PASSWORD@localhost:5432/voxium` | PostgreSQL connection string (use your local password) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_SECRET` | — | **Required.** Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | — | **Required.** Secret for signing refresh tokens |
| `JWT_EXPIRES_IN` | `15m` | Access token expiry |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token expiry |
| `PORT` | `3001` | HTTP server port |
| `NODE_ENV` | `development` | Environment (`development` / `production`) |
| `CORS_ORIGIN` | `http://localhost:1420` | Allowed CORS origin |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | WebRTC listening IP |
| `MEDIASOUP_ANNOUNCED_IP` | `127.0.0.1` | WebRTC public IP |

### Frontend Environment Variables (`apps/desktop/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001/api/v1` | Backend API base URL |
| `VITE_WS_URL` | `http://localhost:3001` | WebSocket server URL |

---

## Troubleshooting

### "Cannot find module '@voxium/shared'"
Build the shared package first:
```bash
pnpm run build:shared
```

### Database connection refused
Make sure your local PostgreSQL is running and the `voxium` database exists:
```bash
psql -U postgres -c "SELECT 1;"
psql -U postgres -c "CREATE DATABASE voxium;"
```

Make sure Redis is running:
```bash
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
Ensure Rust is installed and up to date:
```bash
rustup update
```

On Linux, ensure all system dependencies are installed (see Prerequisites).

### WebSocket connection fails
Check that:
1. The backend server is running
2. `CORS_ORIGIN` matches the frontend URL
3. The `VITE_WS_URL` points to the correct backend

---

## Project Scripts Reference

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start backend and frontend in parallel |
| `pnpm dev:server` | Start backend in dev mode (with hot reload) |
| `pnpm dev:desktop` | Start frontend Vite dev server |
| `pnpm build` | Build all packages for production |
| `pnpm build:shared` | Build shared types package |
| `pnpm build:server` | Build backend TypeScript |
| `pnpm build:desktop` | Build frontend for production |
| `pnpm db:migrate` | Run Prisma migrations |
| `pnpm db:seed` | Seed database with demo data |
| `pnpm db:studio` | Open Prisma Studio |
