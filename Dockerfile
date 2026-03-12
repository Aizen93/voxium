# Voxium Server — Multi-stage Docker build
#
# SECURITY: This image contains NO secrets. All configuration must be
# injected at runtime via environment variables or a mounted .env file.

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# pnpm's isolated node_modules breaks CLI shim resolution in Docker.
# Hoisted layout puts all binaries at root level where they're findable.
RUN echo "node-linker=hoisted" > .npmrc

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile

# pnpm hoisted layout doesn't auto-link workspace packages
RUN mkdir -p node_modules/@voxium && \
    ln -sfn ../../packages/shared node_modules/@voxium/shared

COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/

RUN npx tsc --project packages/shared/tsconfig.json
RUN npx prisma generate --schema=apps/server/prisma/schema.prisma
RUN npx tsc --project apps/server/tsconfig.json

# ── Stage 2: Production ─────────────────────────────────────────────────────
FROM node:20-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate

RUN groupadd --gid 1001 voxium && useradd --uid 1001 --gid voxium --create-home voxium

WORKDIR /app

RUN echo "node-linker=hoisted" > .npmrc

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile --prod

RUN mkdir -p node_modules/@voxium && \
    ln -sfn ../../packages/shared node_modules/@voxium/shared

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/prisma apps/server/prisma

# Copy the generated Prisma client from the build stage instead of
# running prisma generate here (prisma CLI is a devDependency, so
# npx would download it from the network — non-deterministic and
# weakens supply-chain controls).
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
# Copy Prisma CLI + engine from build stage so migrate deploy works
# at startup without downloading anything from the network.
COPY --from=build /app/node_modules/prisma node_modules/prisma
COPY --from=build /app/node_modules/@prisma/engines node_modules/@prisma/engines

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER voxium

ENV NODE_ENV=production
EXPOSE 3001
EXPOSE 10000-10100/udp
EXPOSE 10000-10100/tcp

ENTRYPOINT ["/app/docker-entrypoint.sh"]
