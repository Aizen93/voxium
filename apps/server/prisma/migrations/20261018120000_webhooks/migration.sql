-- Incoming webhooks, step 1 (docs/local/webhooks-plan.html, "Data model").
--
-- 1. webhooks: one row per incoming webhook of a channel. Only the token's
--    SHA-256 is stored (token_hash); secret_enc holds the GitHub signing
--    secret, AES-256-GCM encrypted. The row dies with its server or channel;
--    created_by_id is SET NULL when the creator's account goes.
-- 2. messages.author_id becomes NULLABLE: a webhook-authored row has no user
--    author. Every reader synthesises the author from webhook_name
--    (utils/messageAuthor.ts), so the wire shape keeps a non-null author.
-- 3. messages gains webhook_id (SET NULL when the webhook is deleted, so the
--    posted messages survive it) and webhook_name (the label frozen at post
--    time), plus messages_webhook_id_idx. PostgreSQL does not index FK
--    columns, and both the FK's ON DELETE SET NULL action and the
--    delete-time purge find a webhook's rows by webhook_id: without the
--    index every webhook delete (and each one a channel or server delete
--    cascades to) is a sequential scan of messages. Same reason as the
--    reply_to_id and author_id indexes.
-- 4. global_config / server_limits gain max_webhooks_per_server (global
--    default 10; the per-server override is nullable = inherit).
--
-- No backfill and no table rewrite: DROP NOT NULL, the nullable ADD COLUMNs
-- and the NOT NULL DEFAULT constant on the singleton global_config are
-- catalog-only on PostgreSQL 11+, and the new table is empty. The one
-- statement that is NOT catalog-only is the messages_webhook_id_idx build:
-- one full pass over messages, under a SHARE lock that blocks writes to
-- messages until it finishes. Besides it, the messages_webhook_id_fkey ADD
-- CONSTRAINT reads existing rows: PostgreSQL validates it with a single
-- read-only pass (every webhook_id is NULL, nothing is written).
--
-- NOTE: on a very large `messages` table, during a maintenance window:
-- build the index with `CREATE INDEX CONCURRENTLY "messages_webhook_id_idx"
-- ON "messages"("webhook_id")` OUTSIDE the migration transaction
-- (CONCURRENTLY cannot run inside one), and run the ADD CONSTRAINT as
-- `... NOT VALID` followed by `ALTER TABLE "messages" VALIDATE CONSTRAINT
-- "messages_webhook_id_fkey"` in a separate transaction (VALIDATE does not
-- block writes); then mark this migration applied with
-- `prisma migrate resolve --applied 20261018120000_webhooks`.

-- AlterTable
ALTER TABLE "global_config" ADD COLUMN     "max_webhooks_per_server" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "webhook_id" TEXT,
ADD COLUMN     "webhook_name" TEXT,
ALTER COLUMN "author_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "server_limits" ADD COLUMN     "max_webhooks_per_server" INTEGER;

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'generic',
    "token_hash" TEXT NOT NULL,
    "secret_enc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhooks_server_id_idx" ON "webhooks"("server_id");

-- CreateIndex
CREATE INDEX "webhooks_channel_id_idx" ON "webhooks"("channel_id");

-- CreateIndex
CREATE INDEX "messages_webhook_id_idx" ON "messages"("webhook_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
