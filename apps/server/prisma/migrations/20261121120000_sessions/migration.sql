-- Sign-in sessions (#52): one row per signed-in device or browser, and the
-- record of the refresh tokens issued before sessions existed as they are
-- first presented. Two new tables; no existing table gains or loses a
-- column, and no existing row changes.
--
-- WHAT.
--   sessions                    one row per session. `id` is the `sid` claim
--                               of its tokens and the socket room
--                               `session:{id}`; `generation` is the `gen` of
--                               the newest refresh token issued; rotated_at,
--                               created_at and expires_at are written on the
--                               database's clock in UTC, like every other
--                               timestamp column here; token_version is the
--                               account's when the row was issued or
--                               re-keyed (a row below the account's is dead);
--                               client_kind and client_os hold a value of a
--                               closed list (packages/shared, SESSION_*).
--                               No address, no user agent, no typed name.
--                               ON DELETE CASCADE from users: an account
--                               deletion takes its sessions with it.
--   legacy_refresh_redemptions  the SHA-256 of a refresh token that names no
--                               session, the session it was upgraded into
--                               (SET NULL when that session ends: the token
--                               is then refused for good) and the token's own
--                               expiry. Transitional: no such token is issued
--                               any more, and the table is dropped by a later
--                               migration once every one has expired.
--   Two plain indexes: sessions(user_id), which every per-account statement
--   reads, and legacy_refresh_redemptions(session_id), which the SET NULL of
--   every session delete looks up. The columns a renewal updates carry no
--   index, so a renewal rewrites no index entry.
--
-- ONE statement (a DO block), so it is applied whole or not at all on any
-- connection that runs it: `prisma migrate deploy` commits a file's
-- statements one after the other, and a failure part way would leave a
-- table without its keys.
--
-- LOCKS. Creating the two tables and their indexes locks nothing anyone else
-- can see. The foreign key to `users` takes a SHARE ROW EXCLUSIVE lock on
-- `users` (on the creating side too, for its triggers): it conflicts with
-- every write to `users` (presence on each socket connect, a token version
-- bump) but with no read, and once granted it lasts until the block commits,
-- a few milliseconds later (the new table is empty, so nothing is validated).
-- The WAIT is the cost: the lock queues behind every open transaction that
-- wrote `users` (an account deletion holds its row through a cascade of tens
-- of seconds on a heavy account), and while it queues every later write to
-- `users` queues behind it. So the key is added under a lock_timeout of 2 s,
-- set for this transaction only (set_config(..., true): it never outlives the
-- block on the connection), and tried again after a pause of 1 s, at most 20
-- times: no write to `users` waits behind this migration for more than one
-- timeout, and a holder of up to about a minute is waited out. The key from
-- legacy_refresh_redemptions to sessions locks only the new table.
--
-- IF IT FAILS. Every attempt finding `users` locked raises lock_not_available
-- ("users stayed locked ..."), the block rolls back whole and nothing of it
-- remains; `migrate deploy` records the migration as failed, and every later
-- deploy stops on P3009 until that record is cleared. Find what holds `users`
-- (pg_stat_activity, a transaction idle for long), let it end, then, from
-- apps/server:
--   npx prisma migrate resolve --rolled-back 20261121120000_sessions
--   npx prisma migrate deploy
-- There is nothing to undo by hand.
--
-- NOTE: the block can also be applied out of band: run this file with
-- `prisma db execute --file`, then
-- `prisma migrate resolve --applied 20261121120000_sessions`. Every step
-- checks for what exists, so running it again after a run that did commit
-- changes nothing.
--
-- DEPLOYMENT ORDER. This migration first, then the server shipped with it
-- (the server image's entrypoint applies it before the server starts): that
-- server writes a row at every sign-in and renewal, and on a database without
-- these tables every sign-in and every renewal would answer 500 (an outage,
-- never a sign-out: nothing answers 401 for it). A server older than this
-- migration runs on the schema after it and never reads the new tables. The
-- clients follow the server; a client older than it keeps working.
DO $$
DECLARE
  attempt integer := 0;
BEGIN
  CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "rotated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "remember_me" BOOLEAN NOT NULL,
    "token_version" INTEGER NOT NULL,
    "client_kind" TEXT NOT NULL,
    "client_os" TEXT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
  );

  CREATE TABLE IF NOT EXISTS "legacy_refresh_redemptions" (
    "digest" TEXT NOT NULL,
    "session_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legacy_refresh_redemptions_pkey" PRIMARY KEY ("digest")
  );

  CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions"("user_id");
  CREATE INDEX IF NOT EXISTS "legacy_refresh_redemptions_session_id_idx" ON "legacy_refresh_redemptions"("session_id");

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'legacy_refresh_redemptions'::regclass
      AND conname = 'legacy_refresh_redemptions_session_id_fkey'
  ) THEN
    ALTER TABLE "legacy_refresh_redemptions" ADD CONSTRAINT "legacy_refresh_redemptions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- The key to `users`, under a timeout of this transaction only (see LOCKS)
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    EXIT WHEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'sessions'::regclass
        AND conname = 'sessions_user_id_fkey'
    );
    BEGIN
      ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;
      IF attempt >= 20 THEN
        RAISE EXCEPTION 'users stayed locked for 20 attempts of 2 s: sessions_user_id_fkey was not added and nothing of this migration was applied'
          USING ERRCODE = 'lock_not_available';
      END IF;
      -- Out of the queue while it pauses: the writes it held go through
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
