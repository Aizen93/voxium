#!/bin/sh
set -e

# Node.js production memory tuning
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

# The Prisma CLI reports to checkpoint.prisma.io (its update check) on every
# run unless this is set, and Voxium uses no third-party service. The image
# (Dockerfile ENV) and apps/server/prisma.config.ts set it as well.
export CHECKPOINT_DISABLE=1

# Every Prisma CLI run starts from apps/server, where prisma.config.ts lives.
prisma_cli() {
  (cd apps/server && node ../../node_modules/prisma/build/index.js "$@")
}

MAX_ATTEMPTS=10
RETRY_DELAY_SECONDS=3

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
#
# The gate refuses an EXISTING database only: one where migrations have been
# applied (the oldest one is no longer pending) and the cutover has not. A new
# database, where no migration was ever applied, or one that does not exist
# yet (`migrate deploy` creates it), holds nothing to lose, and the
# migration's own SQL gate lets it through: a first start migrates it with no
# override. A database that has tables but no migration history reads the
# same way here; `migrate deploy` refuses it (P3005) before writing anything.
#
# It decides only on a status that reached the database. `migrate status`
# exits non-zero both when migrations are pending and when it cannot connect,
# and an error names no migration, so an unreachable database once made this
# gate match nothing and pass, and the deploy that followed met the cutover
# on an existing database. A status counts as read when it carries no error
# and reports the migrations it compared ("N migrations found in
# prisma/migrations", printed once the database answered); a missing database
# (P1003) is the one error that is an answer. Anything else is read again,
# and after the last attempt the container exits without `migrate deploy`.
#
# A FAILED cutover record does not show in Prisma 7.10's `migrate status` at all
# (the output equals the applied one); `migrate deploy` itself stops on it
# (P3009) before applying anything.
CUTOVER_MIGRATION="20260801140000_e2e_always_on"

# Prints what the last `migrate status` output ($STATUS) says:
#   unreadable  the status did not reach the database
#   empty       nothing applied yet, or no database yet: nothing to lose
#   existing    an existing database with the cutover pending
#   applied     the cutover is not pending
status_state() {
  STATUS_LINES=$(printf '%s\n' "$STATUS" | tr -d '\r')
  if printf '%s\n' "$STATUS_LINES" | grep -q '^Error: P1003'; then
    echo empty
  elif printf '%s\n' "$STATUS_LINES" | grep -q '^Error'; then
    echo unreadable
  elif ! printf '%s\n' "$STATUS_LINES" | grep -q '^[0-9][0-9]* migrations\{0,1\} found in '; then
    echo unreadable
  elif ! listed_as_pending "$CUTOVER_MIGRATION"; then
    echo applied
  elif listed_as_pending "$FIRST_MIGRATION"; then
    echo empty
  else
    echo existing
  fi
}

# The pending list prints one migration name per line.
listed_as_pending() {
  printf '%s\n' "$STATUS_LINES" | grep -qx "[[:space:]]*$1[[:space:]]*"
}

if [ "${VOXIUM_ALLOW_CUTOVER:-0}" != "1" ]; then
  # The oldest migration: still pending only where nothing was ever applied.
  FIRST_MIGRATION=""
  for dir in apps/server/prisma/migrations/*/; do
    if [ -f "${dir}migration.sql" ]; then
      FIRST_MIGRATION=$(basename "$dir")
      break
    fi
  done
  if [ -z "$FIRST_MIGRATION" ]; then
    echo "[Voxium] FATAL: no migration found in apps/server/prisma/migrations."
    exit 1
  fi

  ATTEMPT=1
  while :; do
    # 2>&1 is load-bearing: `migrate status` reports the pending list on
    # STDERR, so discarding stderr would leave nothing to decide on. `|| true`
    # because it exits non-zero whenever anything is pending, which `set -e`
    # would otherwise take for a failure of this script.
    STATUS=$(prisma_cli migrate status 2>&1) || true
    STATE=$(status_state)
    if [ "$STATE" != "unreadable" ] || [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
      break
    fi
    echo "[Voxium] Could not read the migration status (attempt $ATTEMPT/$MAX_ATTEMPTS), retrying in ${RETRY_DELAY_SECONDS}s..."
    ATTEMPT=$((ATTEMPT + 1))
    sleep "$RETRY_DELAY_SECONDS"
  done

  case "$STATE" in
    unreadable)
      printf '%s\n' "$STATUS"
      echo "[Voxium] FATAL: could not read the migration status after $MAX_ATTEMPTS attempts."
      echo "[Voxium] Not migrating a database whose state is unknown. Check DATABASE_URL and that the database accepts connections."
      exit 1
      ;;
    existing)
      echo "[Voxium] FATAL: the always-on E2E cutover ($CUTOVER_MIGRATION) has not been applied."
      echo "[Voxium] It deletes all DM history and every E2E key, and there is no rollback."
      echo "[Voxium] Refusing to apply it on a restart. Run it deliberately, inside the"
      echo "[Voxium] maintenance window, per docs/e2e-always-on-plan.md 7.7 — or set"
      echo "[Voxium] VOXIUM_ALLOW_CUTOVER=1 for the one boot that is meant to perform it."
      exit 1
      ;;
    empty)
      echo "[Voxium] New database: every migration will be applied."
      ;;
  esac
fi

echo "[Voxium] Running database migrations..."

# Retry migrations up to 10 times (a transient connection loss, a slow start)
ATTEMPT=1
until [ $ATTEMPT -gt $MAX_ATTEMPTS ]; do
  if prisma_cli migrate deploy; then
    echo "[Voxium] Migrations complete."
    break
  fi
  echo "[Voxium] Migration attempt $ATTEMPT/$MAX_ATTEMPTS failed, retrying in ${RETRY_DELAY_SECONDS}s..."
  ATTEMPT=$((ATTEMPT + 1))
  sleep "$RETRY_DELAY_SECONDS"
done

if [ $ATTEMPT -gt $MAX_ATTEMPTS ]; then
  echo "[Voxium] FATAL: Migrations failed after $MAX_ATTEMPTS attempts."
  exit 1
fi

echo "[Voxium] Starting server..."
exec node apps/server/dist/index.js
