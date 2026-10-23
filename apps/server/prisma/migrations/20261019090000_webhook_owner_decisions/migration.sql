-- Incoming webhooks: the owner decisions of 2026-10-19 (release 2.1.0, A.4).
--
-- admin_disabled_at   a platform admin's disable is sticky while set: the
--                     owner's PATCH { enabled: true } answers 403, the admin's
--                     enable clears it.
-- creator_removed_at  a kick or ban of the member who held the live URL (the
--                     creator, or whoever rotated it last) disabled the webhook
--                     and left this mark (the URL may have left with them); any
--                     enable, the owner's or an admin's, or a rotate clears it.
-- last_rotated_at,    who rotated the credential last, and when; SET NULL when
-- last_rotated_by_id  the account goes (like created_by_id).
--
-- Four nullable columns without defaults (catalog-only, one short ACCESS
-- EXCLUSIVE lock on "webhooks") and one FK, whose creation scans the small
-- "webhooks" table (every value NULL) under a brief SHARE ROW EXCLUSIVE lock
-- on both "webhooks" and "users". No backfill.

ALTER TABLE "webhooks"
  ADD COLUMN "admin_disabled_at" TIMESTAMP(3),
  ADD COLUMN "creator_removed_at" TIMESTAMP(3),
  ADD COLUMN "last_rotated_at" TIMESTAMP(3),
  ADD COLUMN "last_rotated_by_id" TEXT;

ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_last_rotated_by_id_fkey"
  FOREIGN KEY ("last_rotated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
