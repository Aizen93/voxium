-- Registration abuse hardening:
--  1. users.email_verified_at   — when the address was verified (admin surface)
--  2. users.email_canonical     — duplicate-detection form of the email; kills
--                                 the dotted-gmail infinite-alias vector
--  3. ip_records.kind           — how the IP was FIRST seen ('register' is the
--                                 forensic anchor; existing rows are logins)

ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "email_canonical" TEXT;
ALTER TABLE "ip_records" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'login';

-- Existing verified users get their verification time approximated by
-- account creation — the true time was never recorded. Better an honest
-- approximation than NULL rendering as "never verified" for real users.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified" = true;

-- Backfill canonical emails. Gmail ignores dots in the local part and
-- everything after '+'; other providers get lowercase only (dots are
-- significant there, and +tags are a legitimate power-user habit we only
-- police on the provider the bots actually abuse).
UPDATE "users" SET "email_canonical" =
  CASE
    WHEN split_part(lower("email"), '@', 2) IN ('gmail.com', 'googlemail.com') THEN
      replace(split_part(split_part(lower("email"), '@', 1), '+', 1), '.', '')
      || '@' || split_part(lower("email"), '@', 2)
    ELSE lower("email")
  END;

-- Collisions among EXISTING rows (the bot accounts): keep-oldest owns the
-- canonical; later duplicates fall back to their raw lowercased email so the
-- unique index can build. Those rows are exactly the bot registrations the
-- unverified-account sweep deletes within days.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "email_canonical" ORDER BY "created_at" ASC) AS rn
  FROM "users"
)
UPDATE "users" u SET "email_canonical" = lower(u."email")
FROM ranked r
WHERE u.id = r.id AND r.rn > 1;

-- A raw-email fallback can itself collide with an already-claimed canonical
-- (their raw IS someone's canonical). Null those out — the column is nullable
-- for exactly this pre-migration edge, and registration always writes it.
WITH ranked2 AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "email_canonical" ORDER BY "created_at" ASC) AS rn
  FROM "users" WHERE "email_canonical" IS NOT NULL
)
UPDATE "users" u SET "email_canonical" = NULL
FROM ranked2 r
WHERE u.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX "users_email_canonical_key" ON "users"("email_canonical");
