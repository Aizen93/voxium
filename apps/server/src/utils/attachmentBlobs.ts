import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import { deleteMultipleFromS3, VALID_ATTACHMENT_KEY_RE } from './s3';

/** Attachment rows read per query while collecting the keys of a delete. */
export const ATTACHMENT_KEY_BATCH = 1000;

/**
 * The object-storage keys of the attachments on the messages `messages`
 * selects, read BEFORE a delete whose cascade takes those rows: once the
 * rows are gone nothing names the files any more, and only the nightly
 * orphan sweep would find them, a week later.
 *
 * Bounded per query: id-keyset batches of ATTACHMENT_KEY_BATCH (an explicit
 * `id > last` predicate, never an `IN (...)` list of ids). Expired rows are
 * skipped, their file is already gone (utils/attachmentCleanup.ts deletes it
 * before it marks the row), which bounds the result to the files still kept.
 * Only keys of the attachment shape are returned, so a row can never steer
 * the delete onto an avatar, an icon or anything else in the bucket.
 */
export async function collectAttachmentKeys(messages: Prisma.MessageWhereInput): Promise<string[]> {
  const keys: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await prisma.messageAttachment.findMany({
      where: { expired: false, message: messages, ...(after !== undefined && { id: { gt: after } }) },
      select: { id: true, s3Key: true },
      orderBy: { id: 'asc' },
      take: ATTACHMENT_KEY_BATCH,
    });
    for (const row of page) {
      if (VALID_ATTACHMENT_KEY_RE.test(row.s3Key)) keys.push(row.s3Key);
      else console.warn('[Attachments] Skipping a stored attachment key of an unexpected shape');
    }
    if (page.length < ATTACHMENT_KEY_BATCH) return keys;
    after = page[page.length - 1].id;
  }
}

/**
 * Delete the files of attachment rows that are already gone. Call it only
 * AFTER the delete that removed the rows committed, so a failed delete never
 * leaves a live message pointing at a missing file. Never awaited by the
 * caller and never throws: a storage failure is logged and the orphan sweep
 * (utils/orphanCleanup.ts) is the backstop.
 */
export function deleteAttachmentBlobs(keys: string[], logPrefix: string, what: string): void {
  if (keys.length === 0) return;
  // Started now (the request is not kept waiting on storage), finished in
  // the background; a synchronous throw lands in the same catch
  void (async () => {
    try {
      const deleted = await deleteMultipleFromS3(keys);
      if (deleted < keys.length) {
        console.warn(`${logPrefix} ${keys.length - deleted} of ${keys.length} attachment file(s) of ${what} were not deleted (the orphan sweep will reclaim them)`);
      }
    } catch (err) {
      console.warn(`${logPrefix} Attachment file cleanup failed for ${what} (the orphan sweep will reclaim them):`, err instanceof Error ? err.message : err);
    }
  })();
}
