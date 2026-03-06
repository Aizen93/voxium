# Voxium Server — Multi-stage Docker build
#
# SECURITY: This image contains NO secrets. All configuration (DATABASE_URL,
# JWT_SECRET, REDIS_URL, S3 keys, SMTP credentials, etc.) must be injected
# at runtime via environment variables or a mounted .env file.
#
# Example:
#   docker run -d --env-file .env.production -p 3001:3001 voxium-server

# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:20-slim AS deps

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config + lockfile (only package.json files — no source code)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

# Install all dependencies (including devDependencies for build stage)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS build

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules

# Copy source files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/

# Generate Prisma client (only generates query engine — no DB connection needed)
RUN cd apps/server && npx prisma generate

# Build shared package
RUN pnpm build:shared

# Build server
RUN pnpm build:server

# ── Stage 3: Production (minimal image) ──────────────────────────────────────
FROM node:20-slim AS production

RUN corepack enable && corepack prepare pnpm@9 --activate

# OpenSSL required by Prisma query engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run as non-root user
RUN groupadd --gid 1001 voxium && useradd --uid 1001 --gid voxium --create-home voxium

WORKDIR /app

# Copy workspace config (needed for pnpm to resolve workspace packages)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

# Install production dependencies only (no devDependencies)
RUN pnpm install --frozen-lockfile --prod

# Copy built shared package
COPY --from=build /app/packages/shared/dist packages/shared/dist

# Copy built server + Prisma artifacts
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/prisma apps/server/prisma
COPY --from=build /app/apps/server/node_modules/.prisma apps/server/node_modules/.prisma

# Switch to non-root user
USER voxium

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "apps/server/dist/index.js"]
