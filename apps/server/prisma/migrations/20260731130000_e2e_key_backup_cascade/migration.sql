-- A key backup is the one E2E row designed to outlive every device, so no age
-- sweep can ever reclaim it. Without this cascade a deleted account would leave
-- its sealed account master secret in the database indefinitely.
--
-- Safe as a standalone step: the table was created empty in the immediately
-- preceding migration, so there are no orphans to clean up first.
ALTER TABLE "e2e_key_backups"
  ADD CONSTRAINT "e2e_key_backups_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
