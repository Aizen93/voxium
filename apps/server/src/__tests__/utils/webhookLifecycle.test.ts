import { describe, it, expect, vi, beforeEach } from 'vitest';

// utils/webhookLifecycle.ts: the response whitelist, the refetch hint and the
// delete transaction + receipts the owner's router and the admin routes share.

const h = vi.hoisted(() => ({
  emitted: [] as { room: string; event: string; payload: unknown }[],
}));

const txMock = {
  $queryRaw: vi.fn(),
  message: { groupBy: vi.fn(), deleteMany: vi.fn() },
  webhook: { findUnique: vi.fn(), delete: vi.fn() },
};

const prismaMock: Record<string, any> = {
  // On the root client: the disable committed BEFORE the transaction, the
  // history batches (each statement its own short transaction) and the
  // platform-ban disarm; the locked delete itself runs on the tx client
  webhook: { updateMany: vi.fn(), findMany: vi.fn() },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
};
vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get(_t, prop) { return prismaMock[prop as string]; } }),
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => { h.emitted.push({ room, event, payload }); },
    }),
  })),
}));

import {
  webhookSelect,
  toWebhook,
  isPurgeRequested,
  emitWebhookChanged,
  deleteWebhookWithPurge,
  emitWebhookDeletion,
  disarmWebhooksHeldBy,
  type WebhookDeletion,
} from '../../utils/webhookLifecycle';

const CREATED_AT = new Date('2026-10-18T10:00:00.000Z');
const USED_AT = new Date('2026-10-18T11:30:00.000Z');
const LOCKED_ROW = { serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github' };

beforeEach(() => {
  vi.clearAllMocks();
  h.emitted.length = 0;
  prismaMock.webhook.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.webhook.findMany.mockResolvedValue([]);
  // the history batches: nothing to detach or delete unless a test says so
  prismaMock.$executeRaw.mockResolvedValue(0);
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) => cb(txMock));
  txMock.$queryRaw.mockResolvedValue([{ id: 'wh-1' }]);
  txMock.webhook.findUnique.mockResolvedValue(LOCKED_ROW);
  txMock.message.groupBy.mockResolvedValue([]);
  txMock.message.deleteMany.mockResolvedValue({ count: 0 });
  txMock.webhook.delete.mockResolvedValue({ id: 'wh-1' });
});

describe('webhookSelect / toWebhook', () => {
  it('selects exactly the public columns: never the token hash nor the sealed secret', () => {
    expect(Object.keys(webhookSelect).sort()).toEqual([
      'adminDisabledAt', 'channelId', 'createdAt', 'createdBy', 'creatorRemovedAt', 'enabled', 'id',
      'lastRotatedAt', 'lastRotatedBy', 'lastUsedAt', 'name', 'serverId', 'type',
    ]);
    expect(webhookSelect.createdBy).toEqual({ select: { id: true, username: true, displayName: true } });
    // the rotator is a user shape like the creator: never the raw lastRotatedById
    expect(webhookSelect.lastRotatedBy).toEqual({ select: { id: true, username: true, displayName: true } });
    expect(webhookSelect).not.toHaveProperty('lastRotatedById');
  });

  it('maps a row to the shared Webhook shape by whitelist (extra columns never pass)', () => {
    const row = {
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: false,
      adminDisabledAt: null, creatorRemovedAt: null,
      createdAt: CREATED_AT, lastUsedAt: USED_AT, lastRotatedAt: null,
      createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice', email: 'leak@example.test' },
      lastRotatedBy: null,
      tokenHash: 'f'.repeat(64), secretEnc: 'sealed', lastRotatedById: 'u-2',
    };
    expect(toWebhook(row)).toEqual({
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: false,
      adminDisabledAt: null, creatorRemovedAt: null,
      createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice' },
      createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: '2026-10-18T11:30:00.000Z',
      lastRotatedAt: null, lastRotatedBy: null,
    });
  });

  it('maps the owner-decision columns: the admin lock, the creator-removal mark and the rotation trace as ISO dates', () => {
    const ADMIN_AT = new Date('2026-10-19T08:00:00.000Z');
    const REMOVED_AT = new Date('2026-10-19T08:30:00.000Z');
    const ROTATED_AT = new Date('2026-10-19T09:00:00.000Z');
    const row = {
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: false,
      adminDisabledAt: ADMIN_AT, creatorRemovedAt: REMOVED_AT,
      createdAt: CREATED_AT, lastUsedAt: null, lastRotatedAt: ROTATED_AT,
      createdBy: null,
      lastRotatedBy: { id: 'u-2', username: 'bob', displayName: 'Bob', email: 'leak@example.test' },
    };
    const out = toWebhook(row);
    expect(out.adminDisabledAt).toBe('2026-10-19T08:00:00.000Z');
    expect(out.creatorRemovedAt).toBe('2026-10-19T08:30:00.000Z');
    expect(out.lastRotatedAt).toBe('2026-10-19T09:00:00.000Z');
    // whitelisted like createdBy: nothing but the three public fields
    expect(out.lastRotatedBy).toEqual({ id: 'u-2', username: 'bob', displayName: 'Bob' });
  });

  it('keeps a deleted creator, a never-used and a never-rotated webhook as null', () => {
    const out = toWebhook({
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github', enabled: true,
      adminDisabledAt: null, creatorRemovedAt: null,
      createdAt: CREATED_AT, lastUsedAt: null, lastRotatedAt: null, createdBy: null, lastRotatedBy: null,
    });
    expect(out.createdBy).toBeNull();
    expect(out.lastUsedAt).toBeNull();
    expect(out.lastRotatedAt).toBeNull();
    expect(out.lastRotatedBy).toBeNull();
    expect(out.adminDisabledAt).toBeNull();
    expect(out.creatorRemovedAt).toBeNull();
  });
});

describe('isPurgeRequested', () => {
  it.each(['1', 'true'])('%s purges', (v) => expect(isPurgeRequested(v)).toBe(true));
  it.each(['0', 'yes', '', 'TRUE', 'True', undefined, null, 1, true, ['1']])('%s does not', (v) => {
    expect(isPurgeRequested(v)).toBe(false);
  });
});

describe('emitWebhookChanged', () => {
  it('sends only the server id, to the server room', () => {
    emitWebhookChanged('srv-1');
    expect(h.emitted).toEqual([{ room: 'server:srv-1', event: 'webhook:changed', payload: { serverId: 'srv-1' } }]);
  });
});

describe('deleteWebhookWithPurge', () => {
  it('locks the row FOR UPDATE first, re-reads it under the lock, then deletes (no purge)', async () => {
    const result = await deleteWebhookWithPurge('wh-1', false);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = txMock.$queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toBe('SELECT id FROM webhooks WHERE id = ? FOR UPDATE');
    expect(values).toEqual(['wh-1']);
    expect(txMock.webhook.findUnique).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
      select: { serverId: true, channelId: true, name: true, type: true },
    });
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(txMock.webhook.findUnique.mock.invocationCallOrder[0]);
    expect(txMock.webhook.findUnique.mock.invocationCallOrder[0]).toBeLessThan(txMock.webhook.delete.mock.invocationCallOrder[0]);
    expect(txMock.webhook.delete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();

    expect(result).toEqual({
      webhookId: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github',
      deletedMessages: 0, perChannel: [],
    });
    // a transaction emits nothing: the caller announces after the commit
    expect(h.emitted).toHaveLength(0);
  });

  it('with purge: lock, read, groupBy, deleteMany, delete, in that order, all scoped by the webhook id', async () => {
    txMock.message.groupBy.mockResolvedValue([
      { channelId: 'ch-1', _count: { _all: 4 } },
      { channelId: 'ch-old', _count: { _all: 9 } },
    ]);
    txMock.message.deleteMany.mockResolvedValue({ count: 13 });

    const result = await deleteWebhookWithPurge('wh-1', true);

    const order = [
      txMock.$queryRaw.mock.invocationCallOrder[0],
      txMock.webhook.findUnique.mock.invocationCallOrder[0],
      txMock.message.groupBy.mock.invocationCallOrder[0],
      txMock.message.deleteMany.mock.invocationCallOrder[0],
      txMock.webhook.delete.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(txMock.message.groupBy).toHaveBeenCalledWith({ by: ['channelId'], where: { webhookId: 'wh-1' }, _count: { _all: true } });
    expect(txMock.message.deleteMany).toHaveBeenCalledWith({ where: { webhookId: 'wh-1' } });
    expect(result).toEqual({
      webhookId: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github',
      deletedMessages: 13,
      perChannel: [{ channelId: 'ch-1', count: 4 }, { channelId: 'ch-old', count: 9 }],
    });
  });

  it('drops a null-channel group (a webhook never posts to a DM; defence)', async () => {
    txMock.message.groupBy.mockResolvedValue([
      { channelId: null, _count: { _all: 1 } },
      { channelId: 'ch-1', _count: { _all: 2 } },
    ]);
    txMock.message.deleteMany.mockResolvedValue({ count: 3 });
    const result = await deleteWebhookWithPurge('wh-1', true);
    expect(result!.perChannel).toEqual([{ channelId: 'ch-1', count: 2 }]);
    expect(result!.deletedMessages).toBe(3);
  });

  it('resolves null when the lock finds no row, and touches nothing else', async () => {
    txMock.$queryRaw.mockResolvedValue([]);
    await expect(deleteWebhookWithPurge('wh-0', true)).resolves.toBeNull();
    expect(txMock.webhook.findUnique).not.toHaveBeenCalled();
    expect(txMock.message.groupBy).not.toHaveBeenCalled();
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();
    expect(txMock.webhook.delete).not.toHaveBeenCalled();
  });

  it('runs the transaction with the long budget (60 s timeout, 10 s maxWait), not Prisma\'s 5 s default', async () => {
    await deleteWebhookWithPurge('wh-1', true);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][1]).toEqual({ timeout: 60_000, maxWait: 10_000 });
  });

  it('commits enabled: false BEFORE the transaction is entered (deliveries 403 instead of queueing on the lock)', async () => {
    let disabledBeforeTx = false;
    prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) => {
      disabledBeforeTx = prismaMock.webhook.updateMany.mock.calls.length === 1;
      return cb(txMock);
    });

    await deleteWebhookWithPurge('wh-1', false);

    expect(prismaMock.webhook.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.webhook.updateMany).toHaveBeenCalledWith({ where: { id: 'wh-1' }, data: { enabled: false } });
    expect(disabledBeforeTx).toBe(true);
    expect(prismaMock.webhook.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$transaction.mock.invocationCallOrder[0]);
    expect(prismaMock.webhook.updateMany.mock.invocationCallOrder[0]).toBeLessThan(txMock.$queryRaw.mock.invocationCallOrder[0]);
  });

  it('a vanished row: the disable matches nothing (count 0), the lock finds nothing, null', async () => {
    prismaMock.webhook.updateMany.mockResolvedValue({ count: 0 });
    txMock.$queryRaw.mockResolvedValue([]);

    await expect(deleteWebhookWithPurge('wh-0', true)).resolves.toBeNull();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.webhook.delete).not.toHaveBeenCalled();
  });

  it('a failed disable aborts before the transaction (nothing deleted)', async () => {
    prismaMock.webhook.updateMany.mockRejectedValue(new Error('connection reset'));

    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toThrow('connection reset');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('rejects when a statement fails (the transaction rolls back; nothing is announced)', async () => {
    txMock.message.deleteMany.mockResolvedValue({ count: 3 });
    txMock.webhook.delete.mockRejectedValue(new Error('deadlock'));
    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toThrow('deadlock');
    expect(h.emitted).toHaveLength(0);
  });
});

describe('deleteWebhookWithPurge — the history goes in batches with no lock held', () => {
  const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim();

  it('without purge: detaches 5000 rows per UPDATE until one changes nothing, all BEFORE the transaction, none inside it', async () => {
    prismaMock.$executeRaw.mockResolvedValueOnce(5000).mockResolvedValueOnce(5000).mockResolvedValueOnce(120).mockResolvedValueOnce(0);
    const result = await deleteWebhookWithPurge('wh-1', false);

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(4);
    const [strings, ...values] = prismaMock.$executeRaw.mock.calls[0];
    expect(sqlOf([strings])).toBe('UPDATE messages SET webhook_id = NULL WHERE id IN (SELECT id FROM messages WHERE webhook_id = ? LIMIT ?)');
    expect(values).toEqual(['wh-1', 5000]);
    const lastBatch = prismaMock.$executeRaw.mock.invocationCallOrder[3];
    expect(lastBatch).toBeLessThan(prismaMock.$transaction.mock.invocationCallOrder[0]);
    // the disable is committed before the first batch
    expect(prismaMock.webhook.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$executeRaw.mock.invocationCallOrder[0]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(result!.deletedMessages).toBe(0);
    expect(result!.perChannel).toEqual([]);
  });

  it('with purge: deletes in batches RETURNING channel_id until none, and the receipts merge the batches with what the transaction still found', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ channel_id: 'ch-1' }, { channel_id: 'ch-1' }, { channel_id: 'ch-old' }, { channel_id: null }])
      .mockResolvedValueOnce([{ channel_id: 'ch-1' }])
      .mockResolvedValueOnce([]);
    // one row landed between the batches and the lock
    txMock.message.groupBy.mockResolvedValue([{ channelId: 'ch-1', _count: { _all: 1 } }]);
    txMock.message.deleteMany.mockResolvedValue({ count: 1 });

    const result = await deleteWebhookWithPurge('wh-1', true);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(3);
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0];
    expect(sqlOf([strings])).toBe('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE webhook_id = ? LIMIT ?) RETURNING channel_id');
    expect(values).toEqual(['wh-1', 5000]);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    expect(result!.deletedMessages).toBe(5);
    expect(result!.perChannel).toEqual([{ channelId: 'ch-1', count: 4 }, { channelId: 'ch-old', count: 1 }]);
  });

  it('a failing batch aborts before the lock (the webhook stays disabled, nothing announced)', async () => {
    prismaMock.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(deleteWebhookWithPurge('wh-1', false)).rejects.toThrow('db down');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

describe('disarmWebhooksHeldBy — a platform ban stops the URLs the account holds', () => {
  const HELD = { OR: [{ lastRotatedById: 'u-1' }, { lastRotatedAt: null, createdById: 'u-1' }] };

  it('disables and marks every held webhook in every server (enabled or not), then one refetch hint per server', async () => {
    prismaMock.webhook.findMany.mockResolvedValue([{ serverId: 'srv-1' }, { serverId: 'srv-2' }]);
    prismaMock.webhook.updateMany.mockResolvedValue({ count: 3 });

    const servers = await disarmWebhooksHeldBy('u-1');

    expect(prismaMock.webhook.findMany).toHaveBeenCalledWith({ where: HELD, select: { serverId: true }, distinct: ['serverId'] });
    const args = prismaMock.webhook.updateMany.mock.calls[0][0];
    expect(args.where).toEqual(HELD);
    expect(args.data.enabled).toBe(false);
    expect(args.data.creatorRemovedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(args.where)).not.toContain('enabled');
    expect(servers).toEqual(['srv-1', 'srv-2']);
    expect(h.emitted).toEqual([
      { room: 'server:srv-1', event: 'webhook:changed', payload: { serverId: 'srv-1' } },
      { room: 'server:srv-2', event: 'webhook:changed', payload: { serverId: 'srv-2' } },
    ]);
  });

  it('holds none: no write, no event', async () => {
    const servers = await disarmWebhooksHeldBy('u-9');
    expect(servers).toEqual([]);
    expect(prismaMock.webhook.updateMany).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

describe('emitWebhookDeletion', () => {
  const base: WebhookDeletion = {
    webhookId: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic',
    deletedMessages: 0, perChannel: [],
  };

  it('without purge: only the server-wide refetch hint', () => {
    emitWebhookDeletion(base, false);
    expect(h.emitted).toEqual([{ room: 'server:srv-1', event: 'webhook:changed', payload: { serverId: 'srv-1' } }]);
  });

  it('with purge: one receipt per channel, each to its own room, then the hint LAST', () => {
    emitWebhookDeletion({
      ...base, deletedMessages: 13,
      perChannel: [{ channelId: 'ch-1', count: 4 }, { channelId: 'ch-old', count: 9 }],
    }, true);
    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 4 } },
      { room: 'channel:ch-old', event: 'message:bulk_deleted', payload: { channelId: 'ch-old', webhookId: 'wh-1', count: 9 } },
      { room: 'server:srv-1', event: 'webhook:changed', payload: { serverId: 'srv-1' } },
    ]);
  });

  it('a purge that removed nothing: ONE count-0 receipt to the current channel', () => {
    emitWebhookDeletion({ ...base, channelId: 'ch-7' }, true);
    expect(h.emitted).toEqual([
      { room: 'channel:ch-7', event: 'message:bulk_deleted', payload: { channelId: 'ch-7', webhookId: 'wh-1', count: 0 } },
      { room: 'server:srv-1', event: 'webhook:changed', payload: { serverId: 'srv-1' } },
    ]);
  });

  it('no channel id or webhook name ever reaches the server room', () => {
    emitWebhookDeletion({ ...base, perChannel: [{ channelId: 'ch-staff', count: 2 }] }, true);
    for (const e of h.emitted.filter((x) => x.room.startsWith('server:'))) {
      expect(JSON.stringify(e.payload)).not.toContain('ch-');
      expect(JSON.stringify(e.payload)).not.toContain('CI');
    }
  });
});
