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
