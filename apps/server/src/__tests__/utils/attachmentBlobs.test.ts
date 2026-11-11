import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

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

  describe('a shape with more live files than one batch', () => {
    const lastId = (n: number) => `att-${String(n - 1).padStart(6, '0')}`;

    it('never repeats the shape join: it walks the live files after the first batch and filters each batch by primary key', async () => {
      const liveIds = (from: number, count: number) => page(from, count).map(({ id }) => ({ id }));
      findMany
        // 1. the shape, from its own indexes: a full batch
        .mockResolvedValueOnce(page(0, ATTACHMENT_KEY_BATCH))
        // 2. the next live files in id order: a full batch, of which 2 are the shape's
        .mockResolvedValueOnce(liveIds(ATTACHMENT_KEY_BATCH, ATTACHMENT_KEY_BATCH))
        .mockResolvedValueOnce([{ s3Key: key(1500) }, { s3Key: key(1600) }])
        // 3. the last, short batch of live files: 1 of them the shape's
        .mockResolvedValueOnce(liveIds(2 * ATTACHMENT_KEY_BATCH, 3))
        .mockResolvedValueOnce([{ s3Key: key(2001) }]);

      const keys = await collectAttachmentKeys({ conversationId: 'conv1' });

      expect(keys).toHaveLength(ATTACHMENT_KEY_BATCH + 3);
      expect(keys.slice(-3)).toEqual([key(1500), key(1600), key(2001)]);
      expect(findMany).toHaveBeenCalledTimes(5);
      // Only the first query joins the shape over its history
      expect(findMany.mock.calls[0][0].where).toEqual({ expired: false, message: { conversationId: 'conv1' } });
      // The walk: live rows only, after the last id seen, in id order, a batch at a time (the (expired, id) index)
      expect(findMany.mock.calls[1][0]).toEqual({
        where: { expired: false, id: { gt: lastId(ATTACHMENT_KEY_BATCH) } },
        select: { id: true }, orderBy: { id: 'asc' }, take: ATTACHMENT_KEY_BATCH,
      });
      expect(findMany.mock.calls[3][0].where).toEqual({ expired: false, id: { gt: lastId(2 * ATTACHMENT_KEY_BATCH) } });
      // The filter: by primary key, at most one batch of ids, and the shape
      const filter = findMany.mock.calls[2][0];
      expect(filter.where.id.in).toHaveLength(ATTACHMENT_KEY_BATCH);
      expect(filter.where).toEqual({ id: { in: expect.any(Array) }, expired: false, message: { conversationId: 'conv1' } });
      expect(filter.select).toEqual({ s3Key: true });
      expect(findMany.mock.calls[4][0].where.id.in).toHaveLength(3);
      // No query but the first carries the shape without an id list
      for (const [args] of findMany.mock.calls.slice(1)) expect(args.where.id).toBeDefined();
    });

    it('stops when the walk finds no live file left', async () => {
      findMany
        .mockResolvedValueOnce(page(0, ATTACHMENT_KEY_BATCH))
        .mockResolvedValueOnce([]);

      const keys = await collectAttachmentKeys({ channelId: 'chan1' });

      expect(keys).toHaveLength(ATTACHMENT_KEY_BATCH);
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('applies the key-shape check to the filtered batches too', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        findMany
          .mockResolvedValueOnce(page(0, ATTACHMENT_KEY_BATCH))
          .mockResolvedValueOnce([{ id: 'att-x' }])
          .mockResolvedValueOnce([{ s3Key: 'avatars/user-1-1700000000000-0123456789ab.webp' }]);

        const keys = await collectAttachmentKeys({ channelId: 'chan1' });

        expect(keys).toHaveLength(ATTACHMENT_KEY_BATCH);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
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

describe('the index the live-file reads rest on', () => {
  const SERVER = resolve(__dirname, '../../..');

  it('is declared on MessageAttachment, expired first, so the live rows are one range in id order', () => {
    const schema = readFileSync(resolve(SERVER, 'prisma/schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model MessageAttachment {'));
    expect(model.slice(0, model.indexOf('\n}'))).toContain('@@index([expired, id])');
  });

  it('is created by a migration, with the name Prisma derives for it (no drift for migrate)', () => {
    const dir = resolve(SERVER, 'prisma/migrations');
    const sql = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readFileSync(resolve(dir, e.name, 'migration.sql'), 'utf8'))
      .join('\n');
    expect(sql).toContain('CREATE INDEX "message_attachments_expired_id_idx" ON "message_attachments"("expired", "id");');
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
