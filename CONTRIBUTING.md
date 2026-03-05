# Contributing to Voxium

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- **Node.js** >= 20.x
- **pnpm** >= 9.x
- **PostgreSQL** >= 15.x (running locally)
- **Docker** (for Redis)
- **Rust** stable (only needed for Tauri desktop builds)

### Getting Started

```bash
# Clone and install
git clone https://github.com/your-username/Voxium.git
cd Voxium
pnpm install

# Start Redis
docker compose up -d

# Set up the database
cp apps/server/.env.example apps/server/.env
# Edit .env with your PostgreSQL password
pnpm --filter @voxium/server db:generate
pnpm --filter @voxium/server db:migrate
pnpm --filter @voxium/server db:seed    # Optional: demo data (alice/bob/charlie, password123)

# Build shared types (required before first run)
pnpm build:shared

# Start dev servers
pnpm dev:server   # Terminal 1 — backend on :3001
pnpm dev:desktop  # Terminal 2 — frontend on :8080
pnpm dev:admin    # Terminal 3 — admin dashboard on :8082 (optional)
```

### Useful Commands

```bash
pnpm typecheck          # Type-check all packages (runs as pre-commit hook)
pnpm lint               # ESLint across all packages
pnpm test:e2e           # Playwright E2E tests (requires backend + frontend running)
pnpm test:e2e:headed    # E2E tests with visible browser
pnpm db:studio          # Visual database browser
```

## Project Structure

```
Voxium/
├── apps/
│   ├── server/       # Express API + Socket.IO + WebRTC signaling
│   ├── desktop/      # React 19 + Vite + Tauri 2 desktop client
│   └── admin/        # Admin dashboard (React + Vite)
├── packages/
│   └── shared/       # Shared TypeScript types, validators, constants
└── tests/
    └── e2e/          # Playwright E2E tests
```

## Making Changes

### Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm typecheck` — this also runs as a pre-commit hook and must pass
4. Run `pnpm test:e2e` if your changes affect user-facing behavior
5. Open a PR against `main`

### Code Conventions

- **TypeScript strict mode** everywhere — no `any` unless unavoidable
- **No service layer** on the backend — routes call Prisma directly (except `authService.ts`)
- **Zustand** for all frontend state — no React context providers
- **Socket events are the source of truth** — API routes that mutate server state emit socket events; frontend stores update from those events, not from API responses
- **Sanitize user input** — all text stored in DB must pass through `sanitizeText()` before validation
- **Rate limit new endpoints** — add a named limiter in `middleware/rateLimiter.ts`
- **Type route params** — use `Request<{ serverId: string }>` not bare `Request`

### After Modifying...

| What changed | Run |
|-------------|-----|
| `packages/shared/` | `pnpm build:shared` before consuming apps see changes |
| `prisma/schema.prisma` | `cd apps/server && npx prisma migrate dev --name <name>` |
| Any TypeScript | `pnpm typecheck` (automatic via pre-commit hook) |

### Commit Messages

Keep them concise and descriptive. Use the imperative mood:

- `fix: resolve WebSocket reconnection race condition`
- `feature: add message search with jump-to-message`
- `refactor: extract reaction aggregation utility`

### What Makes a Good PR

- **Focused** — one feature or fix per PR
- **Tested** — typecheck passes, E2E tests pass if UI changed
- **No unnecessary changes** — don't refactor surrounding code, add comments to code you didn't change, or "improve" things that aren't part of the PR

## Architecture Notes

A few things that are easy to get wrong:

- **Never emit `channel:leave`** — sockets auto-subscribe to all text channels on connect for unread tracking
- **Server membership must join socket rooms** — any code that makes a user a server member must also call `joinServerRoom()` or `broadcastMemberJoined()`
- **`clearMessages()` ownership** — only `dmStore.setActiveConversation()` and `clearActiveConversation()` should call it, never UI components directly
- **WebRTC uses Perfect Negotiation** — DM voice calls use polite/impolite roles for glare resolution

See `CLAUDE.md` in the repo root for the full list of conventions and invariants.

## Reporting Issues

Use the GitHub issue templates:

- **Bug Report** — for something broken
- **Feature Request** — for new ideas

## Questions?

Open a [GitHub Discussion](../../discussions) for questions, ideas, or general conversation.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE.md).
