import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// DELETE /api/v1/admin/users/:userId
//
// E2E key material has no foreign key to User (only E2EKeyBackup does), so a
// bare `user.delete()` leaves device identities and the account master key in
// the database forever. The route purges it explicitly — and does so INSIDE the
// same `$transaction` as the delete. That atomicity is the whole point: if the
// purge committed and the delete then failed, a live, loginable account would
// be left with its cross-signing identity wiped, stranding every device it
// owns, for a deletion that never happened.
//
// The handler has TWO delete paths (user owns servers / owns none). Both are
// exercised here: a regression that drops the purge from one is exactly the
// kind that ships.

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { userId: 'admin-1', username: 'admin', tokenVersion: 0, ...overrides },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

/** Records the real await-order of the two statements inside the transaction. */
let order: string[] = [];

/**
 * The interactive-transaction client handed to the `$transaction(fn)` callback.
 * Recreated per test so `mockRejectedValueOnce` never leaks across tests.
 */
function makeTxMock() {
  const deleteMany = () => vi.fn().mockResolvedValue({ count: 0 });
  return {
    user: {
      delete: vi.fn(async () => {
        order.push('tx.user.delete');
        return {};
      }),
    },
    // The inline member counts (server discovery) move with the cascade, in
    // the same transaction as the delete.
    server: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // The memberships go first, explicitly, ahead of the secure-channel state,
    // with RETURNING server_id: the spaces whose member count moves
    $queryRaw: vi.fn(async () =>
      ((await prismaMock.serverMember.findMany()) as Array<{ serverId: string }>).map((m) => ({ server_id: m.serverId }))),
    // The E2E tables purgeE2EMaterial touches — present so the REAL purge can
    // be driven against this client, not just the observing mock.
    e2EKeyShare: { deleteMany: deleteMany() },
    e2EMasterTransfer: { deleteMany: deleteMany() },
    e2EMasterKey: { deleteMany: deleteMany() },
    e2EDeviceRegistry: { deleteMany: deleteMany() },
    e2EDevice: { deleteMany: deleteMany() },
  };
}

let txMock = makeTxMock();

const prismaMock: Record<string, any> = {
  serverJoinRequest: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockReturnValue({ op: 'request.deleteMany' }) },
  user: {
    findUnique: vi.fn(),
    // Only here so we can prove the delete NEVER runs on the top-level client
    // (i.e. outside the transaction).
    delete: vi.fn(async () => {
      order.push('prisma.user.delete');
      return {};
    }),
  },
  server: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    // an owned space's `delete` action: only while the account still owns it
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  serverMember: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    // the departing owner's own row, demoted in the transfer batch
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  channel: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  // Attachment keys read before a cascade (an owned space, the account's messages)
  messageAttachment: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  channelRead: {
    upsert: vi.fn().mockResolvedValue({}),
  },
  channelMember: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  serverBan: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  // Supports BOTH forms: the array form (used by the ownership-transfer
  // statements) and the callback/interactive form (used by purge + delete).
  $transaction: vi.fn((arg: any) =>
    typeof arg === 'function' ? arg(txMock) : Promise.all(arg)),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

// The purge itself — mocked so the wiring (called at all? with what client? in
// what order?) is observable. One test below swaps in the REAL implementation.
const purgeE2EMaterialMock = vi.fn();
vi.mock('../../utils/e2ePurge', () => ({
  purgeE2EMaterial: (...args: any[]) => purgeE2EMaterialMock(...args),
}));

// Socket.IO
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockDisconnectSockets = vi.fn();
// fetchSockets stays reachable on every operator so a regression to it is an
// explicit assertion failure, not a TypeError
const mockFetchSockets = vi.fn().mockResolvedValue([]);
const mockSocketsLeave = vi.fn();
const mockIn = vi.fn((_rooms: string | string[]) => ({ fetchSockets: mockFetchSockets, disconnectSockets: mockDisconnectSockets, socketsLeave: mockSocketsLeave }));
const mockLocalDisconnectSockets = vi.fn();
const mockLocalSocketsLeave = vi.fn();
const mockLocalIn = vi.fn((_rooms: string | string[]) => ({ fetchSockets: mockFetchSockets, disconnectSockets: mockLocalDisconnectSockets, socketsLeave: mockLocalSocketsLeave }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
    local: { in: mockLocalIn },
  })),
}));

// Rate limiters
// Visibility-room resync (owner reassignment changes VIEW_CHANNEL for the heir)
const mockSyncVisibilityRooms = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/channelVisibilityRooms', () => ({
  syncChannelVisibilityRooms: (...args: any[]) => mockSyncVisibilityRooms(...args),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return { rateLimitAdmin: passthrough, normalizeIp: (ip: string) => ip };
});

// Redis
vi.mock('../../utils/redis', () => ({
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));

// Voice handler
vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(),
  getVoiceMediaCounts: vi.fn().mockReturnValue({ producers: 0, consumers: 0 }),
  getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0),
  getTotalVoiceUsers: vi.fn().mockResolvedValue(0),
  getVoiceDiagnostics: vi.fn().mockResolvedValue({}),
}));

// Voice cluster
vi.mock('../../websocket/voiceCluster', () => ({
  broadcastServerVoiceCleanup: vi.fn().mockResolvedValue(undefined),
}));

// DM voice handler
vi.mock('../../websocket/dmVoiceHandler', () => ({
  getActiveDMCallCount: vi.fn().mockResolvedValue(0),
  getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0),
}));

// mediasoup manager
vi.mock('../../mediasoup/mediasoupManager', () => ({
  getSfuStats: vi.fn().mockReturnValue({ workers: [], totalTransports: 0 }),
}));

// Server limits
vi.mock('../../utils/serverLimits', () => ({
  getGlobalLimits: vi.fn().mockResolvedValue({}),
}));

// Sanitize
vi.mock('../../utils/sanitize', () => ({
  sanitizeText: vi.fn((s: string) => s),
}));

// Member broadcast
const mockBroadcastMemberLeft = vi.fn().mockResolvedValue(undefined);
const mockEmitToModerators = vi.fn();
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: (...a: any[]) => mockEmitToModerators(...a) }));
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: (...args: any[]) => mockBroadcastMemberLeft(...args),
}));

// Secure-channel lifecycle: the account's secure-channel state goes in the
// delete transaction, the notices after it
const mockRemoveSecureInTx = vi.fn(async (_tx: unknown, userId: string) => ({ userId, deleted: [], left: [] }));
const mockAnnounceSecureRemoved = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/secureChannelLifecycle', () => ({
  removeSecureMembershipsInTx: (tx: unknown, userId: string) => mockRemoveSecureInTx(tx, userId),
  announceSecureMembershipsRemoved: (...args: any[]) => mockAnnounceSecureRemoved(...args),
  deleteSecureChannel: vi.fn().mockResolvedValue(true),
}));

// S3
const mockDeleteFromS3 = vi.fn().mockResolvedValue(undefined);
const mockDeleteMultipleFromS3 = vi.fn(async (keys: string[]) => keys.length);
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: (...args: any[]) => mockDeleteFromS3(...args),
  deleteMultipleFromS3: (keys: string[]) => mockDeleteMultipleFromS3(keys),
}));

// Audit log
const mockLogAuditEvent = vi.fn();
vi.mock('../../utils/auditLog', () => ({
  logAuditEvent: (...args: any[]) => mockLogAuditEvent(...args),
}));

// Feature flags
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// Directory listing column — a transfer changes whose ban state feeds it
const mockRecomputeListed = vi.fn().mockResolvedValue(true);
vi.mock('../../utils/discoveryListing', () => ({
  recomputeListed: (...args: any[]) => mockRecomputeListed(...args),
  recomputeListedForOwner: vi.fn().mockResolvedValue(0),
}));
// A deleted owned server leaves the cached Explore pages through the generation bump
const mockBumpDiscoveryPageCache = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/discoveryPageCache', () => ({
  bumpDiscoveryPageCache: (...args: any[]) => mockBumpDiscoveryPageCache(...args),
}));

// ─── App setup ──────────────────────────────────────────────────────────────

import { prisma } from '../../utils/prisma';
import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * users[id] → row for prisma.user.findUnique — covers both the auth
 * middleware lookup (actor) and the route's target lookup.
 */
function mockUsers(users: Record<string, { role?: string; bannedAt?: Date | null; avatarUrl?: string | null }>) {
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    const row = users[where.id];
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: where.id,
      bannedAt: null,
      tokenVersion: 0,
      emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
      role: 'user',
      avatarUrl: null,
      // deleteUserAccount re-reads the account with its owned servers right
      // before the delete; by then the route has transferred or deleted them
      ownedServers: [],
      ...row,
    });
  });
}

/** The single interactive `$transaction(fn)` call — the delete transaction. */
function callbackTransactions() {
  return prismaMock.$transaction.mock.calls.filter(
    ([arg]: [unknown]) => typeof arg === 'function');
}

/** Assert the purge and the delete happened together, in order, in one txn. */
function expectAtomicPurgeAndDelete(targetId: string) {
  // Exactly one interactive transaction, and the delete lives inside it.
  expect(callbackTransactions()).toHaveLength(1);
  expect(txMock.user.delete).toHaveBeenCalledWith({ where: { id: targetId } });
  // Never on the top-level client — that would be a delete outside the txn.
  expect(prismaMock.user.delete).not.toHaveBeenCalled();

  // The purge ran against the TRANSACTION client, not the top-level prisma.
  expect(purgeE2EMaterialMock).toHaveBeenCalledTimes(1);
  const [purgedId, client] = purgeE2EMaterialMock.mock.calls[0];
  expect(purgedId).toBe(targetId);
  expect(client).toBe(txMock);
  expect(client).not.toBe(prisma);

  // The secure-channel rows go in the same transaction, on its client, after
  // the memberships and before the row; the notices only after the commit
  expect(mockRemoveSecureInTx).toHaveBeenCalledWith(txMock, targetId);
  const memberDelete = txMock.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
  expect(memberDelete[0].join('?')).toMatch(/DELETE FROM server_members WHERE user_id = \? RETURNING server_id/);
  expect(memberDelete.slice(1)).toEqual([targetId]);
  expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mockRemoveSecureInTx.mock.invocationCallOrder[0]);
  expect(mockRemoveSecureInTx.mock.invocationCallOrder[0]).toBeLessThan(txMock.user.delete.mock.invocationCallOrder[0]);
  // the E2E purge (key shares first) after the secure channels are locked:
  // the order a removal from one secure channel takes the channel and the shares in
  expect(mockRemoveSecureInTx.mock.invocationCallOrder[0]).toBeLessThan(purgeE2EMaterialMock.mock.invocationCallOrder[0]);
  expect(mockAnnounceSecureRemoved).toHaveBeenCalledWith({ userId: targetId, deleted: [], left: [] });
  expect(mockAnnounceSecureRemoved.mock.invocationCallOrder[0]).toBeGreaterThan(txMock.user.delete.mock.invocationCallOrder[0]);

  // Purge FIRST: a delete that lands first can commit alone if the purge then
  // throws under a driver that does not roll back the way we assume.
  expect(order).toEqual(['purge', 'tx.user.delete']);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  // errorHandler console.error's unexpected errors; the failure tests trigger it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.mocked(console.error).mockRestore();
});

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  txMock = makeTxMock();
  purgeE2EMaterialMock.mockImplementation(async () => {
    order.push('purge');
  });
  prismaMock.$transaction.mockImplementation((arg: any) =>
    typeof arg === 'function' ? arg(txMock) : Promise.all(arg));
  prismaMock.serverMember.findMany.mockResolvedValue([]);
  prismaMock.server.findMany.mockResolvedValue([]);
  prismaMock.server.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.server.findUnique.mockResolvedValue(null);
  // Back to the declared defaults: clearAllMocks keeps both the implementations
  // a test set and the *Once queues a test left unconsumed
  prismaMock.channel.findMany.mockResolvedValue([]);
  mockDeleteFromS3.mockReset();
  mockDeleteFromS3.mockResolvedValue(undefined);
});

describe('DELETE /admin/users/:userId — E2E key material dies with the account', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
  });


  it('purges E2E material and deletes the user in ONE transaction (user owns no servers)', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-a' }]);

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expectAtomicPurgeAndDelete('target-1');
  });

  it('ends the deleted account\'s live sessions on this node and cluster-wide, with force:logout', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.serverMember.findMany.mockResolvedValue([]);

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockTo).toHaveBeenCalledWith('user:target-1');
    expect(mockEmit).toHaveBeenCalledWith('force:logout', expect.objectContaining({ reason: expect.any(String) }));
    expect(mockLocalIn).toHaveBeenCalledWith('user:target-1');
    expect(mockLocalDisconnectSockets).toHaveBeenCalledWith(true);
    expect(mockIn).toHaveBeenCalledWith('user:target-1');
    expect(mockDisconnectSockets).toHaveBeenCalledWith(true);
    expect(mockFetchSockets).not.toHaveBeenCalled();
    // The acting admin's sessions are untouched
    expect(mockIn).not.toHaveBeenCalledWith('user:admin-1');
  });

  it('gives the deletion a budget it can actually finish in', async () => {
    // Sharing a transaction also imposes a deadline these statements never had
    // apart. Prisma's default is 5s, and deleting a user cascades across ~36
    // relations plus six E2E deletes — blowing it on a heavy account would roll
    // the whole thing back AFTER that account's servers were already deleted,
    // since those are not part of this transaction.
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.serverMember.findMany.mockResolvedValue([]);

    await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    const interactive = prismaMock.$transaction.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'function'
    );
    expect(interactive).toBeDefined();
    expect((interactive![1] as { timeout?: number } | undefined)?.timeout).toBeGreaterThan(5_000);
  });

  it('purges E2E material and deletes the user in ONE transaction (user owns servers)', async () => {
    // The owns-servers branch is a completely separate code path with its own
    // copy of the purge+delete — it regresses independently of the simple one.
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);
    prismaMock.serverMember.findMany.mockResolvedValue([
      { serverId: 'srv-owned' },
      { serverId: 'srv-other' },
    ]);

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ serverActions: [{ serverId: 'srv-owned', action: 'delete' }] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.server.deleteMany).toHaveBeenCalledWith({ where: { id: 'srv-owned', ownerId: 'target-1' } });
    // the deleted space leaves the cached Explore pages (bumped after the delete)
    expect(mockBumpDiscoveryPageCache).toHaveBeenCalledWith('admin server delete');
    expect(mockBumpDiscoveryPageCache.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.server.deleteMany.mock.invocationCallOrder[0]);
    expectAtomicPurgeAndDelete('target-1');
  });

  it('keeps the purge in its own interactive transaction even when ownership transfers use array transactions', async () => {
    // The transfer path issues array-form $transaction calls before the delete.
    // The purge must still ride the interactive one, with the tx client.
    mockUsers({
      'admin-1': { role: 'admin' },
      'target-1': { role: 'user' },
      'heir-1': { role: 'user' },
    });
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-owned' }]);
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'heir-1', serverId: 'srv-owned' });
    prismaMock.server.findUnique.mockResolvedValue({
      id: 'srv-owned',
      name: 'Owned',
      iconUrl: null,
      ownerId: 'heir-1',
      invitesLocked: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        serverActions: [{ serverId: 'srv-owned', action: 'transfer', newOwnerId: 'heir-1' }],
      });

    expect(res.status).toBe(200);
    // The array form still works for the transfer statements…
    const arrayTxns = prismaMock.$transaction.mock.calls.filter(
      ([arg]: [unknown]) => Array.isArray(arg));
    expect(arrayTxns).toHaveLength(1);
    // with the long budget: an account deletion of any member holds the space
    // row through its cascade, and a batch expires under the 5 s default too
    expect(arrayTxns[0][1]).toEqual({ timeout: 60_000, maxWait: 10_000 });
    // only while the departing account still owns the space
    expect(prismaMock.server.update).toHaveBeenCalledWith({
      where: { id: 'srv-owned', ownerId: 'target-1' },
      data: { ownerId: 'heir-1' },
    });
    // …and the purge+delete are still atomic on their own.
    expectAtomicPurgeAndDelete('target-1');
    // The heir was already a member, so their channel:{id} rooms were computed
    // at connect against the old owner — owner status has to be resynced.
    expect(mockSyncVisibilityRooms).toHaveBeenCalledWith('srv-owned', { userId: 'heir-1' });
    // ...and the listing column follows the new owner's ban state
    expect(mockRecomputeListed).toHaveBeenCalledWith('srv-owned');
  });

  it('transferring to a NON-member creates their membership and moves the inline member count in the same statement', async () => {
    mockUsers({
      'admin-1': { role: 'admin' },
      'target-1': { role: 'user' },
      'heir-1': { role: 'user' },
    });
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 'srv-owned' }]);
    prismaMock.serverMember.findUnique.mockResolvedValue(null); // heir is not a member yet
    prismaMock.channel.findMany.mockResolvedValue([{ id: 'ch-1' }]);
    prismaMock.serverJoinRequest.findUnique.mockResolvedValueOnce({ status: 'pending' }); // the heir had asked to join
    prismaMock.server.findUnique.mockResolvedValue({
      id: 'srv-owned', name: 'Owned', iconUrl: null, ownerId: 'heir-1', invitesLocked: false,
      createdAt: new Date('2026-01-01T00:00:00Z'), description: null, tags: [], discoverable: true, joinMode: 'approval',
    });

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        serverActions: [{ serverId: 'srv-owned', action: 'transfer', newOwnerId: 'heir-1' }],
      });

    expect(res.status).toBe(200);
    expect(prismaMock.serverMember.create).toHaveBeenCalledWith({
      data: { userId: 'heir-1', serverId: 'srv-owned', role: 'owner' },
    });
    expect(prismaMock.server.update).toHaveBeenCalledWith({
      where: { id: 'srv-owned', ownerId: 'target-1' },
      data: { ownerId: 'heir-1', memberCount: { increment: 1 } },
    });
    // an admin-chosen heir is an explicit unban — this path creates a member
    // around joinServerMember's ban check, so the row must not survive it
    expect(prismaMock.serverBan.deleteMany).toHaveBeenCalledWith({ where: { serverId: 'srv-owned', userId: 'heir-1' } });
    // ...and so does a request they had open on this server, settled as joined for the moderators
    expect(prismaMock.serverJoinRequest.deleteMany).toHaveBeenCalledWith({ where: { serverId: 'srv-owned', userId: 'heir-1' } });
    // the heir's membership starts with no secure-channel row an earlier one
    // left, in the same transaction as the membership (built before it)
    expect(prismaMock.channelMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'heir-1', channel: { serverId: 'srv-owned' } } });
    expect(prismaMock.channelMember.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.serverMember.create.mock.invocationCallOrder[0]);
    const heirTx = prismaMock.$transaction.mock.calls.find(([arg]: [unknown]) => Array.isArray(arg));
    expect(heirTx![0]).toContain(prismaMock.channelMember.deleteMany.mock.results[0].value);
    // the long budget, as the existing-member batch
    expect(heirTx![1]).toEqual({ timeout: 60_000, maxWait: 10_000 });
    expect(mockEmitToModerators).toHaveBeenCalledWith('srv-owned', 'server:join_request_resolved', { serverId: 'srv-owned', userId: 'heir-1', outcome: 'joined' });
    expect(mockRecomputeListed).toHaveBeenCalledWith('srv-owned');
    // the deleted account's own membership is decremented inside the delete transaction
    expect(txMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['srv-owned'] }, memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });
    expect(txMock.server.updateMany.mock.invocationCallOrder[0]).toBeLessThan(txMock.user.delete.mock.invocationCallOrder[0]);
    expectAtomicPurgeAndDelete('target-1');
  });

  it('purges the TARGET user, never the acting admin', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });

    await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(purgeE2EMaterialMock).toHaveBeenCalledWith('target-1', txMock);
    expect(purgeE2EMaterialMock.mock.calls[0][0]).not.toBe('admin-1');
    expect(txMock.user.delete).toHaveBeenCalledWith({ where: { id: 'target-1' } });
  });
});

describe('DELETE /admin/users/:userId — an owned space deleted with the account leaves its rooms', () => {
  let app: express.Express;
  const rooms = ['server:srv-owned', 'channel:ch-text', 'channel:ch-voice', 'channel:ch-secure'];

  beforeEach(() => {
    app = createApp();
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);
    // Every channel, text, voice and secure alike: no visibility filter
    prismaMock.channel.findMany.mockResolvedValue([{ id: 'ch-text' }, { id: 'ch-voice' }, { id: 'ch-secure' }]);
  });

  const deleteOwner = () => request(app)
    .delete('/api/v1/admin/users/target-1')
    .set('Authorization', `Bearer ${makeToken()}`)
    .send({ serverActions: [{ serverId: 'srv-owned', action: 'delete' }] });

  it('makes every socket in ANY of the space rooms leave ALL of them, on this node and then cluster-wide', async () => {
    const res = await deleteOwner();

    expect(res.status).toBe(200);
    expect(prismaMock.channel.findMany).toHaveBeenCalledWith({ where: { serverId: 'srv-owned' }, select: { id: true } });
    // The server room AND every channel room, as the owner's own delete does
    expect(mockLocalIn).toHaveBeenCalledWith(rooms);
    expect(mockLocalSocketsLeave).toHaveBeenCalledTimes(1);
    expect(mockLocalSocketsLeave).toHaveBeenCalledWith(rooms);
    expect(mockIn).toHaveBeenCalledWith(rooms);
    expect(mockSocketsLeave).toHaveBeenCalledTimes(1);
    expect(mockSocketsLeave).toHaveBeenCalledWith(rooms);
    expect(mockLocalSocketsLeave.mock.invocationCallOrder[0]).toBeLessThan(mockSocketsLeave.mock.invocationCallOrder[0]);
  });

  it('leaves the rooms after the space row is deleted and after the server:deleted notice', async () => {
    await deleteOwner();

    const noticeIndex = mockEmit.mock.calls.findIndex(([event]: [string]) => event === 'server:deleted');
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    const noticeOrder = mockEmit.mock.invocationCallOrder[noticeIndex];
    expect(noticeOrder).toBeGreaterThan(prismaMock.server.deleteMany.mock.invocationCallOrder[0]);
    expect(mockLocalSocketsLeave.mock.invocationCallOrder[0]).toBeGreaterThan(noticeOrder);
    expect(mockSocketsLeave.mock.invocationCallOrder[0]).toBeGreaterThan(noticeOrder);
    // The channel ids are read while the rows still exist
    expect(prismaMock.channel.findMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.server.deleteMany.mock.invocationCallOrder[0]);
  });

  it('a rejecting voice cleanup and a throwing notice still delete the space AND the account', async () => {
    const { broadcastServerVoiceCleanup } = await import('../../websocket/voiceCluster');
    vi.mocked(broadcastServerVoiceCleanup).mockRejectedValueOnce(new Error('mediasoup router close failed'));
    mockEmit.mockImplementationOnce(() => { throw new Error('adapter publish failed'); });
    // console.error is silenced for the whole file (beforeAll)
    const errorLog = vi.mocked(console.error);

    const res = await deleteOwner();

    expect(res.status).toBe(200);
    expect(prismaMock.server.deleteMany).toHaveBeenCalledWith({ where: { id: 'srv-owned', ownerId: 'target-1' } });
    expect(vi.mocked(broadcastServerVoiceCleanup).mock.invocationCallOrder[0])
      .toBeGreaterThan(prismaMock.server.deleteMany.mock.invocationCallOrder[0]);
    expect(mockSocketsLeave).toHaveBeenCalledWith(rooms);
    // The account deletion after the loop still ran
    expectAtomicPurgeAndDelete('target-1');
    expect(errorLog).toHaveBeenCalledWith('[Admin] Space srv-owned deleted, but the voice cleanup failed:', 'mediasoup router close failed');
    expect(errorLog).toHaveBeenCalledWith('[Admin] Space srv-owned deleted, but the server:deleted notice failed:', 'adapter publish failed');
  });

  it('deletes the owned space\'s attachment files after its row, and the account\'s after the account', async () => {
    const spaceKey = 'attachments/ch-text/clmsg1-photo.png';
    const accountKey = 'attachments/dm-conv1/clmsg2-blob.bin';
    prismaMock.messageAttachment.findMany.mockImplementation(async ({ where }: any) =>
      (where.message?.channel?.serverId === 'srv-owned'
        ? [{ id: 'att-1', s3Key: spaceKey }]
        : where.message?.authorId === 'target-1' ? [{ id: 'att-2', s3Key: accountKey }] : []));
    mockDeleteMultipleFromS3.mockClear();
    try {
      const res = await deleteOwner();

      expect(res.status).toBe(200);
      expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith([spaceKey]);
      expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith([accountKey]);
      const spaceCall = mockDeleteMultipleFromS3.mock.calls.findIndex(([keys]) => keys[0] === spaceKey);
      const accountCall = mockDeleteMultipleFromS3.mock.calls.findIndex(([keys]) => keys[0] === accountKey);
      expect(mockDeleteMultipleFromS3.mock.invocationCallOrder[spaceCall])
        .toBeGreaterThan(prismaMock.server.deleteMany.mock.invocationCallOrder[0]);
      expect(mockDeleteMultipleFromS3.mock.invocationCallOrder[accountCall])
        .toBeGreaterThan(txMock.user.delete.mock.invocationCallOrder[0]);
    } finally {
      prismaMock.messageAttachment.findMany.mockReset().mockResolvedValue([]);
    }
  });

  it('a space row delete that fails stops the deletion before any notice, with the account untouched', async () => {
    prismaMock.server.deleteMany.mockRejectedValueOnce(new Error('db gone'));
    const { broadcastServerVoiceCleanup } = await import('../../websocket/voiceCluster');

    const res = await deleteOwner();

    expect(res.status).toBe(500);
    expect(broadcastServerVoiceCleanup).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalledWith('server:deleted', expect.anything());
    expect(mockSocketsLeave).not.toHaveBeenCalled();
    expect(txMock.user.delete).not.toHaveBeenCalled();
  });

  describe('a space that changed owner after the owned-spaces read', () => {
    // The delete matches only a row the account still owns: it found none,
    // and the space is still there (handed to someone else meanwhile)
    beforeEach(() => {
      prismaMock.server.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.server.findUnique.mockImplementation(async ({ select }: any) =>
        (select?.iconUrl ? { iconUrl: 'server-icons/srv-owned-1700000000000-0123456789ab.webp' } : { id: 'srv-owned' }));
    });

    it('is not deleted: the request stops with the 400 the dashboard shows, and nothing of that space is touched', async () => {
      const { broadcastServerVoiceCleanup } = await import('../../websocket/voiceCluster');

      const res = await deleteOwner();

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server "srv-owned" is not owned by this user');
      // the one statement: the space only while the departing account owns it
      expect(prismaMock.server.deleteMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.server.deleteMany).toHaveBeenCalledWith({ where: { id: 'srv-owned', ownerId: 'target-1' } });
      expect(prismaMock.server.delete).not.toHaveBeenCalled();
      // no room emptied, no voice torn down, no notice, no cache bump, no file deleted
      expect(mockLocalSocketsLeave).not.toHaveBeenCalled();
      expect(mockSocketsLeave).not.toHaveBeenCalled();
      expect(broadcastServerVoiceCleanup).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalledWith('server:deleted', expect.anything());
      expect(mockBumpDiscoveryPageCache).not.toHaveBeenCalled();
      expect(mockDeleteFromS3).not.toHaveBeenCalled();
      expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
      // the account is not deleted, and nothing claims it or the space was
      expect(purgeE2EMaterialMock).not.toHaveBeenCalled();
      expect(txMock.user.delete).not.toHaveBeenCalled();
      expect(mockLogAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'server.delete' }));
      expect(mockLogAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'user.delete' }));
    });

    it('a space gone meanwhile answers 404 Server, as the owner\'s own delete does', async () => {
      prismaMock.server.findUnique.mockImplementation(async ({ select }: any) => (select?.iconUrl ? { iconUrl: null } : null));

      const res = await deleteOwner();

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Server not found');
      expect(mockSocketsLeave).not.toHaveBeenCalled();
      expect(txMock.user.delete).not.toHaveBeenCalled();
    });
  });

  it('leaves only the server room when the space has no channels', async () => {
    prismaMock.channel.findMany.mockResolvedValue([]);

    await deleteOwner();

    expect(mockLocalSocketsLeave).toHaveBeenCalledWith(['server:srv-owned']);
    expect(mockSocketsLeave).toHaveBeenCalledWith(['server:srv-owned']);
  });

  it('deletes the space icon from storage after its row, without waiting on storage', async () => {
    const icon = 'server-icons/srv-owned-1700000000000-0123456789ab.webp';
    prismaMock.server.findUnique.mockResolvedValue({ iconUrl: icon });
    // A storage call that never settles: the deletion must answer anyway
    mockDeleteFromS3.mockReturnValue(new Promise(() => {}));

    const res = await deleteOwner();

    expect(res.status).toBe(200);
    expect(mockDeleteFromS3).toHaveBeenCalledTimes(1);
    expect(mockDeleteFromS3).toHaveBeenCalledWith(icon);
    expect(mockDeleteFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.server.deleteMany.mock.invocationCallOrder[0]);
    expectAtomicPurgeAndDelete('target-1');
  });

  it('a failed icon delete is logged and the account deletion still completes', async () => {
    prismaMock.server.findUnique.mockResolvedValue({ iconUrl: 'server-icons/srv-owned-1700000000000-0123456789ab.webp' });
    mockDeleteFromS3.mockRejectedValue(new Error('S3 unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await deleteOwner();

      expect(res.status).toBe(200);
      expectAtomicPurgeAndDelete('target-1');
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        '[Admin] Server icon cleanup failed (the orphan sweep will reclaim it):', 'S3 unavailable'));
    } finally {
      warn.mockRestore();
    }
  });

  it('never fetches the sockets: a stalled peer cannot abort the account deletion halfway', async () => {
    // A fetch waits on every node and throws after 5 s when one peer is
    // unresponsive: here it stopped the deletion after the space's members
    // were told it was gone, with the space and the account still in place
    mockFetchSockets.mockRejectedValue(new Error('timeout reached while waiting for fetchSockets response'));
    try {
      const res = await deleteOwner();

      expect(res.status).toBe(200);
      expect(mockFetchSockets).not.toHaveBeenCalled();
      expect(prismaMock.server.deleteMany).toHaveBeenCalledWith({ where: { id: 'srv-owned', ownerId: 'target-1' } });
      expectAtomicPurgeAndDelete('target-1');
    } finally {
      mockFetchSockets.mockResolvedValue([]);
    }
  });
});

describe('DELETE /admin/users/:userId — a half-done deletion is worse than none', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
  });

  it('aborts the deletion when the purge fails — the account must not be deleted key-less', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    purgeE2EMaterialMock.mockRejectedValueOnce(new Error('e2e purge exploded'));

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(txMock.user.delete).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it('aborts the deletion when the purge fails in the owns-servers branch too', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);
    purgeE2EMaterialMock.mockRejectedValueOnce(new Error('e2e purge exploded'));

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ serverActions: [{ serverId: 'srv-owned', action: 'delete' }] });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(txMock.user.delete).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it('surfaces a failing user.delete as an error instead of reporting success', async () => {
    // The purge already ran in this transaction. Reporting 200 here would tell
    // the operator a live account with wiped key material was deleted.
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    txMock.user.delete.mockRejectedValueOnce(new Error('FK constraint: owned servers'));

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBeUndefined();
    // The purge did run — which is exactly why it had to be in the transaction.
    expect(purgeE2EMaterialMock).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /admin/users/:userId — authorization gates the purge too', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
  });

  /** No purge, no delete — nothing destructive may run on a rejected request. */
  function expectNothingDestroyed() {
    expect(purgeE2EMaterialMock).not.toHaveBeenCalled();
    expect(txMock.user.delete).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  }

  it('rejects a non-admin caller', async () => {
    mockUsers({ 'admin-1': { role: 'user' }, 'target-1': { role: 'user' } });

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin access required');
    expectNothingDestroyed();
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(app).delete('/api/v1/admin/users/target-1').send({});

    expect(res.status).toBe(401);
    expectNothingDestroyed();
  });

  it('refuses self-deletion', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });

    const res = await request(app)
      .delete('/api/v1/admin/users/admin-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Cannot delete yourself');
    expectNothingDestroyed();
  });

  it('404s on an unknown target without touching key material', async () => {
    mockUsers({ 'admin-1': { role: 'admin' } });

    const res = await request(app)
      .delete('/api/v1/admin/users/ghost-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
    expectNothingDestroyed();
  });

  it('nobody can delete a superadmin — not even another superadmin', async () => {
    mockUsers({ 'admin-1': { role: 'superadmin' }, 'target-1': { role: 'superadmin' } });

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Cannot delete a super admin');
    expectNothingDestroyed();
  });

  it('an admin cannot delete another admin', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'admin' } });

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only super admins can delete other admins');
    expectNothingDestroyed();
  });

  it('a superadmin CAN delete an admin — and the purge runs for them as well', async () => {
    mockUsers({ 'admin-1': { role: 'superadmin' }, 'target-1': { role: 'admin' } });

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expectAtomicPurgeAndDelete('target-1');
  });

  it('refuses to delete a server owner without serverActions, leaving key material intact', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('serverActions');
    expectNothingDestroyed();
  });
});

describe('DELETE /admin/users/:userId — the real purge, end to end', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
  });

  it('clears every E2E table for the deleted user, on the transaction client', async () => {
    // The other tests pin the WIRING with a stubbed purge. This one runs the
    // real purgeE2EMaterial through the route so the wiring and the behaviour
    // are both covered: a purge that is called but clears nothing is no purge.
    const actual = await vi.importActual<typeof import('../../utils/e2ePurge')>(
      '../../utils/e2ePurge');
    purgeE2EMaterialMock.mockImplementation(actual.purgeE2EMaterial);

    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' } });

    const res = await request(app)
      .delete('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);

    // Key shares are keyed by sender AND recipient — purging one direction
    // leaves the user's outbound envelopes in other people's inboxes.
    const shareCalls = txMock.e2EKeyShare.deleteMany.mock.calls.map(([a]: [unknown]) => a);
    expect(shareCalls).toContainEqual({ where: { recipientUserId: 'target-1' } });
    expect(shareCalls).toContainEqual({ where: { senderUserId: 'target-1' } });

    // Master transfers, master key, device registry and devices never expire —
    // they only ever go away here.
    for (const table of [
      txMock.e2EMasterTransfer,
      txMock.e2EMasterKey,
      txMock.e2EDeviceRegistry,
      txMock.e2EDevice,
    ]) {
      expect(table.deleteMany).toHaveBeenCalledWith({ where: { userId: 'target-1' } });
    }

    // Every delete was scoped to the target — an unscoped `where` would empty
    // the table for the whole platform.
    for (const table of [
      txMock.e2EKeyShare,
      txMock.e2EMasterTransfer,
      txMock.e2EMasterKey,
      txMock.e2EDeviceRegistry,
      txMock.e2EDevice,
    ]) {
      expect(table.deleteMany).toHaveBeenCalled();
      for (const [arg] of table.deleteMany.mock.calls) {
        const where = (arg as { where?: Record<string, unknown> })?.where;
        expect(where).toBeTruthy();
        expect(Object.values(where!)).toEqual(['target-1']);
      }
    }

    // …and none of it leaked onto the top-level client, outside the txn.
    expect(prismaMock.e2EDevice).toBeUndefined();
    expect(txMock.user.delete).toHaveBeenCalledWith({ where: { id: 'target-1' } });
  });
});

describe('DELETE /admin/users/:userId — the request as the dashboard sends it', () => {
  // The dashboard deletes an account that owns no space with a bare
  // `api.delete(url)`: no body, so no Content-Type, and Express 5 leaves
  // req.body undefined. Every other case in this file sends `{}`, which is how
  // the 500 on that request went unseen. These send nothing.
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' }, 'heir-1': { role: 'user' } });
  });

  function expectNothingDestroyed() {
    expect(prismaMock.server.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.server.update).not.toHaveBeenCalled();
    expect(purgeE2EMaterialMock).not.toHaveBeenCalled();
    expect(txMock.user.delete).not.toHaveBeenCalled();
  }

  const del = () => request(app)
    .delete('/api/v1/admin/users/target-1')
    .set('Authorization', `Bearer ${makeToken()}`);

  it('deletes an account that owns no space when the request carries no body', async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'User deleted' });
    expectAtomicPurgeAndDelete('target-1');
  });

  it('refuses a space owner when the request carries no body, and deletes nothing', async () => {
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);

    const res = await del();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('User owns 1 server(s). Provide serverActions for each owned server.');
    expectNothingDestroyed();
  });

  it('refuses a serverActions that is not an array', async () => {
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);

    const res = await del().send({ serverActions: 'srv-owned' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('serverActions must be an array');
    expectNothingDestroyed();
  });

  it('refuses an entry that is not an object', async () => {
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);

    for (const entry of [null, 'srv-owned', 7]) {
      const res = await del().send({ serverActions: [entry] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Each serverAction must be an object');
    }
    expectNothingDestroyed();
  });

  it('refuses an entry without a serverId', async () => {
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);

    for (const serverId of [undefined, '', 42]) {
      const res = await del().send({ serverActions: [{ serverId, action: 'delete' }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Each serverAction needs a serverId');
    }
    expectNothingDestroyed();
  });

  it('refuses an action other than transfer or delete instead of deleting the space', async () => {
    // Before, every value but 'transfer' took the branch that deletes the space.
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);

    for (const action of ['archive', 'DELETE', undefined, true]) {
      const res = await del().send({ serverActions: [{ serverId: 'srv-owned', action }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('serverAction for server "srv-owned" must be "transfer" or "delete"');
    }
    expectNothingDestroyed();
  });

  it('refuses two entries for one space', async () => {
    prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-owned', name: 'Owned' }]);

    const res = await del().send({ serverActions: [
      { serverId: 'srv-owned', action: 'delete' },
      { serverId: 'srv-owned', action: 'delete' },
    ] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Duplicate serverAction for server "srv-owned"');
    expectNothingDestroyed();
  });

  it('refuses a transfer without an heir BEFORE the other spaces are deleted', async () => {
    // The check used to run inside the loop, after the earlier entries had
    // already deleted their spaces: a 400 that left the account half-processed.
    prismaMock.server.findMany.mockResolvedValue([
      { id: 'srv-a', name: 'A' },
      { id: 'srv-b', name: 'B' },
    ]);

    for (const newOwnerId of [undefined, '', 9]) {
      const res = await del().send({ serverActions: [
        { serverId: 'srv-a', action: 'delete' },
        { serverId: 'srv-b', action: 'transfer', newOwnerId },
      ] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('newOwnerId required for transfer of server "srv-b"');
    }
    expectNothingDestroyed();
  });

  it('refuses a transfer to the account being deleted BEFORE the other spaces are deleted', async () => {
    prismaMock.server.findMany.mockResolvedValue([
      { id: 'srv-a', name: 'A' },
      { id: 'srv-b', name: 'B' },
    ]);

    const res = await del().send({ serverActions: [
      { serverId: 'srv-a', action: 'delete' },
      { serverId: 'srv-b', action: 'transfer', newOwnerId: 'target-1' },
    ] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot transfer to the user being deleted');
    expectNothingDestroyed();
  });

  it('refuses an heir who does not exist BEFORE the other spaces are deleted', async () => {
    prismaMock.server.findMany.mockResolvedValue([
      { id: 'srv-a', name: 'A' },
      { id: 'srv-b', name: 'B' },
    ]);

    const res = await del().send({ serverActions: [
      { serverId: 'srv-a', action: 'delete' },
      { serverId: 'srv-b', action: 'transfer', newOwnerId: 'ghost-1' },
    ] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Transfer target user not found');
    expectNothingDestroyed();
  });

  it('refuses a banned heir BEFORE the other spaces are deleted', async () => {
    mockUsers({ 'admin-1': { role: 'admin' }, 'target-1': { role: 'user' }, 'heir-1': { role: 'user', bannedAt: new Date() } });
    prismaMock.server.findMany.mockResolvedValue([
      { id: 'srv-a', name: 'A' },
      { id: 'srv-b', name: 'B' },
    ]);

    const res = await del().send({ serverActions: [
      { serverId: 'srv-a', action: 'delete' },
      { serverId: 'srv-b', action: 'transfer', newOwnerId: 'heir-1' },
    ] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot transfer ownership to a banned user');
    expectNothingDestroyed();
  });

  it('still runs a valid mixed request: one space deleted, one transferred to a member', async () => {
    prismaMock.server.findMany.mockResolvedValue([
      { id: 'srv-a', name: 'A' },
      { id: 'srv-b', name: 'B' },
    ]);
    prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'heir-1', serverId: 'srv-b' });

    const res = await del().send({ serverActions: [
      { serverId: 'srv-a', action: 'delete' },
      { serverId: 'srv-b', action: 'transfer', newOwnerId: 'heir-1' },
    ] });

    expect(res.status).toBe(200);
    expect(prismaMock.server.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.server.deleteMany).toHaveBeenCalledWith({ where: { id: 'srv-a', ownerId: 'target-1' } });
    expect(prismaMock.server.update).toHaveBeenCalledWith({ where: { id: 'srv-b', ownerId: 'target-1' }, data: { ownerId: 'heir-1' } });
    expectAtomicPurgeAndDelete('target-1');
  });

  describe('a transfer leaves no second owner if the account deletion then fails', () => {
    beforeEach(() => {
      prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-b', name: 'B' }]);
    });
    const transferToHeir = () => del().send({ serverActions: [{ serverId: 'srv-b', action: 'transfer', newOwnerId: 'heir-1' }] });
    const demotion = { where: { userId: 'target-1', serverId: 'srv-b', role: 'owner' }, data: { role: 'admin' } };

    it('to an heir already a member: the departing account\'s own row is demoted to admin in the same batch', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'heir-1' });

      expect((await transferToHeir()).status).toBe(200);

      expect(prismaMock.serverMember.updateMany).toHaveBeenCalledWith(demotion);
      const batch = prismaMock.$transaction.mock.calls.find(([arg]: [unknown]) => Array.isArray(arg))![0];
      expect(batch).toContain(prismaMock.serverMember.updateMany.mock.results[0].value);
    });

    it('to an heir who joins with it: the departing account\'s own row is demoted to admin in the same batch', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue(null);

      expect((await transferToHeir()).status).toBe(200);

      expect(prismaMock.serverMember.updateMany).toHaveBeenCalledWith(demotion);
      const batch = prismaMock.$transaction.mock.calls.find(([arg]: [unknown]) => Array.isArray(arg))![0];
      expect(batch).toContain(prismaMock.serverMember.updateMany.mock.results[0].value);
    });

    it('audits each transfer and delete the moment it commits, so a deletion that fails after them still leaves their record', async () => {
      prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-a', name: 'A' }, { id: 'srv-b', name: 'B' }]);
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'heir-1' });
      // the account deletion fails after both spaces were handled
      prismaMock.$transaction.mockImplementation((arg: any) =>
        (typeof arg === 'function' ? Promise.reject(new Error('db gone')) : Promise.all(arg)));

      const res = await del().send({ serverActions: [
        { serverId: 'srv-a', action: 'delete' },
        { serverId: 'srv-b', action: 'transfer', newOwnerId: 'heir-1' },
      ] });

      expect(res.status).toBe(500);
      expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'server.delete', targetType: 'server', targetId: 'srv-a',
        metadata: expect.objectContaining({ serverName: 'A', ownerId: 'target-1', via: 'user.delete' }),
      }));
      expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'server.transfer', targetType: 'server', targetId: 'srv-b',
        metadata: expect.objectContaining({ serverName: 'B', fromUserId: 'target-1', newOwnerId: 'heir-1', via: 'user.delete' }),
      }));
      // ...and no row claims the account was deleted
      expect(mockLogAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'user.delete' }));
    });
  });

  describe('a transfer batch PostgreSQL aborted, or whose check went stale', () => {
    const deadlock = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.server.findMany.mockResolvedValue([{ id: 'srv-b', name: 'B' }]);
    });
    afterEach(() => { warn.mockRestore(); });
    const transferToHeir = () => del().send({ serverActions: [{ serverId: 'srv-b', action: 'transfer', newOwnerId: 'heir-1' }] });

    it('runs the whole attempt again, the heir\'s membership read included, so a retry picks its branch from what is true now', async () => {
      // The heir was not a member when the first attempt read it; by the
      // retry they are one (a join committed meanwhile)
      prismaMock.serverMember.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ userId: 'heir-1' });
      prismaMock.$transaction
        .mockImplementationOnce(async () => { throw deadlock(); });

      const res = await transferToHeir();

      expect(res.status).toBe(200);
      expect(prismaMock.serverMember.findUnique).toHaveBeenCalledTimes(2);
      // the retried attempt took the member branch: no second membership
      expect(prismaMock.serverMember.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.serverMember.update).toHaveBeenLastCalledWith({
        where: { userId_serverId: { userId: 'heir-1', serverId: 'srv-b' } },
        data: { role: 'owner' },
      });
      expect(warn).toHaveBeenCalledWith('[Admin] The transfer of space srv-b was aborted by a deadlock or a serialization failure; retrying (1 of 2)');
      expectAtomicPurgeAndDelete('target-1');
    });

    it('a batch that finds the space no longer the departing account\'s refuses, and the account is not deleted', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'heir-1' });
      prismaMock.$transaction.mockImplementationOnce(async () => {
        throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'someone-else' });

      const res = await transferToHeir();

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Server "srv-b" is not owned by this user');
      expect(txMock.user.delete).not.toHaveBeenCalled();
    });

    it('a batch that finds the heir\'s account gone answers 404 Transfer target user, not a 500', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue(null);
      prismaMock.$transaction.mockImplementationOnce(async () => {
        throw Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' });
      });
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'target-1' });

      const res = await transferToHeir();

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Transfer target user not found');
      expect(txMock.user.delete).not.toHaveBeenCalled();
    });

    it('an heir who left between the membership read and the existing-member batch answers 404 Transfer target user, not a 500', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'heir-1' });
      prismaMock.$transaction.mockImplementationOnce(async () => {
        throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      });
      // the space is still the departing account's: the heir's row is what went
      prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'target-1' });

      const res = await transferToHeir();

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Transfer target user not found');
      expect(txMock.user.delete).not.toHaveBeenCalled();
    });

    it('a batch that finds the space gone answers 404 Server', async () => {
      prismaMock.serverMember.findUnique.mockResolvedValue({ userId: 'heir-1' });
      prismaMock.$transaction.mockImplementationOnce(async () => {
        throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      });
      prismaMock.server.findUnique.mockResolvedValue(null);

      const res = await transferToHeir();

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Server not found');
    });
  });
});
