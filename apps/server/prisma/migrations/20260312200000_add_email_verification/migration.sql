-- Preflight: abort if case-only duplicate emails exist (would violate UNIQUE constraint after normalization)
DO $$
BEGIN
  IF EXISTS (
    SELECT LOWER(TRIM("email"))
    FROM "users"
    GROUP BY LOWER(TRIM("email"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate emails found that differ only by case/whitespace. Resolve manually before migrating: SELECT LOWER(TRIM(email)), array_agg(id) FROM users GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1;';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "email_verification_token" TEXT;
ALTER TABLE "users" ADD COLUMN "email_verification_token_expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_verification_token_key" ON "users"("email_verification_token");

-- Backfill: mark all existing users as verified
UPDATE "users" SET "email_verified" = true;

-- Backfill: normalize existing emails to lowercase
UPDATE "users" SET "email" = LOWER(TRIM("email")) WHERE "email" != LOWER(TRIM("email"));
