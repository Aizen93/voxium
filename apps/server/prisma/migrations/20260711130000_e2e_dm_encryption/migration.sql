-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "encrypted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "encrypted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "content_source" TEXT NOT NULL DEFAULT 'server';

-- CreateTable
CREATE TABLE "e2e_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "curve25519_key" TEXT NOT NULL,
    "ed25519_key" TEXT NOT NULL,
    "device_signature" TEXT NOT NULL,
    "fallback_key_id" TEXT,
    "fallback_key" TEXT,
    "fallback_key_signature" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e2e_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "e2e_one_time_keys" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_one_time_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "e2e_devices_user_id_key" ON "e2e_devices"("user_id");

-- CreateIndex
CREATE INDEX "e2e_one_time_keys_device_id_created_at_idx" ON "e2e_one_time_keys"("device_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "e2e_one_time_keys_device_id_key_id_key" ON "e2e_one_time_keys"("device_id", "key_id");

-- AddForeignKey
ALTER TABLE "e2e_devices" ADD CONSTRAINT "e2e_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e2e_one_time_keys" ADD CONSTRAINT "e2e_one_time_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "e2e_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

