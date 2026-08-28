-- Message-key backup (docs/e2e-always-on-plan.md §4.4): one opaque blob per
-- backed-up Megolm session, sealed client-side under an account-level message
-- backup key the server never sees. This is what makes history follow the
-- ACCOUNT instead of the device that received it. Purely additive: one new
-- table, no changes to any existing one.

-- CreateTable
CREATE TABLE "e2e_message_key_backups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "blob" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_message_key_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One row per session: re-uploading a session updates it in place rather than
-- accumulating a row per device that ever held the key.
CREATE UNIQUE INDEX "e2e_message_key_backups_user_id_session_id_key" ON "e2e_message_key_backups"("user_id", "session_id");

-- CreateIndex
CREATE INDEX "e2e_message_key_backups_user_id_conversation_id_idx" ON "e2e_message_key_backups"("user_id", "conversation_id");

-- AddForeignKey
-- Like e2e_key_backups, these rows are designed to outlive every device, so no
-- age sweep will ever reclaim them. Without the cascade a deleted account would
-- leave its entire sealed history-key set in the database indefinitely. Safe as
-- part of the create: the table is empty, so there are no orphans to clean up.
ALTER TABLE "e2e_message_key_backups"
  ADD CONSTRAINT "e2e_message_key_backups_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
