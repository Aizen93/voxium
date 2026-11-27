-- Moderation reports (#48): the schema half of a report that outlives the
-- account that filed it, or that it concerns. Expand only: both foreign keys
-- to `users` keep ON DELETE CASCADE, and no row loses a side.
--
-- WHAT.
--   reports.reporter_id,              NOT NULL dropped. A NULL side will mean
--   reports.reported_user_id          "that account was deleted". Both
--                                     foreign keys keep ON DELETE CASCADE: an
--                                     account deletion that does not settle
--                                     the account's reports first still
--                                     deletes them with the account, as
--                                     before.
--   reports.reported_username         new, nullable text, no default: the
--                                     reported account's username, which a
--                                     report keeps once that account is gone.
--   reports.reporter_deleted_at,      new, nullable timestamp(3), no default:
--   reports.reported_user_deleted_at  when that side's account was deleted,
--                                     on the database's clock in UTC.
-- The backfill writes reported_username, from users.username, into every row
-- that has none, through its reported account. A space report names the
-- space's owner at the time it was filed as its reported account, so it holds
-- that owner's username.
--
-- It deletes nothing. No index is added or dropped: the three partial unique
-- indexes reports_pending_* (migration
-- 20261111150000_reports_one_pending_per_target) stay as they are, and a
-- NULL side never collides in them (PostgreSQL treats NULLs as DISTINCT in a
-- unique index).
--
-- ONE statement (a DO block), so it is applied whole or not at all on any
-- connection that runs it: `prisma migrate deploy` commits a file's
-- statements one after the other, and a failure part way would leave the
-- columns without their backfill.
--
-- LOCKS. The ALTER TABLE takes an ACCESS EXCLUSIVE lock on `reports` and the
-- block holds it until it commits. The ALTER itself is a catalog update:
-- dropping NOT NULL checks no row, and a nullable column without a default
-- writes none. The backfill then rewrites every report row once, under that
-- lock, and reads `users` without locking any of its rows (ACCESS SHARE: no
-- write to `users` waits for it). The table is small, so once granted the
-- lock lasts milliseconds. The WAIT is the cost: the ALTER queues behind
-- every open transaction that touched `reports` (an account deletion holds
-- report rows through its cascade for up to its 60 s budget, so does a
-- report resolution), and behind every long read of the table (a dump, a
-- long export of the reports): ACCESS EXCLUSIVE conflicts with the ACCESS
-- SHARE lock a plain read takes. While it queues, every later statement on
-- `reports` queues behind it: the moderation queue, filing a report, every
-- account deletion, and every message delete anywhere (the key from reports
-- to messages is ON DELETE SET NULL, so a message delete updates `reports`).
-- So the block runs under a lock_timeout of 2 s, set for this transaction
-- only (set_config(..., true): it never outlives the block on the
-- connection), and an attempt that times out is rolled back to its own start
-- and tried again after a pause of 1 s, at most 20 times: no statement waits
-- behind this migration for more than one timeout, and a holder of up to
-- about a minute is waited out.
--
-- IF IT FAILS. Every attempt finding `reports` (or `users`) locked raises
-- lock_not_available ("reports stayed locked ..."), the block rolls back
-- whole and nothing of it remains; `migrate deploy` records the migration as
-- failed, and every later deploy stops on P3009 until that record is
-- cleared. Find what holds the table (pg_stat_activity: a transaction idle
-- for long, a dump or another long read of `reports`), let it end, then,
-- from apps/server:
--   npx prisma migrate resolve --rolled-back 20261123120000_reports_outlive_deleted_accounts
--   npx prisma migrate deploy
-- There is nothing to undo by hand.
--
-- NOTE: the block can also be applied out of band: run this file with
-- `prisma db execute --file`, then
-- `prisma migrate resolve --applied 20261123120000_reports_outlive_deleted_accounts`.
-- Every step is safe to repeat (DROP NOT NULL, ADD COLUMN IF NOT EXISTS, a
-- backfill of the rows that have no username yet), so running it again after
-- a run that did commit changes nothing.
--
-- DEPLOYMENT ORDER. This migration first, then the server shipped with it
-- (the server image's entrypoint applies it before the server starts). That
-- server's Prisma client names the three new columns whenever it reads or
-- writes a whole report row (filing a report, the moderation queue, a
-- resolution, a dismissal), which answers P2022 on a database without them.
-- A server older than this migration runs on the schema after it: it names
-- none of the new columns, a report it files simply has no username yet (a
-- reader takes it from the account), and no side is NULL until an account
-- deletion keeps a report, which the server shipped with this migration does
-- only behind a feature flag that ships off. Once that flag has kept one
-- report, no node may run code older than this migration's: it cannot read a
-- report with a NULL side, and its account deletion would delete the reports
-- instead of keeping them.
DO $$
DECLARE
  attempt integer := 0;
BEGIN
  -- Every lock of the block under a timeout of this transaction only (see LOCKS)
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "reports"
        ALTER COLUMN "reporter_id" DROP NOT NULL,
        ALTER COLUMN "reported_user_id" DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS "reported_username" TEXT,
        ADD COLUMN IF NOT EXISTS "reporter_deleted_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "reported_user_deleted_at" TIMESTAMP(3);

      UPDATE "reports" r
      SET "reported_username" = u."username"
      FROM "users" u
      WHERE u."id" = r."reported_user_id"
        AND r."reported_username" IS NULL;

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;
      IF attempt >= 20 THEN
        RAISE EXCEPTION 'reports stayed locked for 20 attempts of 2 s: nothing of this migration was applied'
          USING ERRCODE = 'lock_not_available';
      END IF;
      -- Out of the queue while it pauses: the statements it held go through
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
