import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'user-1', username: 'testuser', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  serverMember: {
    findMany: vi.fn(),
  },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

// Socket.IO
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
  };
});

// S3
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^(avatars|server-icons)\/[\w-]+\.webp$/,
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { userRouter } from '../../routes/users';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/users', userRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockAuthUser(overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: 'user-1',
    bannedAt: null,
    tokenVersion: 0,
    role: 'user',
    emailVerified: true,
  };
  prismaMock.user.findUnique.mockResolvedValue({ ...defaults, ...overrides });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('User Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAuthUser();
  });

  // ── GET /api/v1/users/:userId ───────────────────────────────────────────

  describe('GET /api/v1/users/:userId', () => {
    it('returns user profile', async () => {
      const token = makeToken();
      const mockProfile = {
        id: 'user-2',
        username: 'otheruser',
        displayName: 'Other User',
        avatarUrl: null,
        bio: 'Hello world',
        status: 'online',
        isSupporter: false,
        supporterTier: null,
        createdAt: new Date('2024-01-01'),
      };

      // First call: auth middleware lookup
      // Second call: route handler lookup
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'user-1',
          bannedAt: null,
          tokenVersion: 0,
          role: 'user',
          emailVerified: true,
        })
        .mockResolvedValueOnce(mockProfile);

      const res = await request(app)
        .get('/api/v1/users/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('user-2');
      expect(res.body.data.username).toBe('otheruser');
      expect(res.body.data.displayName).toBe('Other User');
      expect(res.body.data.bio).toBe('Hello world');
    });

    it('returns own profile when fetching self', async () => {
      const token = makeToken();
      const mockProfile = {
        id: 'user-1',
        username: 'testuser',
        displayName: 'Test User',
        avatarUrl: null,
        bio: null,
        status: 'online',
        isSupporter: false,
        supporterTier: null,
        createdAt: new Date('2024-01-01'),
      };

      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'user-1',
          bannedAt: null,
          tokenVersion: 0,
          role: 'user',
          emailVerified: true,
        })
        .mockResolvedValueOnce(mockProfile);

      const res = await request(app)
        .get('/api/v1/users/user-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('user-1');
    });

    it('returns 404 when user does not exist', async () => {
      const token = makeToken();

      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'user-1',
          bannedAt: null,
          tokenVersion: 0,
          role: 'user',
          emailVerified: true,
        })
        .mockResolvedValueOnce(null);

      const res = await request(app)
        .get('/api/v1/users/user-nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/users/user-2');
      expect(res.status).toBe(401);
    });

    it('returns 403 when email is not verified', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: false,
      });

      const res = await request(app)
        .get('/api/v1/users/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Email not verified');
    });

    it('does not expose sensitive fields in profile response', async () => {
      const token = makeToken();
      const mockProfile = {
        id: 'user-2',
        username: 'otheruser',
        displayName: 'Other User',
        avatarUrl: null,
        bio: null,
        status: 'online',
        isSupporter: false,
        supporterTier: null,
        createdAt: new Date('2024-01-01'),
      };

      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'user-1',
          bannedAt: null,
          tokenVersion: 0,
          role: 'user',
          emailVerified: true,
        })
        .mockResolvedValueOnce(mockProfile);

      const res = await request(app)
        .get('/api/v1/users/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      // Sensitive fields must not be exposed
      expect(res.body.data).not.toHaveProperty('password');
      expect(res.body.data).not.toHaveProperty('tokenVersion');
      expect(res.body.data).not.toHaveProperty('email');
      expect(res.body.data).not.toHaveProperty('totpSecret');
      expect(res.body.data).not.toHaveProperty('totpEnabled');
    });
  });

  // ── PATCH /api/v1/users/me/profile ──────────────────────────────────────

  describe('PATCH /api/v1/users/me/profile', () => {
    it('updates display name', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      prismaMock.user.update.mockResolvedValue({
        id: 'user-1',
        username: 'testuser',
        displayName: 'New Name',
        email: 'test@example.com',
        avatarUrl: null,
        bio: null,
        status: 'online',
        createdAt: new Date('2024-01-01'),
      });

      prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-1' }]);

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.displayName).toBe('New Name');
    });

    it('updates bio', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      prismaMock.user.update.mockResolvedValue({
        id: 'user-1',
        username: 'testuser',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        bio: 'My new bio',
        status: 'online',
        createdAt: new Date('2024-01-01'),
      });

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ bio: 'My new bio' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bio).toBe('My new bio');
    });

    it('updates avatar with valid S3 key', async () => {
      const token = makeToken();

      // Auth middleware lookup
      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'user-1',
          bannedAt: null,
          tokenVersion: 0,
          role: 'user',
          emailVerified: true,
        })
        // Fetch old avatar for cleanup
        .mockResolvedValueOnce({ avatarUrl: null });

      prismaMock.user.update.mockResolvedValue({
        id: 'user-1',
        username: 'testuser',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'avatars/user-1-1234567890.webp',
        bio: null,
        status: 'online',
        createdAt: new Date('2024-01-01'),
      });

      prismaMock.serverMember.findMany.mockResolvedValue([]);

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatarUrl: 'avatars/user-1-1234567890.webp' });

      expect(res.status).toBe(200);
      expect(res.body.data.avatarUrl).toBe('avatars/user-1-1234567890.webp');
    });

    it('clears avatar by setting null', async () => {
      const token = makeToken();

      prismaMock.user.findUnique
        .mockResolvedValueOnce({
          id: 'user-1',
          bannedAt: null,
          tokenVersion: 0,
          role: 'user',
          emailVerified: true,
        })
        .mockResolvedValueOnce({ avatarUrl: 'avatars/user-1-old.webp' });

      prismaMock.user.update.mockResolvedValue({
        id: 'user-1',
        username: 'testuser',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        bio: null,
        status: 'online',
        createdAt: new Date('2024-01-01'),
      });

      prismaMock.serverMember.findMany.mockResolvedValue([]);

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatarUrl: null });

      expect(res.status).toBe(200);
      expect(res.body.data.avatarUrl).toBeNull();
    });

    it('returns 400 with invalid avatar key format', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatarUrl: 'not-a-valid-key' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid avatar key');
    });

    it('returns 400 when avatar key belongs to another user', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatarUrl: 'avatars/user-2-1234567890.webp' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid avatar key');
    });

    it('returns 400 with empty display name', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('empty');
    });

    it('returns 400 with display name exceeding max length', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const longName = 'a'.repeat(65);

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: longName });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('returns 400 with bio exceeding max length', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const longBio = 'a'.repeat(501);

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ bio: longBio });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('at most');
    });

    it('returns 400 when displayName is not a string', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('displayName must be a string');
    });

    it('returns 400 when bio is not a string', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ bio: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('bio must be a string');
    });

    it('sanitizes HTML from display name', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      prismaMock.user.update.mockResolvedValue({
        id: 'user-1',
        username: 'testuser',
        displayName: 'Clean Name',
        email: 'test@example.com',
        avatarUrl: null,
        bio: null,
        status: 'online',
        createdAt: new Date('2024-01-01'),
      });

      prismaMock.serverMember.findMany.mockResolvedValue([]);

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: '<b>Clean Name</b>' });

      expect(res.status).toBe(200);
      // Verify the HTML was stripped before passing to Prisma
      const updateCall = prismaMock.user.update.mock.calls[0]?.[0];
      expect(updateCall?.data?.displayName).toBe('Clean Name');
    });

    it('broadcasts user:updated socket event to all servers', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      prismaMock.user.update.mockResolvedValue({
        id: 'user-1',
        username: 'testuser',
        displayName: 'Updated Name',
        email: 'test@example.com',
        avatarUrl: null,
        bio: null,
        status: 'online',
        createdAt: new Date('2024-01-01'),
      });

      prismaMock.serverMember.findMany.mockResolvedValue([
        { serverId: 'srv-1' },
        { serverId: 'srv-2' },
      ]);

      await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: 'Updated Name' });

      expect(mockTo).toHaveBeenCalledWith('server:srv-1');
      expect(mockTo).toHaveBeenCalledWith('server:srv-2');
      expect(mockEmit).toHaveBeenCalledWith('user:updated', expect.objectContaining({
        userId: 'user-1',
        displayName: 'Updated Name',
      }));
    });

    it('does not broadcast when only bio is updated', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: true,
      });

      prismaMock.user.update.mockResolvedValue({
        id: 'user-1',
        username: 'testuser',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        bio: 'New bio',
        status: 'online',
        createdAt: new Date('2024-01-01'),
      });

      await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ bio: 'New bio' });

      // Should not broadcast for bio-only changes
      expect(mockTo).not.toHaveBeenCalled();
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .send({ displayName: 'New Name' });

      expect(res.status).toBe(401);
    });

    it('returns 403 when email is not verified', async () => {
      const token = makeToken();

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        bannedAt: null,
        tokenVersion: 0,
        role: 'user',
        emailVerified: false,
      });

      const res = await request(app)
        .patch('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: 'New Name' });

      expect(res.status).toBe(403);
    });
  });
});
