-- The 30-day retention sweep deletes master transfers by age across all
-- recipients; the composite index is recipient-scoped and cannot serve it.
CREATE INDEX "e2e_master_transfers_created_at_idx" ON "e2e_master_transfers"("created_at");
