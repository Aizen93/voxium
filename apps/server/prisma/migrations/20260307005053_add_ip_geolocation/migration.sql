-- AlterTable
ALTER TABLE "ip_records" ADD COLUMN     "country" TEXT,
ADD COLUMN     "country_code" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;
