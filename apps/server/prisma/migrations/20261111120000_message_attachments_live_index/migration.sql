-- Deletes read the keys of the attachment files still kept (`expired = false`)
-- before their cascade takes the rows (utils/attachmentBlobs.ts). Expired rows
-- are kept forever for the "File expired" placeholder, so they are most of the
-- table, and no index held `expired`: every such read filtered the table's
-- whole history. With `expired` leading, the live rows are one contiguous range
-- in id order. Written as Prisma generates it for `@@index([expired, id])`
-- (`prisma migrate diff --from-schema … --to-schema … --script`).
CREATE INDEX "message_attachments_expired_id_idx" ON "message_attachments"("expired", "id");
