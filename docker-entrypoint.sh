#!/bin/sh
set -e

echo "[Voxium] Running database migrations..."
npx prisma migrate deploy --schema=apps/server/prisma/schema.prisma

echo "[Voxium] Starting server..."
exec node apps/server/dist/index.js
