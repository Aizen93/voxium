#!/bin/sh
set -e

# Node.js production memory tuning
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

# The Prisma CLI reports to checkpoint.prisma.io (its update check) on every
# run unless this is set, and Voxium uses no third-party service. The image
# (Dockerfile ENV) and apps/server/prisma.config.ts set it as well.
export CHECKPOINT_DISABLE=1

# Every Prisma CLI run starts from apps/server, where prisma.config.ts lives,
# and prints no colour: with FORCE_COLOR set it wraps "Error:" in ANSI codes,
# which the status checks below would not recognise (NO_COLOR wins over it).
prisma_cli() {
  (unset FORCE_COLOR; NO_COLOR=1; export NO_COLOR; cd apps/server && node ../../node_modules/prisma/build/index.js "$@")
}

# The escape character, to strip any colour a status still carries.
ESC=$(printf '\033')

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
# applied (fewer are pending than were found) and the cutover has not. A new
# database, where no migration was ever applied, or one that does not exist
# yet (`migrate deploy` creates it), holds nothing to lose, and the
# migration's own SQL gate lets it through: a first start migrates it with no
# override. A database that has tables but no migration recorded reads the
# same way here, and nothing it holds is touched either: without a
# `_prisma_migrations` table `migrate deploy` refuses it (P3005) before
# writing anything; with that table present but its rows deleted, the first
# migration fails on a table that exists (42P07) and leaves a failed-migration
# record to resolve.
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

# Prints what the last `migrate status` output ($STATUS_LINES) says:
#   unreadable  the status did not reach the database
#   missing     the database does not exist yet
#   empty       no migration recorded: every migration is pending
#   existing    an existing database with the cutover pending
#   applied     the cutover is not pending
status_state() {
  if printf '%s\n' "$STATUS_LINES" | grep -q '^Error: P1003'; then
    echo missing
  elif printf '%s\n' "$STATUS_LINES" | grep -q '^Error'; then
    echo unreadable
  elif ! printf '%s\n' "$STATUS_LINES" | grep -q '^[0-9][0-9]* migrations\{0,1\} found in '; then
    echo unreadable
  elif ! listed_as_pending "$CUTOVER_MIGRATION"; then
    echo applied
  elif [ "$(pending_count)" -eq "$(found_count)" ]; then
    # Every migration pending, not merely the oldest: a migration ever added
    # with an earlier date would be pending on every existing database.
    echo empty
  else
    echo existing
  fi
}

# The pending list prints one migration name per line.
listed_as_pending() {
  printf '%s\n' "$STATUS_LINES" | grep -qx "[[:space:]]*$1[[:space:]]*"
}

# How many of this image's migrations the status lists as pending.
pending_count() {
  count=0
  for dir in apps/server/prisma/migrations/*/; do
    if [ -f "${dir}migration.sql" ] && listed_as_pending "$(basename "$dir")"; then
      count=$((count + 1))
    fi
  done
  echo "$count"
}

# Why the last status did not count, for the retry log: its first error line.
status_reason() {
  reason=$(printf '%s\n' "$STATUS_LINES" | sed -n '/^Error/{p;q;}')
  if [ -n "$reason" ]; then
    printf '%s\n' "$reason" | redact_urls
  elif [ -z "$(printf '%s' "$STATUS_LINES" | tr -d '[:space:]')" ]; then
    echo "no output"
  else
    echo "no migration count in the output"
  fi
}

# A connection string carries the password: no URL is ever printed.
redact_urls() {
  sed 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]*#<redacted URL>#g'
}

# N in "N migrations found in prisma/migrations".
found_count() {
  printf '%s\n' "$STATUS_LINES" | sed -n 's/^\([0-9][0-9]*\) migrations\{0,1\} found in .*/\1/p' | head -n 1
}

if [ "${VOXIUM_ALLOW_CUTOVER:-0}" != "1" ]; then
  ATTEMPT=1
  while :; do
    # 2>&1 is load-bearing: `migrate status` reports the pending list on
    # STDERR, so discarding stderr would leave nothing to decide on. `|| true`
    # because it exits non-zero whenever anything is pending, which `set -e`
    # would otherwise take for a failure of this script.
    STATUS=$(prisma_cli migrate status 2>&1) || true
    STATUS_LINES=$(printf '%s\n' "$STATUS" | tr -d '\r' | sed "s/${ESC}\[[0-9;]*m//g")
    STATE=$(status_state)
    if [ "$STATE" != "unreadable" ] || [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
      break
    fi
    echo "[Voxium] Could not read the migration status (attempt $ATTEMPT/$MAX_ATTEMPTS): $(status_reason). Retrying in ${RETRY_DELAY_SECONDS}s..."
    ATTEMPT=$((ATTEMPT + 1))
    sleep "$RETRY_DELAY_SECONDS"
  done

  case "$STATE" in
    unreadable)
      printf '%s\n' "$STATUS_LINES" | redact_urls
      echo "[Voxium] FATAL: could not read the migration status after $MAX_ATTEMPTS attempts ($(status_reason))."
      echo "[Voxium] Not migrating a database whose state is unknown. Check DATABASE_URL and that the database accepts connections."
      exit 1
      ;;
    existing)
      echo "[Voxium] FATAL: the always-on E2E cutover ($CUTOVER_MIGRATION) has not been applied."
      echo "[Voxium] This database is not new: $(pending_count) of its $(found_count) migrations are pending."
      echo "[Voxium] The cutover deletes all DM history and every E2E key, and there is no rollback."
      echo "[Voxium] Refusing to apply it on a restart. Run it deliberately, inside the"
      echo "[Voxium] maintenance window, per docs/e2e-always-on-plan.md 7.7. On a database that"
      echo "[Voxium] holds DMs or keys, VOXIUM_ALLOW_CUTOVER=1 alone is not enough: the cutover"
      echo "[Voxium] also needs the authorisation that plan describes (the e2e_cutover_authorised"
      echo "[Voxium] table), or its own SQL gate refuses it."
      echo "[Voxium] If this database never served users:"
      echo "[Voxium]  - another replica is migrating it right now: start this one again once that one is up;"
      echo "[Voxium]  - a first start was interrupted: set VOXIUM_ALLOW_CUTOVER=1 for one start;"
      echo "[Voxium]    the cutover's own SQL gate still refuses if it would delete anything."
      echo "[Voxium]    If that start stops on P3009 naming another migration, that migration may"
      echo "[Voxium]    have run in part: recreate the database empty, or undo what it created and"
      echo "[Voxium]    mark it rolled back before the next start (from apps/server):"
      echo "[Voxium]      node ../../node_modules/prisma/build/index.js migrate resolve --rolled-back <name>"
      echo "[Voxium] If a start stops on P3009 naming $CUTOVER_MIGRATION, the cutover's SQL gate"
      echo "[Voxium] found DMs or keys: this database served users. Never recreate it. Mark the cutover"
      echo "[Voxium] rolled back (from apps/server), then follow docs/e2e-always-on-plan.md 7.7:"
      echo "[Voxium]   node ../../node_modules/prisma/build/index.js migrate resolve --rolled-back $CUTOVER_MIGRATION"
      exit 1
      ;;
    missing)
      echo "[Voxium] The database does not exist yet: migrate deploy creates it."
      ;;
    empty)
      echo "[Voxium] No migration is recorded in this database: every migration is pending."
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
