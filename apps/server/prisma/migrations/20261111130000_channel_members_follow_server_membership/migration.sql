-- A secure channel's ChannelMember rows exist only while their user is a
-- member of the channel's space: access to the channel is derived from the
-- row alone. The application now removes a user's rows in the transaction
-- that ends the membership, and a join starts with none; this removes the
-- rows that outlived a membership before it did, and the key shares
-- addressed through them.
--
-- Data only, no schema change. Each statement locks only the rows it
-- deletes, so it is safe on a live database, and both are idempotent: a
-- second run matches nothing. A row being written concurrently belongs to a
-- current member (its writer holds a lock on that membership row), so the
-- NOT EXISTS keeps it.
--
-- No channel is deleted. A secure channel whose creator is no longer a
-- member of its space loses the creator's row like any other and stays for
-- its remaining members; the space's owner and administrators can still
-- delete it by id.

-- 1. The rows no membership of the channel's space backs: the user is not a
--    member of the space, or their current membership began AFTER the row
--    was written (a row from an earlier membership, honoured again after a
--    rejoin). A row is written only after its user's membership row
--    committed (the writer locks that row first), so a row of the current
--    membership is not older than it; an equal timestamp is kept.
--    Both columns are filled by the APPLICATION's clock, not the database's
--    (Prisma writes `@default(now())` itself): the comparison is only as good
--    as the writers' clocks, the clocks of every server process that wrote a
--    membership or an invitation. Behind several instances, one instance's
--    clock running behind another's, or any clock stepped backwards, between
--    a join and a later invite could make a legitimate row look older than
--    its membership: that row would be deleted, its member losing access
--    until invited again. Nothing is exposed either way: the predicate only
--    ever removes access, and the migration runs once.
DELETE FROM "channel_members" cm
USING "channels" c
WHERE c."id" = cm."channel_id"
  AND NOT EXISTS (
    SELECT 1 FROM "server_members" sm
    WHERE sm."user_id" = cm."user_id"
      AND sm."server_id" = c."server_id"
      AND sm."joined_at" <= cm."added_at"
  );

-- 2. The channel-scope key shares (`ch:{channelId}`) whose recipient holds
--    no row in that channel, after (1). `chv:` voice scopes and DM scopes do
--    not match the prefix.
DELETE FROM "e2e_key_shares" ks
WHERE ks."conversation_id" LIKE 'ch:%'
  AND NOT EXISTS (
    SELECT 1 FROM "channel_members" cm
    WHERE cm."channel_id" = substr(ks."conversation_id", 4)
      AND cm."user_id" = ks."recipient_user_id"
  );

-- Read-only counts an operator can run BEFORE applying this migration:
--
-- Rows whose user is not a member of the channel's space:
--   SELECT count(*) FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
--   WHERE NOT EXISTS (SELECT 1 FROM server_members sm
--                     WHERE sm.user_id = cm.user_id AND sm.server_id = c.server_id);
--
-- Rows older than their user's current membership of the space:
--   SELECT count(*) FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
--   JOIN server_members sm ON sm.user_id = cm.user_id AND sm.server_id = c.server_id
--   WHERE sm.joined_at > cm.added_at;
--
-- Secure channels whose creator is not a member of the space (they stay):
--   SELECT count(*) FROM channels c
--   WHERE c.secure AND NOT EXISTS (SELECT 1 FROM server_members sm
--                                  WHERE sm.user_id = c.created_by_id AND sm.server_id = c.server_id);
--
-- Channel-scope key shares statement 2 will remove (counted against the rows
-- that survive statement 1):
--   SELECT count(*) FROM e2e_key_shares ks
--   WHERE ks.conversation_id LIKE 'ch:%'
--     AND NOT EXISTS (SELECT 1 FROM channel_members cm
--                     JOIN channels c ON c.id = cm.channel_id
--                     JOIN server_members sm ON sm.user_id = cm.user_id AND sm.server_id = c.server_id
--                                           AND sm.joined_at <= cm.added_at
--                     WHERE cm.channel_id = substr(ks.conversation_id, 4)
--                       AND cm.user_id = ks.recipient_user_id);
