-- Performance indexes (CRIT-2 / stabilization).
--
-- These are purely additive (no data change) and fix full-table scans that hurt at
-- production scale:
--   * messages.reply_to_id — the ON DELETE SET NULL self-relation runs an UPDATE per
--     deleted row; without this index, deleting a channel/server/user is O(N^2) over
--     the messages table (can lock the DB for minutes on a busy channel).
--   * messages.author_id — user-delete cascade + admin message counts seq-scan messages.
--   * messages.created_at — admin live metrics filter WHERE created_at >= now()-1h every
--     5s; the composite (channel_id, created_at) index cannot serve this.
--   * server_members.server_id — the PK is (user_id, server_id), so member-list loads,
--     counts, and the server-delete cascade have no usable index on server_id alone.
--   * conversations.user2_id — the unique (user1_id, user2_id) only covers the user1_id
--     prefix; the OR user1/user2 lookup runs on every socket connect.
-- The remaining indexes back foreign-key cascade paths that seq-scan today.
--
-- IF NOT EXISTS makes this safe to run more than once and safe to pre-create out of band.
-- NOTE: on a very large `messages` table, prefer creating the messages_* indexes with
-- CREATE INDEX CONCURRENTLY during a maintenance window (CONCURRENTLY cannot run inside
-- a migration transaction), then mark this migration applied with `prisma migrate resolve`.

-- Hot-path indexes (CRIT-2)
CREATE INDEX IF NOT EXISTS "messages_reply_to_id_idx" ON "messages"("reply_to_id");
CREATE INDEX IF NOT EXISTS "messages_author_id_idx" ON "messages"("author_id");
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages"("created_at");
CREATE INDEX IF NOT EXISTS "server_members_server_id_idx" ON "server_members"("server_id");
CREATE INDEX IF NOT EXISTS "conversations_user2_id_idx" ON "conversations"("user2_id");

-- Foreign-key / cascade indexes
CREATE INDEX IF NOT EXISTS "categories_server_id_idx" ON "categories"("server_id");
CREATE INDEX IF NOT EXISTS "channels_server_id_idx" ON "channels"("server_id");
CREATE INDEX IF NOT EXISTS "channels_category_id_idx" ON "channels"("category_id");
CREATE INDEX IF NOT EXISTS "channel_reads_channel_id_idx" ON "channel_reads"("channel_id");
CREATE INDEX IF NOT EXISTS "conversation_reads_conversation_id_idx" ON "conversation_reads"("conversation_id");
CREATE INDEX IF NOT EXISTS "invites_server_id_idx" ON "invites"("server_id");
CREATE INDEX IF NOT EXISTS "invites_created_by_idx" ON "invites"("created_by");
CREATE INDEX IF NOT EXISTS "message_reactions_user_id_idx" ON "message_reactions"("user_id");
CREATE INDEX IF NOT EXISTS "reports_reporter_id_idx" ON "reports"("reporter_id");
CREATE INDEX IF NOT EXISTS "reports_reported_user_id_idx" ON "reports"("reported_user_id");
CREATE INDEX IF NOT EXISTS "reports_message_id_idx" ON "reports"("message_id");
CREATE INDEX IF NOT EXISTS "announcements_created_by_id_idx" ON "announcements"("created_by_id");
CREATE INDEX IF NOT EXISTS "support_messages_author_id_idx" ON "support_messages"("author_id");
