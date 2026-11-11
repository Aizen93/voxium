import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findMany = vi.hoisted(() => vi.fn());
vi.mock('../../utils/prisma', () => ({ prisma: { messageAttachment: { findMany: (...a: unknown[]) => findMany(...a) } } }));

const deleteMultipleFromS3 = vi.hoisted(() => vi.fn());
vi.mock('../../utils/s3', async (importOriginal) => {
  // The real key shape: it is what decides which stored keys may be deleted
  const actual = await importOriginal<typeof import('../../utils/s3')>();
  return {
    VALID_ATTACHMENT_KEY_RE: actual.VALID_ATTACHMENT_KEY_RE,
    deleteMultipleFromS3: (...a: unknown[]) => deleteMultipleFromS3(...a),
  };
});

import { collectAttachmentKeys, deleteAttachmentBlobs, ATTACHMENT_KEY_BATCH } from '../../utils/attachmentBlobs';

const key = (i: number) => `attachments/ch-chan1/clmsg${i}-file${i}.png`;
const page = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `att-${String(from + i).padStart(6, '0')}`, s3Key: key(from + i) }));

describe('collectAttachmentKeys', () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it('reads the kept attachments of the selected messages, in id order, one bounded page at a time', async () => {
    findMany.mockResolvedValueOnce(page(0, 2));

    const keys = await collectAttachmentKeys({ channelId: 'chan1' });

    expect(keys).toEqual([key(0), key(1)]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { expired: false, message: { channelId: 'chan1' } },
      select: { id: true, s3Key: true },
      orderBy: { id: 'asc' },
      take: ATTACHMENT_KEY_BATCH,
    });
  });

  it('pages on an explicit id > last predicate until a short page', async () => {
    findMany
      .mockResolvedValueOnce(page(0, ATTACHMENT_KEY_BATCH))
      .mockResolvedValueOnce(page(ATTACHMENT_KEY_BATCH, ATTACHMENT_KEY_BATCH))
      .mockResolvedValueOnce(page(2 * ATTACHMENT_KEY_BATCH, 3));

    const keys = await collectAttachmentKeys({ conversationId: 'conv1' });

    expect(keys).toHaveLength(2 * ATTACHMENT_KEY_BATCH + 3);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[1][0].where).toEqual({
      expired: false, message: { conversationId: 'conv1' }, id: { gt: `att-${String(ATTACHMENT_KEY_BATCH - 1).padStart(6, '0')}` },
    });
    expect(findMany.mock.calls[2][0].where.id).toEqual({ gt: `att-${String(2 * ATTACHMENT_KEY_BATCH - 1).padStart(6, '0')}` });
    // Never an id list
    for (const [args] of findMany.mock.calls) expect(JSON.stringify(args)).not.toContain('"in"');
  });

  it('stops after one empty page', async () => {
    findMany.mockResolvedValueOnce([]);

    await expect(collectAttachmentKeys({ channel: { serverId: 'srv1' } })).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('never returns a stored key that is not an attachment key (an avatar, an icon, a path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      findMany.mockResolvedValueOnce([
        { id: 'att-1', s3Key: key(1) },
        { id: 'att-2', s3Key: 'avatars/user-1-1700000000000-0123456789ab.webp' },
        { id: 'att-3', s3Key: 'server-icons/srv-1.webp' },
        { id: 'att-4', s3Key: 'attachments/../avatars/x.webp' },
      ]);

      await expect(collectAttachmentKeys({ channelId: 'chan1' })).resolves.toEqual([key(1)]);
      expect(warn).toHaveBeenCalledTimes(3);
      // The key itself is never logged
      expect(JSON.stringify(warn.mock.calls)).not.toContain('avatars/');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('deleteAttachmentBlobs', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    deleteMultipleFromS3.mockReset().mockImplementation(async (keys: string[]) => keys.length);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('touches storage not at all without keys', () => {
    deleteAttachmentBlobs([], '[T]', 'channel c');

    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
  });

  it('starts the delete at once and returns without waiting for it', () => {
    let release: (n: number) => void = () => {};
    deleteMultipleFromS3.mockImplementationOnce(() => new Promise<number>((resolve) => { release = resolve; }));

    expect(deleteAttachmentBlobs([key(1), key(2)], '[T]', 'channel c')).toBeUndefined();

    expect(deleteMultipleFromS3).toHaveBeenCalledWith([key(1), key(2)]);
    release(2);
  });

  it('logs keys the store refused, without the keys', async () => {
    deleteMultipleFromS3.mockResolvedValueOnce(1);

    deleteAttachmentBlobs([key(1), key(2), key(3)], '[T]', 'channel c');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[T] 2 of 3 attachment file(s) of channel c were not deleted (the orphan sweep will reclaim them)'));
  });

  it('logs a storage failure with its message and never throws', async () => {
    deleteMultipleFromS3.mockRejectedValueOnce(new Error('S3 unavailable'));

    expect(() => deleteAttachmentBlobs([key(1)], '[T]', 'channel c')).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[T] Attachment file cleanup failed for channel c (the orphan sweep will reclaim them):', 'S3 unavailable'));
  });

  it('a storage client that throws synchronously is caught the same way', async () => {
    deleteMultipleFromS3.mockImplementationOnce(() => { throw new Error('no client'); });

    expect(() => deleteAttachmentBlobs([key(1)], '[T]', 'channel c')).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[T] Attachment file cleanup failed for channel c (the orphan sweep will reclaim them):', 'no client'));
  });
});
