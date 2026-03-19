import { describe, it, expect, vi, beforeEach } from 'vitest';
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
}));

// Mock rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitUpload: passthrough,
    rateLimitGeneral: passthrough,
  };
});

// Mock S3
const mockPresignedGetUrl = 'https://s3.example.com/signed-get-url';
const mockPresignedPutUrl = 'https://s3.example.com/signed-put-url';

vi.mock('../../utils/s3', () => ({
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
import { generatePresignedGetUrl, getS3Object } from '../../utils/s3';

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
    // Mock getS3Object to return a body that auto-ends the response
    // (avoids ECONNRESET from stream piping in vitest fork pool)
    const imgData = Buffer.alloc(8, 0);
    const mockPipe = vi.fn((dest: any) => { dest.end(imgData); return dest; });
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: { pipe: mockPipe },
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
    const mockPipe = vi.fn((dest: any) => { dest.end(fileData); return dest; });
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: { pipe: mockPipe },
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
      id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2',
    } as any);
    const dmData = Buffer.alloc(32, 0);
    const mockPipe = vi.fn((dest: any) => { dest.end(dmData); return dest; });
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: { pipe: mockPipe },
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
});

describe('uploads — POST /presign/avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns presigned PUT URL', async () => {
    const app = createApp();
    const res = await request(app).post('/api/v1/uploads/presign/avatar');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.uploadUrl).toBe(mockPresignedPutUrl);
    expect(res.body.data.key).toMatch(/^avatars\/user-1-\d+\.webp$/);
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
    const res = await request(app).post('/api/v1/uploads/presign/server-icon/srv-1');

    expect(res.status).toBe(200);
    expect(res.body.data.key).toMatch(/^server-icons\/srv-1-\d+\.webp$/);
  });

  it('returns 403 for user without MANAGE_SERVER permission', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValueOnce({
      id: 'srv-1', ownerId: 'other-user', name: 'Test Server',
    } as any);
    const { hasServerPermission } = await import('../../utils/permissionCalculator');
    vi.mocked(hasServerPermission).mockResolvedValueOnce(false);

    const app = createApp();
    const res = await request(app).post('/api/v1/uploads/presign/server-icon/srv-1');

    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent server', async () => {
    vi.mocked(prisma.server.findUnique).mockResolvedValueOnce(null);

    const app = createApp();
    const res = await request(app).post('/api/v1/uploads/presign/server-icon/srv-nonexistent');

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
    const mockPipe = vi.fn((dest: any) => { dest.end(fileData); return dest; });
    vi.mocked(getS3Object).mockResolvedValueOnce({
      Body: { pipe: mockPipe },
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
  });

  it('rejects when neither channelId nor conversationId provided', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/uploads/presign/attachment')
      .send({ fileName: 'report.pdf', fileSize: 1024, mimeType: 'application/pdf' });

    expect(res.status).toBe(400);
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
});
