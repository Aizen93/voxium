-- The presence reaper reads every user the column calls online once a minute
-- (`WHERE status = 'online'`): without an index that is a sequential scan of the
-- users table on every tick. Almost every row is offline, so the index is small.
CREATE INDEX "users_status_idx" ON "users"("status");
