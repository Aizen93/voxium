import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
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
  },
  serverMember: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
  channel: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  channelRead: {
    upsert: vi.fn().mockResolvedValue({}),
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
const mockIn = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: mockTo,
    in: mockIn,
  })),
}));

// Rate limiters
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
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: (...args: any[]) => mockBroadcastMemberLeft(...args),
}));

// Secure-channel lifecycle (account deletion purges secure state for events)
const mockPurgeSecureForAccount = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/secureChannelLifecycle', () => ({
  purgeSecureChannelState: vi.fn().mockResolvedValue(undefined),
  purgeSecureChannelStateForAccount: (...args: any[]) => mockPurgeSecureForAccount(...args),
  deleteSecureChannel: vi.fn().mockResolvedValue(true),
}));

// S3
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));

// Audit log
vi.mock('../../utils/auditLog', () => ({
  logAuditEvent: vi.fn(),
}));

// Feature flags
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
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
function mockUsers(users: Record<string, { role?: string; bannedAt?: Date | null }>) {
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    const row = users[where.id];
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: where.id,
      bannedAt: null,
      tokenVersion: 0,
      emailVerified: true,
      role: 'user',
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
  prismaMock.server.delete.mockResolvedValue({});
  prismaMock.server.findUnique.mockResolvedValue(null);
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
    expect(prismaMock.server.delete).toHaveBeenCalledWith({ where: { id: 'srv-owned' } });
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
    expect(prismaMock.server.update).toHaveBeenCalledWith({
      where: { id: 'srv-owned' },
      data: { ownerId: 'heir-1' },
    });
    // …and the purge+delete are still atomic on their own.
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
