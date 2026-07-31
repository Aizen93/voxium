-- A device that joined a Megolm session late exports its key from a LATER
-- ratchet index. Without storing that index, a last-writer-wins upsert lets
-- such a device overwrite an earlier device's key and permanently destroy the
-- ability to decrypt the messages in between.
--
-- Default 0 is the safe value for rows that already exist: it reads as "starts
-- at the beginning", so any later upload compares as a regression and is
-- refused rather than silently replacing a key that may cover more of the
-- session.
ALTER TABLE "e2e_message_key_backups"
  ADD COLUMN "first_known_index" INTEGER NOT NULL DEFAULT 0;
