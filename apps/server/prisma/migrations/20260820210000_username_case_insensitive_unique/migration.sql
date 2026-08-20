-- Enforce, in the DATABASE, the case-insensitive username rule the app has
-- only ever checked in application code.
--
-- WHY. registerUser looks up `username` with mode:'insensitive' and rejects a
-- match, but `users.username` is a plain btree unique index and Postgres
-- compares bytes. Two concurrent signups for 'Alice' and 'alice' therefore
-- both see an empty pre-check and both commit — and every insensitive lookup
-- downstream (friend requests, member search) becomes nondeterministic
-- between them, which is exactly the impersonation route the check exists to
-- close.
--
-- Prisma cannot express a functional index in schema.prisma, so this is raw
-- SQL and `users_username_lower_key` is invisible to the schema. See the note
-- on User.username there before running `prisma migrate dev` — it would offer
-- to drop this index as drift.

-- 1. Repair BOT squatters automatically. Collisions are overwhelmingly the
--    unverified accounts the 7-day hygiene sweep deletes anyway; the oldest
--    row keeps the name and the rest are suffixed. The replacement stays
--    inside the app's own charset ([a-zA-Z0-9_.-]) and 32-char limit.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY lower("username") ORDER BY "created_at" ASC, id ASC
         ) AS rn
  FROM "users"
)
UPDATE "users" u
SET "username" = left(u."username", 24) || '_' || substr(md5(u.id), 1, 6)
FROM ranked r
WHERE u.id = r.id
  AND r.rn > 1
  AND u."email_verified" = false;

-- 2. Anything still colliding involves a REAL, verified account. Renaming a
--    verified user's login identity behind their back is not a migration's
--    call to make, so stop and hand it to an operator with the rows named.
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(u, ', ')
    INTO collisions
    FROM (
      SELECT lower("username") AS u
      FROM "users"
      GROUP BY 1
      HAVING count(*) > 1
    ) dupes;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce case-insensitive usernames: verified accounts collide on %. Rename the losers deliberately (they are real users), then re-run this migration.',
      collisions;
  END IF;
END $$;

-- 3. The constraint itself. NOTE FOR PRODUCTION: this takes ACCESS EXCLUSIVE
--    on "users" for the duration of the build. On a large table, build it
--    out-of-band first with
--      CREATE UNIQUE INDEX CONCURRENTLY "users_username_lower_key" ON "users" (lower("username"));
--    (CONCURRENTLY cannot run inside a migration's transaction) and then
--    `prisma migrate resolve --applied 20260820210000_username_case_insensitive_unique`.
CREATE UNIQUE INDEX "users_username_lower_key" ON "users" (lower("username"));
