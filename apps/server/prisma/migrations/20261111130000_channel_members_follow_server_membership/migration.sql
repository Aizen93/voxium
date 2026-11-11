-- A secure channel's ChannelMember rows exist only while their user is a
-- member of the channel's space: access to the channel is derived from the
-- row alone. The application now removes them in the transaction that ends a
-- membership; this removes the rows that outlived one before it did.
--
-- Data only, no schema change. One statement: it takes row locks on the rows
-- it deletes and nothing else, so it is safe on a live database. Idempotent:
-- a second run matches nothing. A row being written concurrently belongs to a
-- current member (the writer holds a lock on that membership row), so the
-- NOT EXISTS keeps it.
DELETE FROM "channel_members" cm
USING "channels" c
WHERE c."id" = cm."channel_id"
  AND NOT EXISTS (
    SELECT 1 FROM "server_members" sm
    WHERE sm."user_id" = cm."user_id"
      AND sm."server_id" = c."server_id"
  );
