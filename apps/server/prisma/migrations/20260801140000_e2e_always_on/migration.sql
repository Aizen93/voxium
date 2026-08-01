-- Always-on E2E cutover (docs/e2e-always-on-plan.md §6.1).
--
-- Encryption stops being something a user turns on: every conversation is born
-- encrypted, and there is no plaintext path for DMs. The data model barely
-- moves — one column becomes NOT NULL — but the data does, and IRREVERSIBLY:
-- this migration deletes all DM message history and all E2E key material.
-- Take a snapshot first; there is no down migration and no rollback for the
-- rows below (plan §7.7.2 and the "Rollback" note at the end of §7).
--
-- Order matters: history goes before the column is tightened, and the E2E
-- tables are truncated last so no client can re-publish keys mid-migration.

-- 1. DM history goes (D1: DM messages ONLY — channel history is untouched, so
--    the WHERE clause is load-bearing, not an optimisation).
--
--    One statement is enough because everything hanging off a message is
--    handled by the FKs declared in schema.prisma:
--      · message_reactions.message_id    ON DELETE CASCADE
--      · message_attachments.message_id  ON DELETE CASCADE
--      · messages.reply_to_id (self)     ON DELETE SET NULL
--      · reports.message_id              ON DELETE SET NULL
--    Conversations, friendships and ConversationRead rows for conversations
--    survive — nobody loses their contact list, they lose their history.
--
--    Two consequences worth stating out loud:
--      · reports that pointed at a DM message keep their reporter-attested
--        `message_content` copy but lose the `message_id` link (D4).
--      · attachment blobs in S3 are orphaned by the cascade, PERMANENTLY. The
--        daily job in utils/attachmentCleanup.ts cannot reclaim them: it walks
--        message_attachments ROWS, and this DELETE removes the rows. Capture
--        the keys BEFORE running this migration —
--          SELECT s3_key FROM message_attachments
--           WHERE message_id IN (SELECT id FROM messages
--                                 WHERE conversation_id IS NOT NULL);
--        — or sweep the attachments/dm-* prefix in the bucket afterwards.
DELETE FROM "messages" WHERE "conversation_id" IS NOT NULL;

-- 1b. Read markers point at messages that no longer exist. Without this every
--     DM shows a stale unread state on first load after cutover.
DELETE FROM "conversation_reads";

-- 2. Every conversation is encrypted, from now and retroactively. The UPDATE
--    has to run BEFORE the SET NOT NULL — existing rows are null for every
--    conversation whose participants never clicked the old toggle.
--
--    NOW() is what Prisma's `@default(now())` compiles to (Postgres parses
--    CURRENT_TIMESTAMP and NOW() to the same `now()` expression), so the
--    schema and the database agree after this runs.
UPDATE "conversations" SET "encrypted_at" = NOW() WHERE "encrypted_at" IS NULL;
ALTER TABLE "conversations" ALTER COLUMN "encrypted_at" SET NOT NULL;
ALTER TABLE "conversations" ALTER COLUMN "encrypted_at" SET DEFAULT NOW();

-- 3. Every account re-registers its E2E identity cleanly (the §12.7 pattern).
--    The wipe above removed every ciphertext these keys could ever decrypt, so
--    keeping them would only preserve identities pinned against history that
--    no longer exists — and clients bootstrap a fresh vault on next launch
--    (plan §6.2 bumps the IndexedDB name, so stale device state cannot
--    survive on the client either).
--
--    TRUNCATE, not DELETE: these tables have no rows worth keeping and
--    TRUNCATE does not have to walk them.
--
--    e2e_one_time_keys is in the list because it carries the only FK INTO
--    e2e_devices (ON DELETE CASCADE); Postgres refuses to truncate a
--    referenced table unless the referencing one is truncated in the same
--    statement. Listing it explicitly is deliberate — CASCADE would let a
--    future FK silently drag an unrelated table in with it.
--
--    The table is named e2e_device_registry (singular) — @@map in
--    schema.prisma, not the pluralised model name.
--
--    !! TRUNCATE "e2e_key_backups" DESTROYS RECOVERY KEYS USERS HAVE WRITTEN
--    !! DOWN. That is intended: those blobs seal cross-signing master secrets
--    !! that will not exist after this statement, so a recovery key restored
--    !! from a pre-cutover backup would yield an identity nothing recognises.
--    !! Every user must be told, before the window, that their existing
--    !! recovery key stops working and a new one must be generated after
--    !! cutover (plan §7.6 — this is a product communication, not a
--    !! changelog line). Same for e2e_message_key_backups: the backed-up
--    !! Megolm keys unlock messages that step 1 just deleted.
TRUNCATE "e2e_key_shares",
         "e2e_master_transfers",
         "e2e_key_backups",
         "e2e_message_key_backups",
         "e2e_master_keys",
         "e2e_device_registry",
         "e2e_one_time_keys",
         "e2e_devices";
