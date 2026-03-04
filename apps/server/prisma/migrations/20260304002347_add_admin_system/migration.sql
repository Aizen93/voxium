-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ban_reason" TEXT,
ADD COLUMN     "banned_at" TIMESTAMP(3),
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "ip_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_bans" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "reason" TEXT,
    "banned_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_bans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ip_records_ip_idx" ON "ip_records"("ip");

-- CreateIndex
CREATE UNIQUE INDEX "ip_records_user_id_ip_key" ON "ip_records"("user_id", "ip");

-- CreateIndex
CREATE UNIQUE INDEX "ip_bans_ip_key" ON "ip_bans"("ip");

-- AddForeignKey
ALTER TABLE "ip_records" ADD CONSTRAINT "ip_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_bans" ADD CONSTRAINT "ip_bans_banned_by_fkey" FOREIGN KEY ("banned_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
