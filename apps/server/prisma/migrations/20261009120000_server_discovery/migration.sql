-- Server discovery, step 1 (docs/local/server-discovery-plan.html, "Data model").
--
-- 1. servers gains the directory profile (description, tags, discoverable,
--    join_mode), the platform-admin curation/block timestamps, the
--    materialised eligibility column discovery_listed, the inline-maintained
--    member_count and the daily-cycle activity snapshot columns.
-- 2. server_bans: every removal from a server is a ban; joinServerMember()
--    refuses on this row for invites, direct joins and approved requests.
-- 3. server_join_requests: approval-mode join requests (pending | declined).
-- 4. One index per directory sort ending in id (keyset cursors), the stats
--    refresh index, the Featured index, a GIN on tags and a pg_trgm GIN on
--    name (the extension is installed by 20260705120000_search_trgm_and_owner_restrict).
--    No partial indexes: Prisma cannot express them and `migrate dev` would
--    read them as drift.
-- 5. Two backfills at the end: member_count from server_members and
--    discovery_listed from its four inputs. Without them every existing server
--    would rank with zero members and the nightly pass would be the first
--    thing to fix it.
--
-- NOTE: on a very large `servers` table, prefer CREATE INDEX CONCURRENTLY for
-- the GIN indexes during a maintenance window (CONCURRENTLY cannot run inside
-- a migration transaction), then mark this migration applied with
-- `prisma migrate resolve`.

-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "description" TEXT,
ADD COLUMN     "discoverable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "discovery_activity_score" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discovery_blocked_at" TIMESTAMP(3),
ADD COLUMN     "discovery_listed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "discovery_online_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discovery_stats_at" TIMESTAMP(3),
ADD COLUMN     "discovery_weekly_messages" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "featured_at" TIMESTAMP(3),
ADD COLUMN     "join_mode" TEXT NOT NULL DEFAULT 'approval',
ADD COLUMN     "member_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "server_bans" (
    "server_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "banned_by_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_bans_pkey" PRIMARY KEY ("server_id","user_id")
);

-- CreateTable
CREATE TABLE "server_join_requests" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "server_bans_user_id_idx" ON "server_bans"("user_id");

-- CreateIndex
CREATE INDEX "server_join_requests_server_id_status_idx" ON "server_join_requests"("server_id", "status");

-- CreateIndex
CREATE INDEX "server_join_requests_user_id_idx" ON "server_join_requests"("user_id");

-- CreateIndex
CREATE INDEX "server_join_requests_status_created_at_idx" ON "server_join_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "server_join_requests_status_decided_at_idx" ON "server_join_requests"("status", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "server_join_requests_server_id_user_id_key" ON "server_join_requests"("server_id", "user_id");

-- CreateIndex
CREATE INDEX "servers_discovery_listed_discovery_activity_score_id_idx" ON "servers"("discovery_listed", "discovery_activity_score" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "servers_discovery_listed_member_count_id_idx" ON "servers"("discovery_listed", "member_count" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "servers_discovery_listed_created_at_id_idx" ON "servers"("discovery_listed", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "servers_discovery_listed_name_id_idx" ON "servers"("discovery_listed", "name", "id");

-- CreateIndex
CREATE INDEX "servers_discovery_listed_discovery_stats_at_idx" ON "servers"("discovery_listed", "discovery_stats_at");

-- CreateIndex
CREATE INDEX "servers_featured_at_idx" ON "servers"("featured_at");

-- CreateIndex
CREATE INDEX "servers_tags_idx" ON "servers" USING GIN ("tags" array_ops);

-- CreateIndex
CREATE INDEX "servers_name_trgm_idx" ON "servers" USING GIN ("name" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "server_bans" ADD CONSTRAINT "server_bans_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_bans" ADD CONSTRAINT "server_bans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_bans" ADD CONSTRAINT "server_bans_banned_by_id_fkey" FOREIGN KEY ("banned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_join_requests" ADD CONSTRAINT "server_join_requests_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_join_requests" ADD CONSTRAINT "server_join_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_join_requests" ADD CONSTRAINT "server_join_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: member_count from the membership table, one statement.
UPDATE "servers" s
SET "member_count" = c.n
FROM (
  SELECT "server_id", COUNT(*)::int AS n
  FROM "server_members"
  GROUP BY "server_id"
) c
WHERE c."server_id" = s."id";

-- Backfill: discovery_listed from its four inputs, one statement. Every
-- existing server is listed by default (the owner's call); invites-locked
-- servers and servers whose owner is platform-banned start hidden.
UPDATE "servers" s
SET "discovery_listed" = (
  s."discoverable"
  AND NOT s."invites_locked"
  AND s."discovery_blocked_at" IS NULL
  AND u."banned_at" IS NULL
)
FROM "users" u
WHERE u."id" = s."owner_id";
