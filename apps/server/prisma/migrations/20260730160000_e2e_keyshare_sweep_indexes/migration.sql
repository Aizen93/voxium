-- The 30-day retention sweep deletes by createdAt across all recipients; the
-- existing composite index is recipient-scoped and cannot serve it, so every
-- sweep was a full scan of a table any account can add rows to.
CREATE INDEX "e2e_key_shares_created_at_idx" ON "e2e_key_shares"("created_at");

-- Backs the per-sender ceiling checked on every POST /e2e/keyshares.
CREATE INDEX "e2e_key_shares_sender_user_id_idx" ON "e2e_key_shares"("sender_user_id");
