#!/bin/sh
set -e

echo "[Voxium] Running database migrations..."

# Retry migrations up to 10 times (DB may not be ready immediately)
ATTEMPT=1
MAX_ATTEMPTS=10
until [ $ATTEMPT -gt $MAX_ATTEMPTS ]; do
  if cd apps/server && node ../../node_modules/prisma/build/index.js migrate deploy; then
    cd ../..
    echo "[Voxium] Migrations complete."
    break
  fi
  cd ../..
  echo "[Voxium] Migration attempt $ATTEMPT/$MAX_ATTEMPTS failed, retrying in 3s..."
  ATTEMPT=$((ATTEMPT + 1))
  sleep 3
done

if [ $ATTEMPT -gt $MAX_ATTEMPTS ]; then
  echo "[Voxium] FATAL: Migrations failed after $MAX_ATTEMPTS attempts."
  exit 1
fi

echo "[Voxium] Starting server..."
exec node apps/server/dist/index.js
