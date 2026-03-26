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

const mockSocketEmit = vi.fn();
const mockFetchSockets = vi.fn().mockResolvedValue([]);

const prismaMock: Record<string, any> = {
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  friendship: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
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
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    fetchSockets: mockFetchSockets,
  })),
}));

// Rate limiters
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return {
    rateLimitGeneral: passthrough,
    rateLimitFriendRequest: passthrough,
  };
});

// ─── App setup ──────────────────────────────────────────────────────────────

import { friendRouter } from '../../routes/friends';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/friends', friendRouter);
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

const mockTargetUser = {
  id: 'user-2',
  username: 'targetuser',
  displayName: 'Target User',
  avatarUrl: null,
  status: 'offline',
};

const mockCurrentUser = {
  id: 'user-1',
  username: 'testuser',
  displayName: 'Test User',
  avatarUrl: null,
  status: 'online',
};

function makeFriendship(overrides: Record<string, unknown> = {}) {
  return {
    id: 'friendship-1',
    requesterId: 'user-1',
    addresseeId: 'user-2',
    status: 'pending',
    createdAt: new Date('2024-01-01'),
    requester: mockCurrentUser,
    addressee: mockTargetUser,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Friend Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAuthUser();
    mockFetchSockets.mockResolvedValue([]);
  });

  // ── GET /api/v1/friends ──────────────────────────────────────────────────

  describe('GET /api/v1/friends', () => {
    it('returns list of friendships', async () => {
      const token = makeToken();

      prismaMock.friendship.findMany.mockResolvedValue([
        makeFriendship({ status: 'accepted' }),
        makeFriendship({
          id: 'friendship-2',
          requesterId: 'user-3',
          addresseeId: 'user-1',
          status: 'pending',
          requester: { id: 'user-3', username: 'thirduser', displayName: 'Third', avatarUrl: null, status: 'offline' },
          addressee: mockCurrentUser,
        }),
      ]);

      const res = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      // First friendship: user-1 is requester, so other user is addressee (user-2)
      expect(res.body.data[0].user.id).toBe('user-2');
      // Second friendship: user-1 is addressee, so other user is requester (user-3)
      expect(res.body.data[1].user.id).toBe('user-3');
    });

    it('returns empty array when no friendships exist', async () => {
      const token = makeToken();
      prismaMock.friendship.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/friends');
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
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  // ── POST /api/v1/friends/request ─────────────────────────────────────────

  describe('POST /api/v1/friends/request', () => {
    it('sends a friend request', async () => {
      const token = makeToken();

      prismaMock.user.findFirst.mockResolvedValue(mockTargetUser);
      prismaMock.friendship.findFirst.mockResolvedValue(null);
      prismaMock.friendship.create.mockResolvedValue(makeFriendship());

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'targetuser' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.requesterId).toBe('user-1');
      expect(res.body.data.addresseeId).toBe('user-2');
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.user.id).toBe('user-2');
    });

    it('emits friend:request_received to target user', async () => {
      const token = makeToken();
      const targetSocket = { data: { userId: 'user-2' }, emit: mockSocketEmit };
      mockFetchSockets.mockResolvedValue([targetSocket]);

      prismaMock.user.findFirst.mockResolvedValue(mockTargetUser);
      prismaMock.friendship.findFirst.mockResolvedValue(null);
      prismaMock.friendship.create.mockResolvedValue(makeFriendship());

      await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'targetuser' });

      expect(mockSocketEmit).toHaveBeenCalledWith('friend:request_received', expect.objectContaining({
        friendship: expect.objectContaining({
          requesterId: 'user-1',
          addresseeId: 'user-2',
        }),
      }));
    });

    it('returns 400 when username is missing', async () => {
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('username is required');
    });

    it('returns 400 when username is not a string', async () => {
      const token = makeToken();

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('username is required');
    });

    it('returns 404 when target user does not exist', async () => {
      const token = makeToken();
      prismaMock.user.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'nonexistent' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 400 when sending friend request to self', async () => {
      const token = makeToken();
      prismaMock.user.findFirst.mockResolvedValue({
        ...mockTargetUser,
        id: 'user-1', // same as current user
      });

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'testuser' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('yourself');
    });

    it('returns 409 when already friends', async () => {
      const token = makeToken();
      prismaMock.user.findFirst.mockResolvedValue(mockTargetUser);
      prismaMock.friendship.findFirst.mockResolvedValue(
        makeFriendship({ status: 'accepted' }),
      );

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'targetuser' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Already friends');
    });

    it('returns 409 when friend request already sent', async () => {
      const token = makeToken();
      prismaMock.user.findFirst.mockResolvedValue(mockTargetUser);
      prismaMock.friendship.findFirst.mockResolvedValue(
        makeFriendship({ status: 'pending', requesterId: 'user-1', addresseeId: 'user-2' }),
      );

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'targetuser' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already sent');
    });

    it('auto-accepts when target already sent a pending request to me', async () => {
      const token = makeToken();
      prismaMock.user.findFirst.mockResolvedValue(mockTargetUser);

      // Existing pending request FROM target TO current user
      prismaMock.friendship.findFirst.mockResolvedValue(
        makeFriendship({
          status: 'pending',
          requesterId: 'user-2',
          addresseeId: 'user-1',
          requester: mockTargetUser,
          addressee: mockCurrentUser,
        }),
      );

      // After auto-accept update
      prismaMock.friendship.update.mockResolvedValue(
        makeFriendship({
          status: 'accepted',
          requesterId: 'user-2',
          addresseeId: 'user-1',
          requester: mockTargetUser,
          addressee: mockCurrentUser,
        }),
      );

      const res = await request(app)
        .post('/api/v1/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'targetuser' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('auto-accepted');
      expect(res.body.data.status).toBe('accepted');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/v1/friends/request')
        .send({ username: 'targetuser' });

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/friends/:friendshipId/accept ───────────────────────────

  describe('POST /api/v1/friends/:friendshipId/accept', () => {
    it('accepts a pending friend request', async () => {
      const token = makeToken();

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-2',
        addresseeId: 'user-1',
        status: 'pending',
      });

      prismaMock.friendship.update.mockResolvedValue(
        makeFriendship({
          status: 'accepted',
          requesterId: 'user-2',
          addresseeId: 'user-1',
          requester: mockTargetUser,
          addressee: mockCurrentUser,
        }),
      );

      const res = await request(app)
        .post('/api/v1/friends/friendship-1/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('accepted');
    });

    it('emits friend:request_accepted to requester', async () => {
      const token = makeToken();
      const requesterSocket = { data: { userId: 'user-2' }, emit: mockSocketEmit };
      mockFetchSockets.mockResolvedValue([requesterSocket]);

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-2',
        addresseeId: 'user-1',
        status: 'pending',
      });

      prismaMock.friendship.update.mockResolvedValue(
        makeFriendship({
          status: 'accepted',
          requesterId: 'user-2',
          addresseeId: 'user-1',
          requester: mockTargetUser,
          addressee: mockCurrentUser,
        }),
      );

      await request(app)
        .post('/api/v1/friends/friendship-1/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(mockSocketEmit).toHaveBeenCalledWith('friend:request_accepted', expect.objectContaining({
        friendship: expect.objectContaining({
          status: 'accepted',
        }),
      }));
    });

    it('returns 404 when friendship does not exist', async () => {
      const token = makeToken();
      prismaMock.friendship.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/friends/friendship-nonexistent/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 403 when user is not the addressee', async () => {
      const token = makeToken();

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-1', // current user is the requester, not the addressee
        addresseeId: 'user-2',
        status: 'pending',
      });

      const res = await request(app)
        .post('/api/v1/friends/friendship-1/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('addressee');
    });

    it('returns 400 when friendship is not pending', async () => {
      const token = makeToken();

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-2',
        addresseeId: 'user-1',
        status: 'accepted', // already accepted
      });

      const res = await request(app)
        .post('/api/v1/friends/friendship-1/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not pending');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/v1/friends/friendship-1/accept');

      expect(res.status).toBe(401);
    });
  });

  // ── DELETE /api/v1/friends/:friendshipId ─────────────────────────────────

  describe('DELETE /api/v1/friends/:friendshipId', () => {
    it('allows requester to remove friendship', async () => {
      const token = makeToken();

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-1',
        addresseeId: 'user-2',
        status: 'accepted',
      });
      prismaMock.friendship.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/friends/friendship-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('removed');
    });

    it('allows addressee to remove friendship', async () => {
      const token = makeToken();

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-2',
        addresseeId: 'user-1',
        status: 'accepted',
      });
      prismaMock.friendship.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/friends/friendship-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('removed');
    });

    it('allows cancelling a pending request', async () => {
      const token = makeToken();

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-1',
        addresseeId: 'user-2',
        status: 'pending',
      });
      prismaMock.friendship.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/api/v1/friends/friendship-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('emits friend:removed to the other user', async () => {
      const token = makeToken();
      const otherSocket = { data: { userId: 'user-2' }, emit: mockSocketEmit };
      mockFetchSockets.mockResolvedValue([otherSocket]);

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-1',
        addresseeId: 'user-2',
        status: 'accepted',
      });
      prismaMock.friendship.delete.mockResolvedValue({});

      await request(app)
        .delete('/api/v1/friends/friendship-1')
        .set('Authorization', `Bearer ${token}`);

      expect(mockSocketEmit).toHaveBeenCalledWith('friend:removed', { userId: 'user-1' });
    });

    it('returns 404 when friendship does not exist', async () => {
      const token = makeToken();
      prismaMock.friendship.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/friends/friendship-nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 403 when user is not part of the friendship', async () => {
      const token = makeToken();

      prismaMock.friendship.findUnique.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-2',
        addresseeId: 'user-3', // neither user is user-1
        status: 'accepted',
      });

      const res = await request(app)
        .delete('/api/v1/friends/friendship-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Not part of this friendship');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .delete('/api/v1/friends/friendship-1');

      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/v1/friends/status/:userId ───────────────────────────────────

  describe('GET /api/v1/friends/status/:userId', () => {
    it('returns "none" when no friendship exists', async () => {
      const token = makeToken();
      prismaMock.friendship.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/friends/status/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('none');
      expect(res.body.data.friendshipId).toBeNull();
    });

    it('returns "friends" when friendship is accepted', async () => {
      const token = makeToken();
      prismaMock.friendship.findFirst.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-1',
        addresseeId: 'user-2',
        status: 'accepted',
      });

      const res = await request(app)
        .get('/api/v1/friends/status/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('friends');
      expect(res.body.data.friendshipId).toBe('friendship-1');
    });

    it('returns "pending_outgoing" when I sent a pending request', async () => {
      const token = makeToken();
      prismaMock.friendship.findFirst.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-1', // I am the requester
        addresseeId: 'user-2',
        status: 'pending',
      });

      const res = await request(app)
        .get('/api/v1/friends/status/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('pending_outgoing');
    });

    it('returns "pending_incoming" when they sent a pending request to me', async () => {
      const token = makeToken();
      prismaMock.friendship.findFirst.mockResolvedValue({
        id: 'friendship-1',
        requesterId: 'user-2', // They are the requester
        addresseeId: 'user-1',
        status: 'pending',
      });

      const res = await request(app)
        .get('/api/v1/friends/status/user-2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('pending_incoming');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/friends/status/user-2');
      expect(res.status).toBe(401);
    });
  });
});
