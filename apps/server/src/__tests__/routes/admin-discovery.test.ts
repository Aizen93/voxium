import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// PATCH /admin/servers/:serverId/discovery (feature / block, audited) and the
// directory columns + listed filter on GET /admin/servers.

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken() {
  return jwt.sign({ userId: 'admin-1', username: 'admin', tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn() },
  server: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  message: { groupBy: vi.fn().mockResolvedValue([]) },
  channel: { findMany: vi.fn().mockResolvedValue([]) },
  messageAttachment: { findMany: vi.fn().mockResolvedValue([]) },
  serverMember: { findMany: vi.fn().mockResolvedValue([]) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get(_t, prop) { return prismaMock[prop as string]; } }),
}));

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
// fetchSockets stays reachable on every operator so a regression to it is an
// explicit assertion failure, not a TypeError
const mockFetchSockets = vi.fn().mockResolvedValue([]);
const mockSocketsLeave = vi.fn();
const mockLocalSocketsLeave = vi.fn();
const mockIn = vi.fn((_rooms: string | string[]) => ({ fetchSockets: mockFetchSockets, socketsLeave: mockSocketsLeave }));
const mockLocalIn = vi.fn((_rooms: string | string[]) => ({ fetchSockets: mockFetchSockets, socketsLeave: mockLocalSocketsLeave }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: mockTo, in: mockIn, local: { in: mockLocalIn } })),
}));
vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return { rateLimitAdmin: passthrough, normalizeIp: (ip: string) => ip };
});
vi.mock('../../utils/redis', () => ({ getOnlineUsers: vi.fn().mockResolvedValue([]) }));
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(), getVoiceMediaCounts: vi.fn().mockReturnValue({}), getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0), getTotalVoiceUsers: vi.fn().mockResolvedValue(0), getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../websocket/voiceCluster', () => ({ broadcastServerVoiceCleanup: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../websocket/dmVoiceHandler', () => ({ getActiveDMCallCount: vi.fn().mockResolvedValue(0), getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0) }));
vi.mock('../../mediasoup/mediasoupManager', () => ({ getSfuStats: vi.fn().mockReturnValue({ workers: [] }) }));
vi.mock('../../utils/serverLimits', () => ({ getGlobalLimits: vi.fn().mockResolvedValue({}) }));
vi.mock('../../utils/sanitize', () => ({ sanitizeText: vi.fn((s: string) => s) }));
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberJoined: vi.fn(), broadcastMemberLeft: vi.fn() }));
const mockDeleteFromS3 = vi.fn().mockResolvedValue(undefined);
const mockDeleteMultipleFromS3 = vi.fn(async (keys: string[]) => keys.length);
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/, VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]), deleteFromS3: (...a: any[]) => mockDeleteFromS3(...a),
  deleteMultipleFromS3: (keys: string[]) => mockDeleteMultipleFromS3(keys),
}));
const mockLogAuditEvent = vi.fn();
vi.mock('../../utils/auditLog', () => ({ logAuditEvent: (...a: any[]) => mockLogAuditEvent(...a) }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));
const mockRecomputeListed = vi.fn();
vi.mock('../../utils/discoveryListing', () => ({
  recomputeListed: (...a: any[]) => mockRecomputeListed(...a),
  recomputeListedForOwner: vi.fn().mockResolvedValue(0),
}));
// The Explore page cache's generation: curation changes the Featured row and
// the listing, a delete removes a card, so both bump it
const mockBumpDiscoveryPageCache = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/discoveryPageCache', () => ({
  bumpDiscoveryPageCache: (...a: any[]) => mockBumpDiscoveryPageCache(...a),
}));

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const NOW = new Date('2026-10-09T12:00:00Z');
const SERVER_SHAPE = {
  id: 'srv-1', name: 'S', iconUrl: null, invitesLocked: false, ownerId: 'o-1', createdAt: NOW,
  description: null, tags: [], discoverable: true, joinMode: 'approval',
};

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps the *Once queues: a value queued for a call the route
  // stopped making would answer a later test instead (a leftover S3 rejection
  // turned the storage delete below into a 500)
  prismaMock.channel.findMany.mockReset();
  prismaMock.channel.findMany.mockResolvedValue([]);
  mockDeleteFromS3.mockReset();
  mockDeleteFromS3.mockResolvedValue(undefined);
  app = createApp();
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'admin-1', role: 'admin', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  });
  mockRecomputeListed.mockResolvedValue(true);
  prismaMock.server.update.mockImplementation(async ({ data }: any) => ({
    ...SERVER_SHAPE, discoveryListed: true, featuredAt: null, discoveryBlockedAt: null, ...data,
  }));
});

describe('PATCH /admin/servers/:serverId/discovery', () => {
  const patch = (body: unknown) => request(app).patch('/api/v1/admin/servers/srv-1/discovery').set('Authorization', `Bearer ${makeToken()}`).send(body);

  it('validates the body: at least one boolean, booleans only', async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ featured: 'yes' })).status).toBe(400);
    expect((await patch({ blocked: 1 })).status).toBe(400);
    expect(prismaMock.server.update).not.toHaveBeenCalled();
  });

  it('is 404 for an unknown server', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    expect((await patch({ featured: true })).status).toBe(404);
  });

  it('feature requires the server to be LISTED (a Featured row of hidden servers would be a list of 404s)', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: false, featuredAt: null, discoveryBlockedAt: null });
    const res = await patch({ featured: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Only listed servers');
    expect(prismaMock.server.update).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('feature: sets featuredAt, recomputes, emits server:updated (Server shape only) and writes one audit row', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: null, discoveryBlockedAt: null });

    const res = await patch({ featured: true });

    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'srv-1' }, data: { featuredAt: expect.any(Date) } }));
    expect(mockRecomputeListed).toHaveBeenCalledWith('srv-1');
    expect(mockTo).toHaveBeenCalledWith('server:srv-1');
    const emitted = mockEmit.mock.calls.find(([e]: any[]) => e === 'server:updated')![1];
    expect(emitted).toMatchObject({ id: 'srv-1', joinMode: 'approval' });
    expect(emitted).not.toHaveProperty('featuredAt');
    expect(emitted).not.toHaveProperty('discoveryBlockedAt');
    expect(emitted).not.toHaveProperty('discoveryListed');
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockLogAuditEvent).toHaveBeenCalledWith({ actorId: 'admin-1', action: 'server.discovery_feature', targetType: 'server', targetId: 'srv-1' });
    expect(res.body.data).toMatchObject({ id: 'srv-1', discoveryListed: true });
    expect(res.body.data.featuredAt).toBeTruthy();
    // Featured is a row of its own on the first page: the cached pages are
    // stale although the listing did not flip — bumped after the write
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledTimes(1);
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledWith('admin discovery curation');
    expect(mockBumpDiscoveryPageCache.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.server.update.mock.invocationCallOrder[0]);
  });

  it('a refused curation (unknown server, body error) bumps nothing', async () => {
    expect((await patch({ featured: 'yes' })).status).toBe(400);
    prismaMock.server.findUnique.mockResolvedValue(null);
    expect((await patch({ featured: true })).status).toBe(404);
    expect(mockBumpDiscoveryPageCache).not.toHaveBeenCalled();
  });

  it('feature twice is idempotent: no second audit row', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null });
    const res = await patch({ featured: true });
    expect(res.status).toBe(200);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('unfeature clears featuredAt and audits', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null });
    const res = await patch({ featured: false });
    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({ data: { featuredAt: null } }));
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.discovery_unfeature' }));
  });

  it('block: clears discoverable and featuredAt, stamps discoveryBlockedAt, recomputes, audits block (+ unfeature when it was featured)', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null });
    mockRecomputeListed.mockResolvedValue(false);

    const res = await patch({ blocked: true });

    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { discoverable: false, featuredAt: null, discoveryBlockedAt: expect.any(Date) },
    }));
    expect(mockRecomputeListed).toHaveBeenCalledWith('srv-1');
    expect(res.body.data).toMatchObject({ discoverable: false, discoveryListed: false });
    const actions = mockLogAuditEvent.mock.calls.map(([e]: any[]) => e.action).sort();
    expect(actions).toEqual(['server.discovery_block', 'server.discovery_unfeature']);
    // the next open of Explore must not show the blocked space
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledWith('admin discovery curation');
  });

  it('a blocked server cannot be featured in the same call', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: null, discoveryBlockedAt: null });
    const res = await patch({ blocked: true, featured: true });
    expect(res.status).toBe(400);
    expect(prismaMock.server.update).not.toHaveBeenCalled();
  });

  it('unblock clears the block only — the owner relists manually — and audits', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: false, featuredAt: null, discoveryBlockedAt: NOW });
    mockRecomputeListed.mockResolvedValue(false);

    const res = await patch({ blocked: false });

    expect(res.status).toBe(200);
    expect(prismaMock.server.update).toHaveBeenCalledWith(expect.objectContaining({ data: { discoveryBlockedAt: null } }));
    expect(prismaMock.server.update.mock.calls[0][0].data).not.toHaveProperty('discoverable');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.discovery_unblock' }));
    expect(res.body.data.discoveryListed).toBe(false);
  });

  it('falls back to the stored listed value when the recompute could not run', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', discoveryListed: true, featuredAt: null, discoveryBlockedAt: null });
    mockRecomputeListed.mockResolvedValue(null);
    const res = await patch({ featured: true });
    expect(res.status).toBe(200);
    expect(res.body.data.discoveryListed).toBe(true);
  });
});

describe('DELETE /admin/servers/:serverId', () => {
  const del = (id: string) => request(app).delete(`/api/v1/admin/servers/${id}`).set('Authorization', `Bearer ${makeToken()}`);

  it('deletes the row, then bumps the page cache so the card leaves Explore at the next open, and audits', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S' });
    prismaMock.server.delete = vi.fn().mockResolvedValue({});

    const res = await del('srv-1');

    expect(res.status).toBe(200);
    expect(prismaMock.server.delete).toHaveBeenCalledWith({ where: { id: 'srv-1' } });
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledTimes(1);
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledWith('admin server delete');
    expect(mockBumpDiscoveryPageCache.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.server.delete.mock.invocationCallOrder[0]);
    expect(mockEmit).toHaveBeenCalledWith('server:deleted', { serverId: 'srv-1' });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.delete', targetId: 'srv-1' }));
  });

  it('an unknown server is 404 and bumps nothing', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    prismaMock.server.delete = vi.fn();
    expect((await del('ghost')).status).toBe(404);
    expect(prismaMock.server.delete).not.toHaveBeenCalled();
    expect(mockBumpDiscoveryPageCache).not.toHaveBeenCalled();
    expect(mockSocketsLeave).not.toHaveBeenCalled();
    expect(mockLocalSocketsLeave).not.toHaveBeenCalled();
  });

  describe('icon blob', () => {
    const ICON = 'server-icons/srv-1-1700000000000-0123456789ab.webp';

    beforeEach(() => {
      prismaMock.server.delete = vi.fn().mockResolvedValue({});
    });

    it('deletes the stored icon key from storage AFTER the row is deleted', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S', iconUrl: ICON });

      const res = await del('srv-1');

      expect(res.status).toBe(200);
      // The key is read with the row, before the row goes
      expect(prismaMock.server.findUnique).toHaveBeenCalledWith({ where: { id: 'srv-1' }, select: { id: true, name: true, iconUrl: true } });
      expect(mockDeleteFromS3).toHaveBeenCalledTimes(1);
      expect(mockDeleteFromS3).toHaveBeenCalledWith(ICON);
      expect(mockDeleteFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.server.delete.mock.invocationCallOrder[0]);
    });

    it('touches storage not at all for a space without an icon', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S', iconUrl: null });

      const res = await del('srv-1');

      expect(res.status).toBe(200);
      expect(mockDeleteFromS3).not.toHaveBeenCalled();
    });

    it('still answers 200 when the storage delete fails, and logs it (the orphan sweep reclaims the blob)', async () => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S', iconUrl: ICON });
      mockDeleteFromS3.mockRejectedValueOnce(new Error('S3 unavailable'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = await del('srv-1');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Server deleted' });
        expect(prismaMock.server.delete).toHaveBeenCalledWith({ where: { id: 'srv-1' } });
        expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.delete', targetId: 'srv-1' }));
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
          '[Admin] Server icon cleanup failed (the orphan sweep will reclaim it):', 'S3 unavailable'));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('room cleanup', () => {
    const rooms = ['server:srv-1', 'channel:ch-text', 'channel:ch-voice', 'channel:ch-secure'];

    beforeEach(() => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S' });
      prismaMock.server.delete = vi.fn().mockResolvedValue({});
      // Every channel, text, voice and secure alike: no visibility filter
      prismaMock.channel.findMany.mockResolvedValueOnce([{ id: 'ch-text' }, { id: 'ch-voice' }, { id: 'ch-secure' }]);
    });

    it('makes every socket in ANY of the space rooms leave ALL of them, on this node and then cluster-wide', async () => {
      const res = await del('srv-1');

      expect(res.status).toBe(200);
      expect(prismaMock.channel.findMany).toHaveBeenCalledWith({ where: { serverId: 'srv-1' }, select: { id: true } });
      // The server room AND every channel room, as the owner's own delete does
      expect(mockLocalIn).toHaveBeenCalledTimes(1);
      expect(mockLocalIn).toHaveBeenCalledWith(rooms);
      expect(mockLocalSocketsLeave).toHaveBeenCalledTimes(1);
      expect(mockLocalSocketsLeave).toHaveBeenCalledWith(rooms);
      expect(mockIn).toHaveBeenCalledTimes(1);
      expect(mockIn).toHaveBeenCalledWith(rooms);
      expect(mockSocketsLeave).toHaveBeenCalledTimes(1);
      expect(mockSocketsLeave).toHaveBeenCalledWith(rooms);
      expect(mockLocalSocketsLeave.mock.invocationCallOrder[0]).toBeLessThan(mockSocketsLeave.mock.invocationCallOrder[0]);
    });

    it('leaves the rooms after the row is deleted and after the server:deleted notice', async () => {
      await del('srv-1');

      const noticeIndex = mockEmit.mock.calls.findIndex(([event]: [string]) => event === 'server:deleted');
      expect(noticeIndex).toBeGreaterThanOrEqual(0);
      const noticeOrder = mockEmit.mock.invocationCallOrder[noticeIndex];
      expect(noticeOrder).toBeGreaterThan(prismaMock.server.delete.mock.invocationCallOrder[0]);
      expect(mockLocalSocketsLeave.mock.invocationCallOrder[0]).toBeGreaterThan(noticeOrder);
      expect(mockSocketsLeave.mock.invocationCallOrder[0]).toBeGreaterThan(noticeOrder);
      // The channel ids are read while the rows still exist
      expect(prismaMock.channel.findMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.server.delete.mock.invocationCallOrder[0]);
    });

    it('never fetches the sockets: a fetch waits on every node and throws when one peer is unresponsive', async () => {
      mockFetchSockets.mockRejectedValue(new Error('timeout reached while waiting for fetchSockets response'));
      try {
        const res = await del('srv-1');

        expect(res.status).toBe(200);
        expect(mockFetchSockets).not.toHaveBeenCalled();
        expect(prismaMock.server.delete).toHaveBeenCalledWith({ where: { id: 'srv-1' } });
        expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.delete', targetId: 'srv-1' }));
      } finally {
        mockFetchSockets.mockResolvedValue([]);
      }
    });
  });

  describe('attachment files', () => {
    const ICON = 'server-icons/srv-1-1700000000000-0123456789ab.webp';
    const KEYS = ['attachments/ch-1/clmsg1-photo.png', 'attachments/ch-1/clmsg2-notes.txt'];

    beforeEach(() => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S', iconUrl: ICON });
      prismaMock.server.delete = vi.fn().mockResolvedValue({});
      prismaMock.messageAttachment.findMany.mockReset().mockResolvedValue([]);
      mockDeleteMultipleFromS3.mockReset().mockImplementation(async (keys: string[]) => keys.length);
    });

    it('reads the keys of the space before the row and deletes icon and attachment files after it', async () => {
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([
        { id: 'att-1', s3Key: KEYS[0] }, { id: 'att-2', s3Key: KEYS[1] },
      ]);

      const res = await del('srv-1');

      expect(res.status).toBe(200);
      expect(prismaMock.messageAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { expired: false, message: { channel: { serverId: 'srv-1' } } },
      }));
      const deleteOrder = prismaMock.server.delete.mock.invocationCallOrder[0];
      expect(prismaMock.messageAttachment.findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
      expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith(KEYS);
      expect(mockDeleteMultipleFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
      expect(mockDeleteFromS3).toHaveBeenCalledWith(ICON);
      expect(mockDeleteFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
    });

    it('a storage failure still answers 200 and audits', async () => {
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEYS[0] }]);
      mockDeleteMultipleFromS3.mockRejectedValueOnce(new Error('S3 unavailable'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = await del('srv-1');

        expect(res.status).toBe(200);
        expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.delete', targetId: 'srv-1' }));
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
          '[Admin] Attachment file cleanup failed for space srv-1 (the orphan sweep will reclaim them):', 'S3 unavailable'));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the row delete does not depend on the fan-out', () => {
    let errorLog: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      prismaMock.server.findUnique.mockResolvedValue({ id: 'srv-1', name: 'S', iconUrl: null });
      prismaMock.server.delete = vi.fn().mockResolvedValue({});
      prismaMock.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
      errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
      errorLog.mockRestore();
      const { broadcastServerVoiceCleanup } = await import('../../websocket/voiceCluster');
      vi.mocked(broadcastServerVoiceCleanup).mockReset().mockResolvedValue(undefined);
      mockEmit.mockReset();
      mockSocketsLeave.mockReset();
      mockLocalSocketsLeave.mockReset();
    });

    it('commits the delete, audits and answers 200 when the voice cleanup broadcast rejects', async () => {
      const { broadcastServerVoiceCleanup } = await import('../../websocket/voiceCluster');
      vi.mocked(broadcastServerVoiceCleanup).mockRejectedValueOnce(new Error('mediasoup router close failed'));

      const res = await del('srv-1');

      expect(res.status).toBe(200);
      expect(prismaMock.server.delete).toHaveBeenCalledWith({ where: { id: 'srv-1' } });
      expect(vi.mocked(broadcastServerVoiceCleanup).mock.invocationCallOrder[0])
        .toBeGreaterThan(prismaMock.server.delete.mock.invocationCallOrder[0]);
      expect(mockEmit).toHaveBeenCalledWith('server:deleted', { serverId: 'srv-1' });
      expect(mockSocketsLeave).toHaveBeenCalledWith(['server:srv-1', 'channel:ch-1']);
      expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.delete', targetId: 'srv-1' }));
      expect(errorLog).toHaveBeenCalledWith('[Admin] Space srv-1 deleted, but the voice cleanup failed:', 'mediasoup router close failed');
    });

    it('commits the delete and audits when the notice and both room leaves throw', async () => {
      mockEmit.mockImplementation(() => { throw new Error('adapter publish failed'); });
      mockLocalSocketsLeave.mockImplementationOnce(() => { throw new Error('local adapter failed'); });
      mockSocketsLeave.mockImplementationOnce(() => { throw new Error('cluster adapter failed'); });

      const res = await del('srv-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Server deleted' });
      expect(prismaMock.server.delete).toHaveBeenCalledWith({ where: { id: 'srv-1' } });
      expect(mockSocketsLeave).toHaveBeenCalledTimes(1);
      expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.delete', targetId: 'srv-1' }));
    });

    it('a row delete that fails announces nothing and audits nothing', async () => {
      prismaMock.server.delete = vi.fn().mockRejectedValue(new Error('db gone'));
      const { broadcastServerVoiceCleanup } = await import('../../websocket/voiceCluster');

      const res = await del('srv-1');

      expect(res.status).toBe(500);
      expect(broadcastServerVoiceCleanup).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalledWith('server:deleted', expect.anything());
      expect(mockLocalSocketsLeave).not.toHaveBeenCalled();
      expect(mockSocketsLeave).not.toHaveBeenCalled();
      expect(mockLogAuditEvent).not.toHaveBeenCalled();
    });
  });
});

describe('DELETE /admin/storage/files/server-icons/* — a space icon removed from storage', () => {
  const del = (key: string) => request(app).delete(`/api/v1/admin/storage/files/${key}`).set('Authorization', `Bearer ${makeToken()}`);

  it('clears the icon reference and bumps the page cache when a space held it (its card changed)', async () => {
    prismaMock.server.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const res = await del('server-icons/srv-1-1700000000-abcd.webp');
    expect(res.status).toBe(200);
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({ where: { iconUrl: 'server-icons/srv-1-1700000000-abcd.webp' }, data: { iconUrl: null } });
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledTimes(1);
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledWith('admin storage delete (space icon)');
  });

  it('bumps nothing when no space referenced the key', async () => {
    prismaMock.server.updateMany = vi.fn().mockResolvedValue({ count: 0 });
    expect((await del('server-icons/orphan.webp')).status).toBe(200);
    expect(mockBumpDiscoveryPageCache).not.toHaveBeenCalled();
  });
});

describe('GET /admin/servers — directory columns and the listed filter', () => {
  it('selects and returns the directory state per row', async () => {
    prismaMock.server.findMany.mockResolvedValue([{
      ...SERVER_SHAPE, discoveryListed: true, featuredAt: NOW, discoveryBlockedAt: null,
      owner: { username: 'owner', bannedAt: NOW }, _count: { members: 3, channels: 2 },
    }]);
    prismaMock.server.count.mockResolvedValue(1);

    const res = await request(app).get('/api/v1/admin/servers').set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(prismaMock.server.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {},
      select: expect.objectContaining({ discoverable: true, discoveryListed: true, joinMode: true, featuredAt: true, discoveryBlockedAt: true, invitesLocked: true, description: true, tags: true, owner: { select: { username: true, bannedAt: true } } }),
    }));
    expect(res.body.data[0]).toMatchObject({
      id: 'srv-1', discoverable: true, discoveryListed: true, joinMode: 'approval', featuredAt: NOW.toISOString(), discoveryBlockedAt: null, invitesLocked: false, tags: [],
      ownerBannedAt: NOW.toISOString(),
    });
  });

  it('listed=1 narrows to servers currently in Explore', async () => {
    await request(app).get('/api/v1/admin/servers?listed=1').set('Authorization', `Bearer ${makeToken()}`);
    expect(prismaMock.server.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { discoveryListed: true } }));
    expect(prismaMock.server.count).toHaveBeenCalledWith({ where: { discoveryListed: true } });
  });
});

describe('GET /admin/users/:userId/owned-servers — directory state per owned server', () => {
  it('returns description, tags and the listing/curation state next to the member list', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: 'admin-1', role: 'admin', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0) })
      .mockResolvedValueOnce({ id: 'o-1' });
    prismaMock.server.findMany.mockResolvedValue([{
      id: 'srv-1', name: 'S', iconUrl: null,
      description: 'EU evenings', tags: ['gaming'], discoverable: true, discoveryListed: false, joinMode: 'open',
      featuredAt: null, discoveryBlockedAt: NOW, invitesLocked: false,
      owner: { bannedAt: null },
      _count: { members: 2 },
      members: [{ userId: 'm-1', role: 'member', user: { username: 'm', displayName: 'M' } }],
    }]);

    const res = await request(app).get('/api/v1/admin/users/o-1/owned-servers').set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(prismaMock.server.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: 'o-1' },
      select: expect.objectContaining({ description: true, tags: true, discoverable: true, discoveryListed: true, joinMode: true, featuredAt: true, discoveryBlockedAt: true, invitesLocked: true, owner: { select: { bannedAt: true } } }),
    }));
    expect(res.body.data[0]).toMatchObject({
      id: 'srv-1', memberCount: 2, description: 'EU evenings', tags: ['gaming'], discoverable: true, discoveryListed: false,
      joinMode: 'open', featuredAt: null, discoveryBlockedAt: NOW.toISOString(), invitesLocked: false, ownerBannedAt: null,
      members: [{ userId: 'm-1', username: 'm', displayName: 'M', role: 'member' }],
    });
  });

  it('is 404 for an unknown user', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: 'admin-1', role: 'admin', bannedAt: null, tokenVersion: 0, emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0) })
      .mockResolvedValueOnce(null);
    const res = await request(app).get('/api/v1/admin/users/nope/owned-servers').set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });
});
