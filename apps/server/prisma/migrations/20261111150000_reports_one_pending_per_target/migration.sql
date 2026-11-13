-- One PENDING report per reporter and target, enforced by the database.
--
-- WHY. POST /reports looks for a pending report by the same reporter against
-- the same target and refuses a second one, but the look and the insert are
-- separate statements: concurrent identical reports all passed the look and
-- all inserted, and the table, with single-column indexes only, refused
-- nothing. The partial unique indexes below refuse the second insert; the
-- route answers their violation (P2002) as the look does ("You already have a
-- pending report against this target").
--
-- The target of each type is what the route's look matches on:
--   user    → reported_user_id
--   message → message_id (its author is the reported_user_id, so the pair
--             follows from it)
--   server  → server_id (a message report in a space carries a server_id
--             too: the type is part of every predicate)
-- A report leaves its index when it is resolved or dismissed: there may be
-- any number of closed ones. A message report whose message was deleted
-- keeps a NULL message_id (SET NULL), and NULLs never collide in a unique
-- index, so those stay as they are.
--
-- They are created here, in SQL, and are invisible to schema.prisma, because
-- the schema does not enable Prisma's `partialIndexes` preview feature, the
-- one that lets a schema declare a partial index (see the note on Report
-- there; `prisma migrate diff` against a migrated database leaves them alone
-- while it is off). Enabling it without declaring these three in the schema
-- would make `prisma migrate dev` read them as drift and drop them. Should
-- `prisma migrate dev` ever offer to DROP them as drift, do not let it.
--
-- ONE statement, so it holds on any connection that runs it: the lock in
-- step 0 lasts until step 2's indexes exist, whether or not the statements
-- around it share a transaction.
DO $$
BEGIN
  -- 0. No report is written or closed until the indexes exist (reads go
  --    on): a duplicate inserted after step 1 would make step 2 fail, and a
  --    failed migration blocks every later deploy. The table is small; the
  --    lock lasts as long as one pass over its pending rows and three
  --    index builds.
  LOCK TABLE "reports" IN SHARE ROW EXCLUSIVE MODE;

  -- 1. Duplicates written before the indexes existed: of each reporter's
  --    pending reports against one target, the OLDEST (the one the route's
  --    look would have found) stays pending; every later one is closed as
  --    dismissed, its resolution naming the one kept. Nothing is deleted:
  --    what each report said stays readable under Dismissed in the
  --    moderation queue. resolved_by_id stays NULL: no moderator decided.
  --    Idempotent: a second run finds no duplicate.
  WITH ranked AS (
    SELECT "id",
           first_value("id") OVER w AS kept_id,
           row_number() OVER w AS rn
    FROM "reports"
    WHERE "status" = 'pending'
      AND (   ("type" = 'user')
           OR ("type" = 'message' AND "message_id" IS NOT NULL)
           OR ("type" = 'server' AND "server_id" IS NOT NULL))
    WINDOW w AS (
      PARTITION BY "reporter_id", "type",
                   CASE "type"
                     WHEN 'user' THEN "reported_user_id"
                     WHEN 'message' THEN "message_id"
                     ELSE "server_id"
                   END
      ORDER BY "created_at" ASC, "id" ASC
    )
  )
  UPDATE "reports" r
  SET "status" = 'dismissed',
      "resolved_at" = now(),
      "resolution" = 'Closed automatically: a duplicate of the earlier pending report ' || ranked.kept_id || ' by the same reporter.'
  FROM ranked
  WHERE r."id" = ranked."id"
    AND ranked.rn > 1;

  -- 2. The constraints. IF NOT EXISTS: an operator who built one out of
  --    band (CREATE UNIQUE INDEX CONCURRENTLY, outside any transaction)
  --    before `prisma migrate resolve --applied` can let this run again.
  CREATE UNIQUE INDEX IF NOT EXISTS "reports_pending_user_key"
    ON "reports" ("reporter_id", "reported_user_id")
    WHERE "status" = 'pending' AND "type" = 'user';
  CREATE UNIQUE INDEX IF NOT EXISTS "reports_pending_message_key"
    ON "reports" ("reporter_id", "message_id")
    WHERE "status" = 'pending' AND "type" = 'message';
  CREATE UNIQUE INDEX IF NOT EXISTS "reports_pending_server_key"
    ON "reports" ("reporter_id", "server_id")
    WHERE "status" = 'pending' AND "type" = 'server';
END $$;

-- Read-only count an operator can run BEFORE applying this migration: the
-- pending reports step 1 will close.
--   SELECT count(*) FROM (
--     SELECT row_number() OVER (
--              PARTITION BY reporter_id, type,
--                           CASE type WHEN 'user' THEN reported_user_id
--                                     WHEN 'message' THEN message_id
--                                     ELSE server_id END
--              ORDER BY created_at, id) AS rn
--     FROM reports
--     WHERE status = 'pending'
--       AND (type = 'user' OR (type = 'message' AND message_id IS NOT NULL)
--                          OR (type = 'server' AND server_id IS NOT NULL))
--   ) d WHERE rn > 1;
