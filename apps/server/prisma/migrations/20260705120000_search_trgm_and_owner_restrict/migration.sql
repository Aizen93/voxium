-- P3 stabilization: message-search trigram index (MED-14) + owner-cascade safety.
--
-- 1. pg_trgm GIN index on messages.content
--    Message search uses ILIKE '%q%', which cannot use a btree index — every
--    search scanned the entire messages table. A trigram GIN index serves
--    arbitrary-substring ILIKE directly, no query changes needed.
--    NOTE: on a very large `messages` table, prefer CREATE INDEX CONCURRENTLY
--    during a maintenance window (CONCURRENTLY cannot run inside a migration
--    transaction), then mark this migration applied with `prisma migrate resolve`.
--
-- 2. servers.owner_id: ON DELETE CASCADE → RESTRICT
--    A plain user.delete() silently cascade-deleted every community that user
--    owned (with the O(N^2) reply_to_id trigger cost on their messages). The
--    admin delete-user flow already transfers or explicitly deletes owned
--    servers first — the DEFAULT path now fails safe instead of destroying data.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "messages_content_idx" ON "messages" USING GIN ("content" gin_trgm_ops);

ALTER TABLE "servers" DROP CONSTRAINT "servers_owner_id_fkey";
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
