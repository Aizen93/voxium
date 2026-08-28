-- Cross-signing (spec §14): account master key + device cross-signatures +
-- the device-approval (master secret handoff) mailbox. Purely additive:
-- a nullable column and two new tables. Devices registered before this
-- migration simply have master_signature = NULL and read as unsigned.

-- AlterTable
ALTER TABLE "e2e_devices" ADD COLUMN     "master_signature" TEXT;

-- CreateTable
CREATE TABLE "e2e_master_keys" (
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e2e_master_keys_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "e2e_master_transfers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "recipient_device_id" TEXT NOT NULL,
    "sender_device_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_master_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "e2e_master_transfers_user_id_recipient_device_id_created_at_idx" ON "e2e_master_transfers"("user_id", "recipient_device_id", "created_at");
