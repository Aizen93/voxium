-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_supporter" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supporter_since" TIMESTAMP(3);
