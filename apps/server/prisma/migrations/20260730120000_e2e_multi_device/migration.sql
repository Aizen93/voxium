-- Multi-device E2E (spec §12). Pre-release reset: E2E ships unmerged in this
-- same PR, so there is no production key material to preserve. Existing rows
-- are dropped (they predate the required device_id and the v2 canonical
-- signatures); clients re-register with their EXISTING identity keys, so
-- peers' pinned identities and pickled sessions survive.
DELETE FROM "e2e_devices";

-- DropIndex
DROP INDEX "e2e_devices_user_id_key";

-- AlterTable
ALTER TABLE "e2e_devices" ADD COLUMN     "device_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "e2e_device_registry" (
    "user_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "e2e_device_registry_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "e2e_key_shares" (
    "id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "recipient_device_id" TEXT NOT NULL,
    "sender_user_id" TEXT NOT NULL,
    "sender_device_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_key_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "e2e_key_shares_recipient_user_id_recipient_device_id_create_idx" ON "e2e_key_shares"("recipient_user_id", "recipient_device_id", "created_at");

-- CreateIndex
CREATE INDEX "e2e_devices_user_id_idx" ON "e2e_devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "e2e_devices_user_id_device_id_key" ON "e2e_devices"("user_id", "device_id");
