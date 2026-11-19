import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock auth middleware
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
  requireConsent: (_req: any, _res: any, next: any) => next(),
}));

// Mock rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitUpload: passthrough,
    rateLimitGeneral: passthrough,
    rateLimitAttachmentRead: passthrough,
  };
});

// Mock S3
const mockPresignedGetUrl = 'https://s3.example.com/signed-get-url';
const mockPresignedPutUrl = 'https://s3.example.com/signed-put-url';

vi.mock('../../utils/s3', async () => ({
  // The real formatter: the log assertions below must hold for what it prints
  describeStoreError: (await vi.importActual<typeof import('../../utils/s3')>('../../utils/s3')).describeStoreError,
  generatePresignedPutUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed-put-url'),
  generatePresignedGetUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed-get-url'),
  getS3Object: vi.fn().mockResolvedValue({
    Body: Readable.from(Buffer.from('data')),
    ContentType: 'image/webp',
    ContentLength: 1024,
  }),
  VALID_S3_KEY_RE: /^(avatars|server-icons)\/[\w-]+\.webp$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
}));

// Mock permission calculator — allow by default
vi.mock('../../utils/permissionCalculator', () => ({
  hasServerPermission: vi.fn().mockResolvedValue(true),
  hasChannelPermission: vi.fn().mockResolvedValue(true),
  Permissions: {
    MANAGE_SERVER: 1n << 3n,
    ATTACH_FILES: 1n << 11n,
  },
}));

// Mock Prisma
vi.mock('../../utils/prisma', () => ({
  prisma: {
    server: { findUnique: vi.fn() },
    channel: { findUnique: vi.fn() },
    serverMember: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn() },
    messageAttachment: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from '../../utils/prisma';
import { uploadRouter } from '../../routes/uploads';
import { errorHandler } from '../../middleware/errorHandler';
import { generatePresignedGetUrl, generatePresignedPutUrl, getS3Object } from '../../utils/s3';
import { LIMITS } from '@voxium/shared';

// ─── App setup ──────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/uploads', uploadRouter);
  app.use(errorHandler);
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('uploads — GET /avatars/* (public redirect)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to S3 presigned URL for valid avatar key', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/avatars/user-123.webp');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(mockPresignedGetUrl);
    expect(generatePresignedGetUrl).toHaveBeenCalledWith('avatars/user-123.webp');
    // Keys are immutable and the signed link lives an hour: the browser keeps
    // the redirect for most of it instead of asking again per avatar on screen
    expect(res.headers['cache-control']).toBe('private, max-age=3000');
  });

  it('rejects key with path traversal (..)', async () => {
    const app = createApp();
    // Express may normalize ../ in the URL path, so the route may not even match.
    // Either way, the request should not succeed.
    const res = await request(app).get('/api/v1/uploads/avatars/../etc/passwd');

    // Either 400 (caught by key validation) or 404 (path resolved away from route)
    expect([400, 404]).toContain(res.status);
  });

  it('rejects invalid key format', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/invalid-prefix/file.webp');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid key/i);
  });

  it('rejects key with wrong extension', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/avatars/user-123.png');

    expect(res.status).toBe(400);
  });
});

describe('uploads — GET /server-icons/* with ?inline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies image directly when ?inline is set', async () => {
    const imgData = Buffer.alloc(8, 0);
    const body = Readable.from([imgData]);
    const mockPipe = vi.spyOn(body, 'pipe');
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: body,
      ContentType: 'image/webp',
      ContentLength: imgData.length,
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/server-icons/srv-123.webp?inline');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cache-control']).toBe('public, max-age=86400, immutable');
    expect(getS3Object).toHaveBeenCalledWith('server-icons/srv-123.webp');
    expect(mockPipe).toHaveBeenCalled();
  });
});

describe('uploads — GET /attachments/* (authorized proxy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies attachment for authorized server member', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: false,
      message: {
        channelId: 'ch-1',
        conversationId: null,
        channel: { serverId: 'srv-1' },
      },
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv-1' } as any);
    const fileData = Buffer.alloc(64, 0);
    const body = Readable.from([fileData]);
    const mockPipe = vi.spyOn(body, 'pipe');
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: body,
      ContentType: 'application/pdf',
      ContentLength: fileData.length,
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/attachments/ch-abc/xyz-file.pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(getS3Object).toHaveBeenCalledWith('attachments/ch-abc/xyz-file.pdf');
  });

  it('returns 404 when attachment not found in DB', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/attachments/ch-abc/xyz-file.pdf');

    expect(res.status).toBe(404);
  });

  it('returns 404 when attachment is expired', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: true,
      message: { channelId: 'ch-1', conversationId: null, channel: { serverId: 'srv-1' } },
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/attachments/ch-abc/xyz-file.pdf');

    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not a server member', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: false,
      message: { channelId: 'ch-1', conversationId: null, channel: { serverId: 'srv-1' } },
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/attachments/ch-abc/xyz-file.pdf');

    expect(res.status).toBe(403);
  });

  it('rejects attachment key with path traversal', async () => {
    const app = createApp();
    // Express may normalize ../../../ before routing, so test with encoded dots
    // or with .. embedded in a segment that won't be normalized
    const res = await request(app).get('/api/v1/uploads/attachments/ch-abc%2F..%2F..%2Fetc/passwd');

    // Should be 400 (invalid key format) or 404 (path normalized away)
    expect([400, 404]).toContain(res.status);
  });

  it('proxies DM attachment for conversation participant', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: false,
      message: { channelId: null, conversationId: 'conv-1', channel: null },
    } as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2', reads: [],
    } as any);
    const dmData = Buffer.alloc(32, 0);
    const body = Readable.from([dmData]);
    const mockPipe = vi.spyOn(body, 'pipe');
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: body,
      ContentType: 'image/png',
      ContentLength: dmData.length,
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/attachments/dm-conv1/abc-image.png');

    expect(res.status).toBe(200);
    expect(getS3Object).toHaveBeenCalledWith('attachments/dm-conv1/abc-image.png');
  });

  it('returns 403 for DM attachment when not a participant', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: false,
      message: { channelId: null, conversationId: 'conv-1', channel: null },
    } as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      id: 'conv-1', user1Id: 'other-1', user2Id: 'other-2',
    } as any);

    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/attachments/dm-conv1/abc-image.png');

    expect(res.status).toBe(403);
  });

  describe('a file of a message the caller cleared from their history (#47)', () => {
    const floor = new Date('2026-11-10T10:00:00.000Z');
    const attachmentOf = (createdAt: Date) => ({
      expired: false,
      message: { channelId: null, conversationId: 'conv-1', createdAt, channel: null },
    });
    const conversationWith = (reads: unknown[]) => ({ id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2', reads });
    const stored = () => vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: Readable.from([Buffer.alloc(8, 0)]),
      ContentType: 'application/octet-stream',
      ContentLength: 8,
    } as any);

    it('reads the message time with the file, and the caller\'s floor with the conversation (one helper)', async () => {
      vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce(attachmentOf(new Date('2026-11-11T00:00:00Z')) as any);
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversationWith([]) as any);
      stored();

      await request(createApp()).get('/api/v1/uploads/attachments/dm-conv1/abc-encrypted.bin');

      expect((vi.mocked(prisma.messageAttachment.findFirst).mock.calls[0][0] as any).select.message.select.createdAt).toBe(true);
      expect(vi.mocked(prisma.conversation.findUnique).mock.calls[0][0]).toEqual({
        where: { id: 'conv-1' },
        select: { id: true, user1Id: true, user2Id: true, reads: { select: { userId: true, hiddenAt: true, clearedAt: true } } },
      });
    });

    it('a message at or below the caller\'s floor: answered like a missing attachment, never read from the store', async () => {
      for (const createdAt of [new Date('2026-11-09T00:00:00Z'), floor]) {
        vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce(attachmentOf(createdAt) as any);
        vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversationWith([{ userId: 'user-1', hiddenAt: null, clearedAt: floor }]) as any);
        const res = await request(createApp()).get('/api/v1/uploads/attachments/dm-conv1/abc-encrypted.bin');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Attachment not found');
      }
      expect(getS3Object).not.toHaveBeenCalled();
    });

    it('a message above the caller\'s floor is served; the other person\'s floor changes nothing for the caller', async () => {
      vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce(attachmentOf(new Date('2026-11-11T00:00:00Z')) as any);
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversationWith([{ userId: 'user-1', hiddenAt: null, clearedAt: floor }]) as any);
      stored();
      expect((await request(createApp()).get('/api/v1/uploads/attachments/dm-conv1/abc-encrypted.bin')).status).toBe(200);

      vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce(attachmentOf(new Date('2026-11-09T00:00:00Z')) as any);
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce(conversationWith([{ userId: 'user-2', hiddenAt: null, clearedAt: floor }]) as any);
      stored();
      expect((await request(createApp()).get('/api/v1/uploads/attachments/dm-conv1/abc-encrypted.bin')).status).toBe(200);
    });
  });
});

describe('uploads — POST /presign/avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a presigned PUT URL signed for the declared size', async () => {
    const app = createApp();
    const res = await request(app).post('/api/v1/uploads/presign/avatar').send({ fileSize: 23_456 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.uploadUrl).toBe(mockPresignedPutUrl);
    expect(res.body.data.key).toMatch(/^avatars\/user-1-\d+\.webp$/);
    expect(generatePresignedPutUrl).toHaveBeenCalledWith(res.body.data.key, 'image/webp', 23_456);
  });

  it('accepts exactly the avatar cap', async () => {
    const res = await request(createApp()).post('/api/v1/uploads/presign/avatar').send({ fileSize: LIMITS.MAX_AVATAR_SIZE });

    expect(res.status).toBe(200);
    expect(generatePresignedPutUrl).toHaveBeenCalledWith(expect.any(String), 'image/webp', LIMITS.MAX_AVATAR_SIZE);
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 10.5],
    ['a string', '1024'],
    ['over the cap', LIMITS.MAX_AVATAR_SIZE + 1],
    ['several GB', 5 * 1024 * 1024 * 1024],
  ])('refuses a %s fileSize without signing anything', async (_label, fileSize) => {
    const res = await request(createApp()).post('/api/v1/uploads/presign/avatar').send(fileSize === undefined ? {} : { fileSize });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid file size \(max 0\.5MB\)$/);
    expect(generatePresignedPutUrl).not.toHaveBeenCalled();
  });
});

describe('uploads — POST /presign/server-icon/:serverId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns presigned PUT URL for server owner', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValueOnce({
      id: 'srv-1', ownerId: 'user-1', name: 'Test Server',
    } as any);

    const app = createApp();
    const res = await request(app).post('/api/v1/uploads/presign/server-icon/srv-1').send({ fileSize: 4096 });

    expect(res.status).toBe(200);
    expect(res.body.data.key).toMatch(/^server-icons\/srv-1-\d+\.webp$/);
    expect(generatePresignedPutUrl).toHaveBeenCalledWith(res.body.data.key, 'image/webp', 4096);
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['fractional', 1.25],
    ['over the cap', LIMITS.MAX_SERVER_ICON_SIZE + 1],
  ])('refuses a %s fileSize before any lookup or signature', async (_label, fileSize) => {
    const res = await request(createApp())
      .post('/api/v1/uploads/presign/server-icon/srv-1')
      .send(fileSize === undefined ? {} : { fileSize });

    expect(res.status).toBe(400);
    expect(prisma.server.findUnique).not.toHaveBeenCalled();
    expect(generatePresignedPutUrl).not.toHaveBeenCalled();
  });

  it('returns 403 for user without MANAGE_SERVER permission', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValueOnce({
      id: 'srv-1', ownerId: 'other-user', name: 'Test Server',
    } as any);
    const { hasServerPermission } = await import('../../utils/permissionCalculator');
    vi.mocked(hasServerPermission).mockResolvedValueOnce(false);

    const app = createApp();
    const res = await request(app).post('/api/v1/uploads/presign/server-icon/srv-1').send({ fileSize: 4096 });

    expect(res.status).toBe(403);
    expect(generatePresignedPutUrl).not.toHaveBeenCalled();
  });

  it('returns 404 for non-existent server', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app).post('/api/v1/uploads/presign/server-icon/srv-nonexistent').send({ fileSize: 4096 });

    expect(res.status).toBe(404);
  });
});

describe('uploads — GET /* Express 5 Array.isArray wildcard path fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('correctly joins multi-segment avatar paths (Array.isArray path)', async () => {
    const app = createApp();
    // This tests the path like avatars/user-123.webp where Express 5 may
    // return req.params.path as an array of segments
    const res = await request(app).get('/api/v1/uploads/avatars/user-123.webp');

    expect(res.status).toBe(302);
    expect(generatePresignedGetUrl).toHaveBeenCalledWith('avatars/user-123.webp');
  });

  it('correctly joins multi-segment server-icon paths', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/server-icons/srv-456.webp');

    expect(res.status).toBe(302);
    expect(generatePresignedGetUrl).toHaveBeenCalledWith('server-icons/srv-456.webp');
  });

  it('rejects invalid key that does not match VALID_S3_KEY_RE', async () => {
    const app = createApp();
    // Keys outside the expected format (avatars/*.webp, server-icons/*.webp) are rejected
    const res = await request(app).get('/api/v1/uploads/random-dir/file.txt');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid key/i);
  });

  it('correctly joins multi-segment attachment paths (Array.isArray fix)', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: false,
      message: {
        channelId: 'ch-1',
        conversationId: null,
        channel: { serverId: 'srv-1' },
      },
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv-1' } as any);
    const fileData = Buffer.alloc(16, 0);
    const body = Readable.from([fileData]);
    const mockPipe = vi.spyOn(body, 'pipe');
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: body,
      ContentType: 'application/pdf',
      ContentLength: fileData.length,
    } as any);

    const app = createApp();
    // Multi-segment path: ch-abc/xyz-file.pdf
    const res = await request(app).get('/api/v1/uploads/attachments/ch-abc/xyz-file.pdf');

    expect(res.status).toBe(200);
    // The key should be properly joined with the attachments/ prefix
    expect(getS3Object).toHaveBeenCalledWith('attachments/ch-abc/xyz-file.pdf');
  });

  it('blocks path traversal in attachment paths', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/uploads/attachments/../../../etc/passwd');

    // Either 400 (invalid key) or 404 (path normalized away by Express)
    expect([400, 404]).toContain(res.status);
  });
});

describe('uploads — POST /presign/attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns presigned URL for channel attachment', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ id: 'ch-1', serverId: 'srv-1' } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv-1' } as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({
        fileName: 'report.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        channelId: 'ch-1',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.key).toMatch(/^attachments\/ch-ch-1\//);
    // The URL is signed for exactly the declared size
    expect(generatePresignedPutUrl).toHaveBeenCalledWith(res.body.data.key, 'application/pdf', 1024);
  });

  it('refuses a fractional or oversized declared size without signing anything', async () => {
    const app = createApp();
    const base = { fileName: 'report.pdf', mimeType: 'application/pdf', channelId: 'ch-1' };

    let res = await request(app).post('/api/v1/uploads/presign/attachment').send({ ...base, fileSize: 1024.5 });
    expect(res.status).toBe(400);

    res = await request(app).post('/api/v1/uploads/presign/attachment').send({ ...base, fileSize: LIMITS.MAX_ATTACHMENT_SIZE + 1 });
    expect(res.status).toBe(400);

    // Video keeps its larger per-type maximum
    res = await request(app).post('/api/v1/uploads/presign/attachment')
      .send({ ...base, fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: LIMITS.MAX_VIDEO_ATTACHMENT_SIZE + 1 });
    expect(res.status).toBe(400);

    res = await request(app).post('/api/v1/uploads/presign/attachment')
      .send({ ...base, fileName: 'encrypted.bin', mimeType: 'application/octet-stream', encrypted: true, fileSize: 99.9 });
    expect(res.status).toBe(400);

    expect(generatePresignedPutUrl).not.toHaveBeenCalled();
  });

  it('signs a video attachment up to the video maximum', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValueOnce({ id: 'ch-1', serverId: 'srv-1' } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv-1' } as any);

    const res = await request(createApp()).post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'clip.mp4', fileSize: LIMITS.MAX_VIDEO_ATTACHMENT_SIZE, mimeType: 'video/mp4', channelId: 'ch-1' });

    expect(res.status).toBe(200);
    expect(generatePresignedPutUrl).toHaveBeenCalledWith(res.body.data.key, 'video/mp4', LIMITS.MAX_VIDEO_ATTACHMENT_SIZE);
  });

  it('rejects when neither channelId nor conversationId provided', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'report.pdf', fileSize: 1024, mimeType: 'application/pdf' });

    expect(res.status).toBe(400);
  });

  it('presigns E2E attachments as opaque blobs — real file name never reaches the S3 key', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({
      id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2',
    } as any);

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({
        fileName: 'encrypted.bin',
        fileSize: 8 * 1024 * 1024 + 16, // ciphertext above the plain 8MB cap — allowed for E2E
        mimeType: 'application/octet-stream',
        conversationId: 'conv-1',
        encrypted: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.key).toMatch(/^attachments\/dm-conv-1\/[a-f0-9]{16}-encrypted\.bin$/);
  });

  it('rejects E2E presigns with a non-opaque mime, oversized ciphertext, or channel context', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2',
    } as any);
    const app = createApp();
    const base = { fileName: 'encrypted.bin', fileSize: 1024, conversationId: 'conv-1', encrypted: true };

    let res = await request(app).post('/api/v1/uploads/presign/attachment')
      .send({ ...base, mimeType: 'image/png' });
    expect(res.status).toBe(400);

    res = await request(app).post('/api/v1/uploads/presign/attachment')
      .send({ ...base, mimeType: 'application/octet-stream', fileSize: 12 * 1024 * 1024 + 17 });
    expect(res.status).toBe(400);

    // Channel context: E2E presigns are rejected for PLAINTEXT channels (the
    // check now lives in the auth block, where the channel row is available)
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({
      serverId: 'srv-1', secure: false,
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({
      userId: 'user-1', serverId: 'srv-1',
    } as any);
    res = await request(app).post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'encrypted.bin', fileSize: 1024, mimeType: 'application/octet-stream', channelId: 'ch-1', encrypted: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/direct messages/i);
  });

  it('SECURE channels: accepts E2E presigns (opaque key) and rejects plaintext presigns', async () => {
    const app = createApp();
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({
      serverId: 'srv-1', secure: true,
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValue({
      userId: 'user-1', serverId: 'srv-1',
    } as any);

    // Encrypted presign works, key never carries the real file name
    let res = await request(app).post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'my-secret-doc.pdf', fileSize: 1024, mimeType: 'application/octet-stream', channelId: 'sec-1', encrypted: true });
    expect(res.status).toBe(200);
    expect(res.body.data.key).toMatch(/^attachments\/ch-sec-1\/[a-f0-9]{16}-encrypted\.bin$/);
    expect(res.body.data.key).not.toContain('my-secret-doc');

    // A plaintext presign into a secure channel is a hard 400
    res = await request(app).post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'doc.pdf', fileSize: 1024, mimeType: 'application/pdf', channelId: 'sec-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end-to-end encrypted/i);
  });

  it('rejects disallowed file types', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({
        fileName: 'malware.exe',
        fileSize: 1024,
        mimeType: 'application/x-executable',
        channelId: 'ch-1',
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 when channelId is not a string', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'file.pdf', fileSize: 1024, mimeType: 'application/pdf', channelId: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channelId must be a string/);
  });

  it('returns 400 when conversationId is not a string', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'file.pdf', fileSize: 1024, mimeType: 'application/pdf', conversationId: 456 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conversationId must be a string/);
  });

  it('returns 400 when mimeType is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'file.pdf', fileSize: 1024, channelId: 'ch-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mimeType required/);
  });
});

// ─── A conversation whose other side was deleted (NULL side) ────────────────
// Nothing writes a NULL side yet; the rows are constructed. Both DM checks
// compare each side with the caller: the remaining person passes as before
// (a read-only refusal of the presign is a later change), nobody passes as
// the deleted side.

describe('uploads — a conversation with a NULL side', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const refused = [{ user1Id: null, user2Id: 'other-2' }, { user1Id: 'other-1', user2Id: null }, { user1Id: null, user2Id: null }];

  it('GET /attachments/*: the remaining person still downloads a file of the conversation', async () => {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: false,
      message: { channelId: null, conversationId: 'conv-1', channel: null },
    } as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ id: 'conv-1', user1Id: null, user2Id: 'user-1', reads: [] } as any);
    const dmData = Buffer.alloc(16, 0);
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: Readable.from([dmData]),
      ContentType: 'application/octet-stream',
      ContentLength: dmData.length,
    } as any);

    const res = await request(createApp()).get('/api/v1/uploads/attachments/dm-conv1/abc-encrypted.bin');

    expect(res.status).toBe(200);
  });

  it('GET /attachments/*: nobody downloads as the deleted side, nor from a row with both sides gone', async () => {
    for (const sides of refused) {
      vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
        expired: false,
        message: { channelId: null, conversationId: 'conv-1', channel: null },
      } as any);
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ id: 'conv-1', ...sides } as any);
      const res = await request(createApp()).get('/api/v1/uploads/attachments/dm-conv1/abc-encrypted.bin');
      expect(res.status, JSON.stringify(sides)).toBe(403);
    }
    expect(getS3Object).not.toHaveBeenCalled();
  });

  it('POST /presign/attachment: the remaining person passes the participant check, but nothing is signed for a read-only conversation (403, the shared sentence)', async () => {
    for (const sides of [{ user1Id: 'user-1', user2Id: null }, { user1Id: null, user2Id: 'user-1' }]) {
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ id: 'conv-1', ...sides } as any);

      const res = await request(createApp())
        .post('/api/v1/uploads/presign/attachment')
        .send({ fileName: 'encrypted.bin', fileSize: 1024, mimeType: 'application/octet-stream', conversationId: 'conv-1', encrypted: true });

      expect(res.status, JSON.stringify(sides)).toBe(403);
      expect(res.body.error).toBe('This conversation is read-only');
    }
    expect(generatePresignedPutUrl).not.toHaveBeenCalled();
  });

  it('POST /presign/attachment: a live conversation is signed for as before', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2' } as any);

    const res = await request(createApp())
      .post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'encrypted.bin', fileSize: 1024, mimeType: 'application/octet-stream', conversationId: 'conv-1', encrypted: true });

    expect(res.status).toBe(200);
    expect(generatePresignedPutUrl).toHaveBeenCalledTimes(1);
  });

  it('POST /presign/attachment: nobody presigns as the deleted side, nor into a row with both sides gone', async () => {
    for (const sides of refused) {
      vi.mocked(prisma.conversation.findUnique).mockResolvedValueOnce({ id: 'conv-1', ...sides } as any);
      const res = await request(createApp())
        .post('/api/v1/uploads/presign/attachment')
        .send({ fileName: 'encrypted.bin', fileSize: 1024, mimeType: 'application/octet-stream', conversationId: 'conv-1', encrypted: true });
      expect(res.status, JSON.stringify(sides)).toBe(403);
      expect(res.body.error).toBe('Not a participant of this conversation');
    }
    expect(generatePresignedPutUrl).not.toHaveBeenCalled();
  });
});

// ─── The store fails while its body is being proxied ────────────────────────
// An `error` event on the stream nobody listens to is an uncaught exception,
// which stops the node. The log holds the error's name only, never the key.

describe('uploads — a store failure while a download is proxied', () => {
  const KEY = 'attachments/ch-abc/secret-report.pdf';
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => { uncaught.push(err); };
  let logged: string[];
  let warned: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
    logged = [];
    warned = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    vi.restoreAllMocks();
  });

  const storeFailure = () => Object.assign(new Error('read ECONNRESET store-host.internal:9000 secret-report.pdf'), { name: 'StoreStreamError', code: 'ECONNRESET' });

  function allowAttachment() {
    vi.mocked(prisma.messageAttachment.findFirst).mockResolvedValueOnce({
      expired: false,
      message: { channelId: 'ch-1', conversationId: null, channel: { serverId: 'srv-1', secure: false } },
    } as any);
    vi.mocked(prisma.serverMember.findUnique).mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv-1' } as any);
  }

  /** A body that sends some bytes, then fails. */
  function failingMidBody(): Readable {
    const body = new Readable({ read() { /* pushed below */ } });
    body.push(Buffer.alloc(32, 1));
    setTimeout(() => body.destroy(storeFailure()), 30);
    return body;
  }

  /** A body that fails before the first byte. */
  function failingBeforeBytes(): Readable {
    return new Readable({ read() { this.destroy(storeFailure()); } });
  }

  function expectCleanLog() {
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      for (const secret of ['secret-report', 'store-host', '9000', KEY]) expect(line).not.toContain(secret);
    }
    expect(logged.join(' ')).toContain('StoreStreamError, ECONNRESET');
  }

  it('attachments: a failure mid-body breaks the transfer, stops the source and does not stop the process', async () => {
    allowAttachment();
    const body = failingMidBody();
    vi.mocked(getS3Object).mockResolvedValueOnce({ Body: body, ContentType: 'application/pdf', ContentLength: 4096 } as any);

    await expect(request(createApp()).get(`/api/v1/uploads/${KEY}`)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    expect(body.destroyed).toBe(true);
    expect(uncaught).toEqual([]);
    expectCleanLog();
  });

  it('attachments: a failure before the first byte is answered 502 with no leftover headers', async () => {
    allowAttachment();
    vi.mocked(getS3Object).mockResolvedValueOnce({ Body: failingBeforeBytes(), ContentType: 'application/pdf', ContentLength: 4096 } as any);

    const res = await request(createApp()).get(`/api/v1/uploads/${KEY}`);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false });
    expect(res.headers['content-length']).not.toBe('4096');
    expect(res.headers['content-type']).not.toContain('application/pdf');
    expect(uncaught).toEqual([]);
    expectCleanLog();
  });

  it('?inline avatars: a failure mid-body breaks the transfer and does not stop the process', async () => {
    const body = failingMidBody();
    vi.mocked(getS3Object).mockResolvedValueOnce({ Body: body, ContentType: 'image/webp', ContentLength: 4096 } as any);

    await expect(request(createApp()).get('/api/v1/uploads/server-icons/srv-123.webp?inline')).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    expect(body.destroyed).toBe(true);
    expect(uncaught).toEqual([]);
    expect(logged.join(' ')).not.toContain('srv-123');
  });

  it('?inline avatars: a failure before the first byte is answered 502', async () => {
    vi.mocked(getS3Object).mockResolvedValueOnce({ Body: failingBeforeBytes(), ContentType: 'image/webp', ContentLength: 4096 } as any);

    const res = await request(createApp()).get('/api/v1/uploads/server-icons/srv-123.webp?inline');

    expect(res.status).toBe(502);
    expect(res.headers['cache-control'] ?? '').not.toContain('immutable');
    expect(uncaught).toEqual([]);
  });

  it('a client that goes away stops the read from the store', async () => {
    const body = new Readable({ read() { /* never ends */ } });
    body.push(Buffer.alloc(1024, 1));
    vi.mocked(getS3Object).mockResolvedValueOnce({ Body: body, ContentType: 'image/webp', ContentLength: 10_000_000 } as any);
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const { port } = server.address() as { port: number };
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/uploads/server-icons/srv-123.webp?inline' }, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => undefined);
        setTimeout(() => reject(new Error('no data')), 3000).unref();
      });
      await vi.waitFor(() => expect(body.destroyed).toBe(true));
      // A client leaving is not a store failure: nothing is logged for it
      expect(logged).toEqual([]);
      expect(warned).toEqual([]);
    } finally {
      server.close();
    }
  });
});
