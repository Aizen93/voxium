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
 * Expired rows are skipped: their file is already gone
 * (utils/attachmentCleanup.ts deletes it before it marks the row), and they
 * are kept forever, so they are most of the table. Every query here reads
 * only live rows through the `(expired, id)` index and never walks that
 * history. Memory is bounded by ATTACHMENT_KEY_BATCH rows per query, and the
 * work never repeats per batch:
 *
 *  1. ONE query from the shape's own indexes (a space's channels, a channel's
 *     or a conversation's messages, an author's messages). A shape with fewer
 *     live files than a batch, nearly every one, is done.
 *  2. A shape with more: instead of repeating that join for every further
 *     batch, the live files after the first batch are walked in id order, a
 *     batch at a time (an index range scan on `(expired, id)`), and each batch
 *     is filtered to the shape by primary key (an `IN` list of at most one
 *     batch of ids). The work is then bounded by the files still kept, the
 *     retention window, never by the shape's history.
 *
 * Pass a shape that starts from an indexed column; an OR across joined
 * tables starts from none (accountDeletion.ts makes one call per column).
 * Only keys of the attachment shape are returned, so a row can never steer
 * the delete onto an avatar, an icon or anything else in the bucket.
 */
export async function collectAttachmentKeys(messages: Prisma.MessageWhereInput): Promise<string[]> {
  const keys: string[] = [];
  const keep = (rows: { s3Key: string }[]) => {
    for (const row of rows) {
      if (VALID_ATTACHMENT_KEY_RE.test(row.s3Key)) keys.push(row.s3Key);
      else console.warn('[Attachments] Skipping a stored attachment key of an unexpected shape');
    }
  };

  const first = await prisma.messageAttachment.findMany({
    where: { expired: false, message: messages },
    select: { id: true, s3Key: true },
    orderBy: { id: 'asc' },
    take: ATTACHMENT_KEY_BATCH,
  });
  keep(first);
  if (first.length < ATTACHMENT_KEY_BATCH) return keys;

  let after = first[first.length - 1].id;
  for (;;) {
    const live = await prisma.messageAttachment.findMany({
      where: { expired: false, id: { gt: after } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: ATTACHMENT_KEY_BATCH,
    });
    if (live.length === 0) return keys;
    keep(await prisma.messageAttachment.findMany({
      where: { id: { in: live.map((row) => row.id) }, expired: false, message: messages },
      select: { s3Key: true },
    }));
    if (live.length < ATTACHMENT_KEY_BATCH) return keys;
    after = live[live.length - 1].id;
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
