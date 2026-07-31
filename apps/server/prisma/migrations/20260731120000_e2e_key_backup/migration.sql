-- Encrypted key backup (spec §15): one opaque blob per account, sealed
-- client-side under a recovery key the server never sees. Purely additive:
-- one new table, no changes to any existing one.

-- CreateTable
CREATE TABLE "e2e_key_backups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "blob" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e2e_key_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "e2e_key_backups_user_id_key" ON "e2e_key_backups"("user_id");
