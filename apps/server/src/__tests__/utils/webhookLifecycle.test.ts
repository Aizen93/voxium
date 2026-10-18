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
  // Only a transaction: every statement of the delete runs on its client
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
  type WebhookDeletion,
} from '../../utils/webhookLifecycle';

const CREATED_AT = new Date('2026-10-18T10:00:00.000Z');
const USED_AT = new Date('2026-10-18T11:30:00.000Z');
const LOCKED_ROW = { serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github' };

beforeEach(() => {
  vi.clearAllMocks();
  h.emitted.length = 0;
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) => cb(txMock));
  txMock.$queryRaw.mockResolvedValue([{ id: 'wh-1' }]);
  txMock.webhook.findUnique.mockResolvedValue(LOCKED_ROW);
  txMock.message.groupBy.mockResolvedValue([]);
  txMock.message.deleteMany.mockResolvedValue({ count: 0 });
  txMock.webhook.delete.mockResolvedValue({ id: 'wh-1' });
});

describe('webhookSelect / toWebhook', () => {
  it('selects exactly the public columns: never the token hash nor the sealed secret', () => {
    expect(Object.keys(webhookSelect).sort()).toEqual(
      ['channelId', 'createdAt', 'createdBy', 'enabled', 'id', 'lastUsedAt', 'name', 'serverId', 'type'],
    );
    expect(webhookSelect.createdBy).toEqual({ select: { id: true, username: true, displayName: true } });
  });

  it('maps a row to the shared Webhook shape by whitelist (extra columns never pass)', () => {
    const row = {
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: false,
      createdAt: CREATED_AT, lastUsedAt: USED_AT,
      createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice', email: 'leak@example.test' },
      tokenHash: 'f'.repeat(64), secretEnc: 'sealed',
    };
    expect(toWebhook(row)).toEqual({
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: false,
      createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice' },
      createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: '2026-10-18T11:30:00.000Z',
    });
  });

  it('keeps a deleted creator and a never-used webhook as null', () => {
    const out = toWebhook({
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github', enabled: true,
      createdAt: CREATED_AT, lastUsedAt: null, createdBy: null,
    });
    expect(out.createdBy).toBeNull();
    expect(out.lastUsedAt).toBeNull();
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

  it('rejects when a statement fails (the transaction rolls back; nothing is announced)', async () => {
    txMock.message.deleteMany.mockResolvedValue({ count: 3 });
    txMock.webhook.delete.mockRejectedValue(new Error('deadlock'));
    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toThrow('deadlock');
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
