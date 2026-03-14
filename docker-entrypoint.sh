#!/bin/sh
set -e

echo "[Voxium] Running database migrations..."
cd apps/server && node ../../node_modules/prisma/build/index.js migrate deploy && cd ../..

echo "[Voxium] Starting server..."
exec node apps/server/dist/index.js
