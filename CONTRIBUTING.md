# Contributing to Voxium

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- **Node.js** >= 24.x (26 LTS recommended)
- **pnpm** >= 10.16 (earlier versions skip settings in `pnpm-workspace.yaml`, `minimumReleaseAge` among them)
- **PostgreSQL** >= 16.x (running locally)
- **Docker** (for Redis)
- **Rust** stable (only needed for Tauri desktop builds)

### Getting Started

```bash
# Clone and install (this also turns on the pre-commit hook, see below)
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
pnpm typecheck          # Type-check all packages (the pre-commit hook and CI run it)
pnpm lint               # ESLint across all packages
pnpm test:e2e           # Playwright E2E tests (requires backend + frontend running)
pnpm test:e2e:headed    # E2E tests with visible browser
pnpm db:studio          # Visual database browser
```

### The pre-commit hook

The repository keeps its pre-commit hook in `.githooks/pre-commit`. It runs `pnpm typecheck`, the same command CI runs on every pull request, and stops the commit when it fails: fix the errors, and never commit with `--no-verify`. It checks the files as they are in your working tree, staged or not, and needs what `pnpm typecheck` needs: the install and the Prisma client (`pnpm --filter @voxium/server db:generate`, in Getting Started above).

`pnpm install` installs it: `scripts/install-git-hooks.mjs` writes a small shim to `.git/hooks/pre-commit`, which every worktree of your clone shares, and sets no git setting. At each commit the shim runs the committed branch's own `.githooks/pre-commit` when the branch tracks it; on a branch made before the hook was kept in the repository it runs `pnpm typecheck` itself; anywhere else, nothing.

- **A `pre-commit` of your own is never replaced.** The installer replaces the file only when its text, line endings aside, is exactly a shim this project shipped. Anything else is left byte for byte as it is: a hook of your own, a shim you edited, a hook into which you pasted the shim's text. For such a file every install prints one line saying that the repository's hook does not run, except when the file begins the way a shim of a newer version does (its first line a shebang, its second the shim's marker with a higher version, as a newer branch writes it): that one is kept without a line. To switch to the repository's hook, remove or rename your file, then run `node scripts/install-git-hooks.mjs`. To keep your own hook instead, leave it in place, or put one there: that is the way to opt out.
- **With `core.hooksPath` set** (husky, a global policy), git does not read `.git/hooks`: the installer writes nothing and says so. Call `.githooks/pre-commit` from the `pre-commit` hook in that folder. When `.git/hooks` is a link to a folder outside the repository's git directory (`.git`, or `.git/modules/<name>` for a submodule), such as one several repositories share or one in your work tree, the installer writes nothing either, and says so.
- The installer does nothing when `CI` is set or outside a git work tree. After an install that skipped scripts (`--ignore-scripts`), run it yourself: `node scripts/install-git-hooks.mjs`.
- A merge or a cherry-pick that completes without a conflict runs no pre-commit hook (that is git's behaviour): run `pnpm typecheck` after one.

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

1. Fork the repo and create a branch from `develop`
2. Make your changes
3. Run `pnpm typecheck` — the pre-commit hook runs it before each commit and CI on every pull request, and it must pass
4. Run `pnpm test:e2e` if your changes affect user-facing behavior
5. Open a PR against `develop` — PRs to `main` are only accepted from `develop`
6. Fill in the pull request template, including the box that confirms the [contribution terms](#license-and-contributions)
7. If the change resolves an issue, name it with `Closes #N` in a commit message (see [Commit Messages](#commit-messages)) — the issue then closes by itself when `develop` ships to `main`

### Code Conventions

- **TypeScript strict mode** everywhere — no `any` unless unavoidable
- **No service layer** on the backend — routes call Prisma directly (except `authService.ts`)
- **Zustand** for all frontend state — no React context providers
- **Socket events are the source of truth** — API routes that mutate server state emit socket events; frontend stores update from those events, not from API responses
- **Sanitize user input** — all text stored in DB must pass through `sanitizeText()` before validation
- **Rate limit new endpoints** — add a named limiter in `middleware/rateLimiter.ts`
- **Type route params** — use `Request<{ serverId: string }>` not bare `Request`
- **No Node API in browser code** — the code of the desktop and admin apps (`src/`, outside `src/__tests__`) and of `packages/shared` is type-checked a second time without Node's types (`tsconfig.browser.json`), so `process`, `Buffer` or a `node:` import there fails `pnpm typecheck`; a timer handle is `ReturnType<typeof setTimeout>`

### After Modifying...

| What changed | Run |
|-------------|-----|
| `packages/shared/` | `pnpm build:shared` before consuming apps see changes |
| `prisma/schema.prisma` | `cd apps/server && npx prisma migrate dev --name <name>` |
| `apps/desktop/src-tauri/` (Rust or Cargo files) | `cd apps/desktop/src-tauri && cargo check --locked && cargo test --lib` — CI runs the same on Windows for every change there |
| Any TypeScript | `pnpm typecheck` (the pre-commit hook runs it before each commit, CI on every pull request) |

### Commit Messages

Keep them concise and descriptive. Use the imperative mood:

- `fix: resolve WebSocket reconnection race condition`
- `feature: add message search with jump-to-message`
- `refactor: extract reaction aggregation utility`

When the change resolves an issue, say so with a closing keyword in the body of a commit, one keyword per issue:

```
fix: resolve WebSocket reconnection race condition

Closes #123
```

GitHub accepts `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` and `resolved`, followed by `#N` (or `owner/repo#N` for an issue in another repository). Put it in a commit, not only in the pull request description: pull requests here target `develop`, and GitHub acts on a description's keywords only when the pull request targets the default branch, `main`. A commit message travels: a merge into `develop` keeps your commit messages (a squash lists every one of them in its body by default), and the issue closes when the next release merges `develop` into `main`, not when your pull request is merged. Name the issue in the description as well (`Issue: #N`), so the reviewer sees it at once.

### What Makes a Good PR

- **Focused** — one feature or fix per PR
- **Tested** — typecheck passes, E2E tests pass if UI changed
- **No unnecessary changes** — don't refactor surrounding code, add comments to code you didn't change, or "improve" things that aren't part of the PR

## Architecture Notes

A few things that are easy to get wrong:

- **Never emit `channel:leave`** — sockets auto-subscribe on connect to every channel room they can view (text and voice) for unread tracking
- **Server membership must join socket rooms** — any code that makes a user a server member goes through `joinServerMember()` (`utils/serverJoin.ts`), which broadcasts the join and seeds the read state; `joinServerRoom()` is for server creation only
- **`clearMessages()` ownership** — only `dmStore.setActiveConversation()` and `clearActiveConversation()` should call it, never UI components directly
- **WebRTC uses Perfect Negotiation** — DM voice calls use polite/impolite roles for glare resolution

The end-to-end encryption invariants are specified in `docs/e2e-dm-spec.md`; the rest are pinned by the test suites next to the code, so read the tests of the area you change before changing it.

## Reporting Issues

Use the GitHub issue templates:

- **Bug Report** — for something broken
- **Feature Request** — for new ideas

Security vulnerabilities never go in a public issue, pull request or discussion: report them privately, as described in [SECURITY.md](SECURITY.md).

## Questions?

Open a [GitHub Discussion](../../discussions) for questions, ideas, or general conversation.

## License and contributions

Voxium is source-available under the [Voxium Community License 1.0](LICENSE.md)
(see [NOTICE.md](NOTICE.md) for the license history).

By submitting a contribution, you agree that:

1. you wrote the contribution yourself (or have the right to submit it), and
2. you grant the project's copyright holder a perpetual, worldwide,
   non-exclusive, irrevocable, royalty-free license to use, reproduce,
   modify, distribute, sublicense, and relicense your contribution — under
   the Voxium Community License and under any other terms, including
   commercial licenses.

This grant is what lets the project stay under a single license and remain
sustainably funded. Your contribution is distributed to everyone else under
the Voxium Community License like the rest of the codebase. The pull
request template asks you to confirm these terms.
