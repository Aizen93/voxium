-- DropForeignKey
ALTER TABLE "ip_bans" DROP CONSTRAINT "ip_bans_banned_by_fkey";

-- AlterTable
ALTER TABLE "ip_bans" ALTER COLUMN "banned_by" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ip_bans" ADD CONSTRAINT "ip_bans_banned_by_fkey" FOREIGN KEY ("banned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
