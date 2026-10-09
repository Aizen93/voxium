#!/bin/sh
set -e

# Node.js production memory tuning
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

# A pending one-way migration must not ride in on a restart.
#
# This script runs `migrate deploy` on EVERY container start, so once an image
# containing the always-on E2E cutover exists, any ordinary restart — OOM kill,
# host reboot, `docker compose up -d` — would apply it: all DM history deleted
# and every E2E key table truncated, outside the maintenance window, with no
# snapshot taken. The migration itself also refuses in that situation, but it
# can only refuse by FAILING, which leaves a failed-migration record that then
# blocks every later deploy until an operator resolves it. Catching it here
# means the node declines to start without touching the database at all.
CUTOVER_MIGRATION="20260801140000_e2e_always_on"
if [ "${VOXIUM_ALLOW_CUTOVER:-0}" != "1" ]; then
  # 2>&1 is load-bearing: `migrate status` reports the pending list on STDERR,
  # so discarding stderr would silently make this gate match nothing and always
  # pass — the exact failure it exists to prevent. It also exits non-zero when
  # migrations are pending, which is fine inside an `if` pipeline.
  if (cd apps/server && node ../../node_modules/prisma/build/index.js migrate status 2>&1) \
      | grep -q "$CUTOVER_MIGRATION"; then
    echo "[Voxium] FATAL: the always-on E2E cutover ($CUTOVER_MIGRATION) has not been applied."
    echo "[Voxium] It deletes all DM history and every E2E key, and there is no rollback."
    echo "[Voxium] Refusing to apply it on a restart. Run it deliberately, inside the"
    echo "[Voxium] maintenance window, per docs/e2e-always-on-plan.md 7.7 — or set"
    echo "[Voxium] VOXIUM_ALLOW_CUTOVER=1 for the one boot that is meant to perform it."
    exit 1
  fi
fi

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
