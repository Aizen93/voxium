-- The scheduled jobs' switch and the record of their runs (utils/jobs.ts).
-- ADDITIVE: two new tables, one index and one key; no existing table gains or
-- loses a column, and no existing row changes.
--
-- WHAT.
--   job_settings  one row per job an administrator switched: the job's name
--                 in the registry, its mode (off, count or on), when it was
--                 set and by whom (SET NULL when that account is deleted). A
--                 job with no row is in its default mode.
--   job_runs      one row per recorded run: the job, when it started and
--                 finished, the node that ran it, the mode it ran in, the
--                 outcome (success, failed or skipped) and a skip's reason,
--                 the job's own counts (numbers and words of a closed list
--                 only) and, for a failure, the error as the server's log
--                 describes it. The id is the insertion order: the history
--                 is paged and pruned by it.
--   One index, job_runs(job, id): the history of one job newest first, the
--   prune the wrapper runs after each insert (the rows of that job past the
--   newest 200) and the last run of each job. job_settings has no index
--   beside its key: it holds one row per job at most, so the SET NULL of an
--   account deletion reads it whole.
--
-- ONE statement (a DO block), so it is applied whole or not at all on any
-- connection that runs it: `prisma migrate deploy` commits a file's
-- statements one after the other, and a failure part way would leave a
-- table without its key.
--
-- LOCKS. Creating the two tables and the index locks nothing anyone else can
-- see. The key from job_settings to `users` takes a SHARE ROW EXCLUSIVE lock
-- on `users`: it conflicts with every write to `users` (presence on each
-- socket connect, a token version bump) but with no read, and once granted it
-- lasts until the block commits, a few milliseconds later (the new table is
-- empty, so nothing is validated). The WAIT is the cost: the lock queues
-- behind every open transaction that wrote `users` (an account deletion
-- holds its row through a cascade of tens of seconds on a heavy account),
-- and while it queues every later write to `users` queues behind it. So the
-- key is added under a lock_timeout of 2 s, set for this transaction only
-- (set_config(..., true): it never outlives the block on the connection),
-- and tried again after a pause of 1 s, at most 20 times: no write to
-- `users` waits behind this migration for more than one timeout, and a
-- holder of up to about a minute is waited out.
--
-- IF IT FAILS. Every attempt finding `users` locked raises lock_not_available
-- ("users stayed locked ..."), the block rolls back whole and nothing of it
-- remains; `migrate deploy` records the migration as failed, and every later
-- deploy stops on P3009 until that record is cleared. Find what holds `users`
-- (pg_stat_activity, a transaction idle for long), let it end, then, from
-- apps/server:
--   npx prisma migrate resolve --rolled-back 20261127120000_job_registry
--   npx prisma migrate deploy
-- There is nothing to undo by hand. Every step checks for what exists, so
-- running the block again after a run that did commit changes nothing.
--
-- DEPLOYMENT ORDER. This migration first, then the server shipped with it
-- (the server image's entrypoint applies it before the server starts). A
-- server OLDER than this migration runs on the schema after it unaffected: it
-- never reads the two tables. A server NEWER than it, started on a database
-- without it, keeps every job running: the missing settings table reads as
-- the default mode (on), with one warning per job per hour (a mode that
-- cannot be read for any other reason skips that tick), and a run that
-- cannot be recorded is not recorded (one warning per job per hour); nothing
-- is switched and nothing is recorded until the migration is in, and the
-- admin Jobs page answers an error.
DO $$
DECLARE
  attempt integer := 0;
BEGIN
  CREATE TABLE IF NOT EXISTS "job_settings" (
    "job" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "set_at" TIMESTAMP(3) NOT NULL,
    "set_by_id" TEXT,

    CONSTRAINT "job_settings_pkey" PRIMARY KEY ("job")
  );

  CREATE TABLE IF NOT EXISTS "job_runs" (
    "id" SERIAL NOT NULL,
    "job" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "node_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "skip_reason" TEXT,
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
  );

  CREATE INDEX IF NOT EXISTS "job_runs_job_id_idx" ON "job_runs"("job", "id");

  -- The key to `users`, under a timeout of this transaction only (see LOCKS)
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    EXIT WHEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'job_settings'::regclass
        AND conname = 'job_settings_set_by_id_fkey'
    );
    BEGIN
      ALTER TABLE "job_settings" ADD CONSTRAINT "job_settings_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;
      IF attempt >= 20 THEN
        RAISE EXCEPTION 'users stayed locked for 20 attempts of 2 s: job_settings_set_by_id_fkey was not added and nothing of this migration was applied'
          USING ERRCODE = 'lock_not_available';
      END IF;
      -- Out of the queue while it pauses: the writes it held go through
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
