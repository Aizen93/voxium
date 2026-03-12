#!/bin/sh
set -e

echo "[Voxium] Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy --schema=apps/server/prisma/schema.prisma

echo "[Voxium] Starting server..."
exec node apps/server/dist/index.js
