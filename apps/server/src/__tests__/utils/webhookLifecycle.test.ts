import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lazyStatement } from '../helpers/lazyStatement';
import { TRANSACTION_CONFLICT_RETRIES } from '../../utils/transactionRetry';

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
  disarmWebhookRowsHeldBy,
  type WebhookDeletion,
} from '../../utils/webhookLifecycle';
import { getIO } from '../../websocket/socketServer';

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
    // no purge: the in-flight rows' channels are read (to be told), nothing is deleted
    expect(txMock.message.groupBy).toHaveBeenCalledWith({ by: ['channelId'], where: { webhookId: 'wh-1' } });
    expect(txMock.message.deleteMany).not.toHaveBeenCalled();

    expect(result).toEqual({
      webhookId: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github',
      deletedMessages: 0, perChannel: [], detachedChannelIds: [],
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
      detachedChannelIds: [],
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
    const batch = (n: number, channelId: string | null) => Array.from({ length: n }, () => ({ channel_id: channelId }));
    prismaMock.$queryRaw
      .mockResolvedValueOnce(batch(5000, 'ch-1'))
      .mockResolvedValueOnce(batch(5000, 'ch-1'))
      .mockResolvedValueOnce([...batch(100, 'ch-old'), ...batch(20, null)])
      .mockResolvedValueOnce([]);
    const result = await deleteWebhookWithPurge('wh-1', false);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(4);
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0];
    expect(sqlOf([strings])).toBe('UPDATE messages SET webhook_id = NULL WHERE id IN (SELECT id FROM messages WHERE webhook_id = ? LIMIT ?) RETURNING channel_id');
    expect(values).toEqual(['wh-1', 5000]);
    const lastBatch = prismaMock.$queryRaw.mock.invocationCallOrder[3];
    expect(lastBatch).toBeLessThan(prismaMock.$transaction.mock.invocationCallOrder[0]);
    // the disable is committed before the first batch
    expect(prismaMock.webhook.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$queryRaw.mock.invocationCallOrder[0]);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    expect(result!.deletedMessages).toBe(0);
    expect(result!.perChannel).toEqual([]);
    // every channel the batches touched, once, a null channel never
    expect(result!.detachedChannelIds).toEqual(['ch-1', 'ch-old']);
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
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(deleteWebhookWithPurge('wh-1', false)).rejects.toThrow('db down');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

describe('deleteWebhookWithPurge — a deadlock or serialization failure runs the locked transaction again', () => {
  // A channel or space delete reaches the webhook row and its messages through
  // cascades, in its own order: PostgreSQL aborts one side, and the aborted
  // delete is run again whole (utils/transactionRetry.ts).
  const writeConflict = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' });
  const rawDeadlock = () => Object.assign(
    new Error('Raw query failed. Code: `40P01`. Message: `deadlock detected`'),
    { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: '40P01' } } } },
  );

  /** A statement that records `name` when it RUNS (is awaited), then fails with `err`. */
  const lazyFailure = (ran: string[], name: string, err: unknown): PromiseLike<never> => ({
    then(onFulfilled, onRejected) {
      ran.push(name);
      return Promise.reject(err).then(onFulfilled, onRejected);
    },
  });

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); });

  it('a P2034 is retried and the delete then succeeds; the receipts merge the batches with the COMMITTED attempt only', async () => {
    // the batches removed three rows before the transaction
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ channel_id: 'ch-1' }, { channel_id: 'ch-1' }, { channel_id: 'ch-old' }])
      .mockResolvedValueOnce([]);
    // attempt 1 finds 5 in-flight rows, deletes them, then loses the deadlock
    // on the row delete: rolled back, its 5 must not be counted
    txMock.message.groupBy
      .mockResolvedValueOnce([{ channelId: 'ch-1', _count: { _all: 5 } }])
      .mockResolvedValueOnce([{ channelId: 'ch-1', _count: { _all: 1 } }]);
    txMock.message.deleteMany.mockResolvedValueOnce({ count: 5 }).mockResolvedValueOnce({ count: 1 });
    txMock.webhook.delete.mockRejectedValueOnce(writeConflict()).mockResolvedValueOnce({ id: 'wh-1' });

    const result = await deleteWebhookWithPurge('wh-1', true);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    // each attempt keeps the long budget
    for (const call of prismaMock.$transaction.mock.calls) expect(call[1]).toEqual({ timeout: 60_000, maxWait: 10_000 });
    // the disable and the batches are committed work: they run once, before the first attempt
    expect(prismaMock.webhook.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(prismaMock.$transaction.mock.invocationCallOrder[0]);
    // the lock opened each attempt
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      webhookId: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github',
      deletedMessages: 4,
      perChannel: [{ channelId: 'ch-1', count: 3 }, { channelId: 'ch-old', count: 1 }],
      detachedChannelIds: [],
    });
    expect(warn).toHaveBeenCalledWith(
      '[Webhooks] The delete of webhook wh-1 was aborted by a deadlock or a serialization failure; retrying (1 of 2)',
    );
    // the transaction emits nothing: the caller announces after the commit
    expect(h.emitted).toHaveLength(0);
  });

  it('a driver deadlock (40P01) on the row lock is retried, and the delete then succeeds', async () => {
    txMock.$queryRaw.mockRejectedValueOnce(rawDeadlock()).mockResolvedValueOnce([{ id: 'wh-1' }]);

    const result = await deleteWebhookWithPurge('wh-1', false);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(txMock.webhook.delete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      webhookId: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'github',
      deletedMessages: 0, perChannel: [], detachedChannelIds: [],
    });
  });

  it('a retry that finds the row gone (the cascade removed it) resolves null, the callers\' 404, and touches nothing else', async () => {
    txMock.webhook.delete.mockRejectedValueOnce(writeConflict());
    txMock.$queryRaw.mockResolvedValueOnce([{ id: 'wh-1' }]).mockResolvedValueOnce([]);

    await expect(deleteWebhookWithPurge('wh-1', true)).resolves.toBeNull();

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    // attempt 2 stopped at its lock
    expect(txMock.webhook.findUnique).toHaveBeenCalledTimes(1);
    expect(txMock.message.deleteMany).toHaveBeenCalledTimes(1);
    expect(txMock.webhook.delete).toHaveBeenCalledTimes(1);
  });

  it('a conflict on every attempt surfaces after the retry limit (1 + TRANSACTION_CONFLICT_RETRIES attempts)', async () => {
    const conflict = writeConflict();
    txMock.webhook.delete.mockRejectedValue(conflict);

    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toBe(conflict);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1 + TRANSACTION_CONFLICT_RETRIES);
    expect(prismaMock.webhook.updateMany).toHaveBeenCalledTimes(1);
    expect(h.emitted).toHaveLength(0);
  });

  it.each([
    ['a timeout (P2028)', () => Object.assign(new Error('Transaction already closed'), { code: 'P2028' })],
    ['a foreign-key refusal (23503)', () => Object.assign(
      new Error('Raw query failed. Code: `23503`.'),
      { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: '23503' } } } },
    )],
    ['a plain error', () => new Error('connection reset')],
  ])('%s is the answer: never retried', async (_label, makeError) => {
    const err = makeError();
    txMock.webhook.delete.mockRejectedValueOnce(err);

    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toBe(err);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  // ── the history batches meet the same deletes ─────────────────────────────

  it('a purge batch aborted by a deadlock is run again alone; only the run that committed is counted', async () => {
    const ran: string[] = [];
    prismaMock.$queryRaw
      .mockImplementationOnce(() => lazyFailure(ran, 'batch', rawDeadlock()))
      .mockImplementationOnce(() => lazyStatement(ran, 'batch', [{ channel_id: 'ch-1' }, { channel_id: 'ch-1' }]))
      .mockImplementationOnce(() => lazyStatement(ran, 'batch', []));

    const result = await deleteWebhookWithPurge('wh-1', true);

    expect(ran).toEqual(['batch', 'batch', 'batch']);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(result!.deletedMessages).toBe(2);
    expect(result!.perChannel).toEqual([{ channelId: 'ch-1', count: 2 }]);
    expect(warn).toHaveBeenCalledWith(
      '[Webhooks] A history batch of webhook wh-1 was aborted by a deadlock or a serialization failure; retrying (1 of 2)',
    );
  });

  it('a detach batch aborted by a write conflict is run again too', async () => {
    prismaMock.$queryRaw
      .mockRejectedValueOnce(writeConflict())
      .mockResolvedValueOnce([{ channel_id: 'ch-1' }])
      .mockResolvedValueOnce([]);

    const result = await deleteWebhookWithPurge('wh-1', false);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(3);
    expect(result!.deletedMessages).toBe(0);
    expect(result!.detachedChannelIds).toEqual(['ch-1']);
    expect(h.emitted).toHaveLength(0);
  });

  it('a batch failing for good after earlier batches committed: their receipts go out, then the error surfaces', async () => {
    const reset = new Error('connection reset');
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ channel_id: 'ch-1' }, { channel_id: 'ch-1' }, { channel_id: 'ch-old' }])
      .mockRejectedValueOnce(reset);

    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toBe(reset);

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 2 } },
      { room: 'channel:ch-old', event: 'message:bulk_deleted', payload: { channelId: 'ch-old', webhookId: 'wh-1', count: 1 } },
    ]);
  });

  it('a batch deadlocked on every run surfaces after the retry limit, with the committed batches announced', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ channel_id: 'ch-1' }]);
    for (let i = 0; i <= TRANSACTION_CONFLICT_RETRIES; i++) prismaMock.$queryRaw.mockRejectedValueOnce(rawDeadlock());

    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toMatchObject({ code: 'P2010' });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2 + TRANSACTION_CONFLICT_RETRIES);
    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 1 } },
    ]);
  });

  it.each([
    ['a conflict on every attempt', () => {
      for (let i = 0; i <= TRANSACTION_CONFLICT_RETRIES; i++) txMock.webhook.delete.mockRejectedValueOnce(writeConflict());
    }, 1 + TRANSACTION_CONFLICT_RETRIES],
    ['a timeout (P2028)', () => {
      txMock.webhook.delete.mockRejectedValueOnce(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }));
    }, 1],
  ])('the locked transaction failing for good (%s) after committed batches: the batch counts are announced, then the error surfaces', async (_label, arrange, attempts) => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ channel_id: 'ch-1' }]).mockResolvedValueOnce([]);
    // every attempt finds and deletes in-flight rows, then is rolled back
    txMock.message.groupBy.mockResolvedValue([{ channelId: 'ch-1', _count: { _all: 5 } }]);
    txMock.message.deleteMany.mockResolvedValue({ count: 5 });
    arrange();

    await expect(deleteWebhookWithPurge('wh-1', true)).rejects.toThrow();

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(attempts);
    // the batches only: the rolled-back attempts' 5 are not counted
    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 1 } },
    ]);
  });

  it('each attempt runs the lock FIRST, then the read, the count, the purge and the delete (recorded when each statement runs)', async () => {
    const ran: string[] = [];
    txMock.$queryRaw.mockImplementation(() => lazyStatement(ran, 'lock', [{ id: 'wh-1' }]));
    txMock.webhook.findUnique.mockImplementation(() => lazyStatement(ran, 'read', LOCKED_ROW));
    txMock.message.groupBy.mockImplementation(() => lazyStatement(ran, 'count', []));
    txMock.message.deleteMany.mockImplementation(() => lazyStatement(ran, 'purge', { count: 0 }));
    txMock.webhook.delete
      .mockImplementationOnce(() => lazyFailure(ran, 'delete', writeConflict()))
      .mockImplementationOnce(() => lazyStatement(ran, 'delete', { id: 'wh-1' }));

    await deleteWebhookWithPurge('wh-1', true);

    expect(ran).toEqual([
      'lock', 'read', 'count', 'purge', 'delete', // attempt 1: aborted on the delete
      'lock', 'read', 'count', 'purge', 'delete', // attempt 2: from the lock again
    ]);
  });
});

describe('deleteWebhookWithPurge — a webhook gone by the lock still announces what the batches deleted', () => {
  // The batches commit before the transaction. When the lock then finds no row
  // (a concurrent delete of the same webhook won it, or a cascade removed it)
  // the callers answer 404 and announce nothing, so the function sends the
  // batches' receipts itself, or open clients keep showing those rows.
  const BATCH_ROWS = [{ channel_id: 'ch-1' }, { channel_id: 'ch-1' }, { channel_id: 'ch-old' }];

  it('with purge: one receipt per channel the batches emptied, counts from the batches, and nothing else', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce(BATCH_ROWS).mockResolvedValueOnce([]);
    txMock.$queryRaw.mockResolvedValue([]);

    await expect(deleteWebhookWithPurge('wh-1', true)).resolves.toBeNull();

    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 2 } },
      { room: 'channel:ch-old', event: 'message:bulk_deleted', payload: { channelId: 'ch-old', webhookId: 'wh-1', count: 1 } },
    ]);
    // no count-0 receipt and no refetch hint: those belong to the delete that committed
    expect(h.emitted.some((e) => e.room.startsWith('server:'))).toBe(false);
  });

  it('a retry that finds the row gone counts the batches only, never the rolled-back attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      prismaMock.$queryRaw.mockResolvedValueOnce([{ channel_id: 'ch-1' }]).mockResolvedValueOnce([]);
      txMock.$queryRaw.mockResolvedValueOnce([{ id: 'wh-1' }]).mockResolvedValueOnce([]);
      txMock.message.groupBy.mockResolvedValueOnce([{ channelId: 'ch-1', _count: { _all: 5 } }]);
      txMock.message.deleteMany.mockResolvedValueOnce({ count: 5 });
      txMock.webhook.delete.mockRejectedValueOnce(Object.assign(new Error('write conflict'), { code: 'P2034' }));

      await expect(deleteWebhookWithPurge('wh-1', true)).resolves.toBeNull();

      expect(h.emitted).toEqual([
        { room: 'channel:ch-1', event: 'message:bulk_deleted', payload: { channelId: 'ch-1', webhookId: 'wh-1', count: 1 } },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('nothing to announce: without purge (rows detached, none deleted) and when the batches found nothing', async () => {
    prismaMock.$executeRaw.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    txMock.$queryRaw.mockResolvedValue([]);
    await expect(deleteWebhookWithPurge('wh-1', false)).resolves.toBeNull();
    expect(h.emitted).toHaveLength(0);

    await expect(deleteWebhookWithPurge('wh-0', true)).resolves.toBeNull();
    expect(h.emitted).toHaveLength(0);
  });

  it('a committed delete announces nothing itself: the caller sends the receipts (emitWebhookDeletion)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce(BATCH_ROWS).mockResolvedValueOnce([]);

    const result = await deleteWebhookWithPurge('wh-1', true);

    expect(result!.perChannel).toEqual([{ channelId: 'ch-1', count: 2 }, { channelId: 'ch-old', count: 1 }]);
    expect(h.emitted).toHaveLength(0);
  });

  it('a receipt that cannot be sent is logged, and the answer stays null (the deletes are committed)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      prismaMock.$queryRaw.mockResolvedValueOnce(BATCH_ROWS).mockResolvedValueOnce([]);
      txMock.$queryRaw.mockResolvedValue([]);
      vi.mocked(getIO).mockImplementationOnce(() => { throw new Error('Socket.IO not initialized'); });

      await expect(deleteWebhookWithPurge('wh-1', true)).resolves.toBeNull();

      expect(error).toHaveBeenCalledWith(
        '[Webhooks] The receipts of the messages purged with webhook wh-1 (gone by its lock) were not sent:',
        'Socket.IO not initialized',
      );
    } finally {
      error.mockRestore();
    }
  });
});

describe('deleteWebhookWithPurge — rows detached by committed batches are announced when no delete commits after them', () => {
  it('a webhook gone by the lock: the channels the batches detached are told, with no hint and no receipt', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ channel_id: 'ch-1' }, { channel_id: 'ch-1' }, { channel_id: 'ch-old' }]).mockResolvedValueOnce([]);
    txMock.$queryRaw.mockResolvedValue([]);

    await expect(deleteWebhookWithPurge('wh-1', false)).resolves.toBeNull();

    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'webhook:messages_detached', payload: { channelId: 'ch-1', webhookId: 'wh-1' } },
      { room: 'channel:ch-old', event: 'webhook:messages_detached', payload: { channelId: 'ch-old', webhookId: 'wh-1' } },
    ]);
  });

  it('a transaction failing for good: the committed batches are announced, then the error surfaces', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ channel_id: 'ch-1' }]).mockResolvedValueOnce([]);
    txMock.webhook.delete.mockRejectedValue(new Error('deadlock'));

    await expect(deleteWebhookWithPurge('wh-1', false)).rejects.toThrow('deadlock');

    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'webhook:messages_detached', payload: { channelId: 'ch-1', webhookId: 'wh-1' } },
    ]);
  });

  it('a webhook that posted nowhere announces nothing on any path', async () => {
    txMock.$queryRaw.mockResolvedValue([]);
    await expect(deleteWebhookWithPurge('wh-1', false)).resolves.toBeNull();
    expect(h.emitted).toHaveLength(0);
  });

  it('in-flight rows the batches missed (read under the lock) are announced with the committed delete', async () => {
    txMock.message.groupBy.mockResolvedValue([{ channelId: 'ch-9' }, { channelId: null }]);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ channel_id: 'ch-1' }]).mockResolvedValueOnce([]);

    const result = await deleteWebhookWithPurge('wh-1', false);

    expect(result!.detachedChannelIds).toEqual(['ch-1', 'ch-9']);
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

  it('the write half runs on the client it is given (a ban transaction) and announces nothing itself', async () => {
    const tx = {
      webhook: {
        findMany: vi.fn().mockResolvedValue([{ serverId: 'srv-1' }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const servers = await disarmWebhookRowsHeldBy(tx as never, 'u-1');

    expect(servers).toEqual(['srv-1']);
    expect(tx.webhook.findMany).toHaveBeenCalledWith({ where: HELD, select: { serverId: true }, distinct: ['serverId'] });
    expect(tx.webhook.updateMany).toHaveBeenCalledWith({ where: HELD, data: { enabled: false, creatorRemovedAt: expect.any(Date) } });
    // Sequential, never overlapping on the transaction's one connection
    expect(tx.webhook.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.webhook.findMany.mock.invocationCallOrder[0]);
    expect(prismaMock.webhook.findMany).not.toHaveBeenCalled();
    expect(prismaMock.webhook.updateMany).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

describe('emitWebhookDeletion', () => {
  const base: WebhookDeletion = {
    webhookId: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic',
    deletedMessages: 0, perChannel: [], detachedChannelIds: [],
  };

  it('without purge and a webhook that posted nowhere: only the server-wide refetch hint', () => {
    emitWebhookDeletion(base, false);
    expect(h.emitted).toEqual([{ room: 'server:srv-1', event: 'webhook:changed', payload: { serverId: 'srv-1' } }]);
  });

  it('without purge: one detached notice per channel, each to its own room, then the hint LAST', () => {
    emitWebhookDeletion({ ...base, detachedChannelIds: ['ch-1', 'ch-old'] }, false);
    expect(h.emitted).toEqual([
      { room: 'channel:ch-1', event: 'webhook:messages_detached', payload: { channelId: 'ch-1', webhookId: 'wh-1' } },
      { room: 'channel:ch-old', event: 'webhook:messages_detached', payload: { channelId: 'ch-old', webhookId: 'wh-1' } },
      { room: 'server:srv-1', event: 'webhook:changed', payload: { serverId: 'srv-1' } },
    ]);
  });

  it('without purge: no channel id ever reaches the server room, and the hint still carries the server id alone', () => {
    emitWebhookDeletion({ ...base, detachedChannelIds: ['ch-staff'] }, false);
    for (const e of h.emitted.filter((x) => x.room.startsWith('server:'))) {
      expect(e.payload).toEqual({ serverId: 'srv-1' });
    }
    expect(h.emitted.filter((x) => x.event === 'webhook:messages_detached').every((x) => x.room.startsWith('channel:'))).toBe(true);
  });

  it('with purge: no detached notice (the receipts are the notice)', () => {
    emitWebhookDeletion({ ...base, detachedChannelIds: ['ch-1'], perChannel: [{ channelId: 'ch-1', count: 1 }] }, true);
    expect(h.emitted.map((e) => e.event)).toEqual(['message:bulk_deleted', 'webhook:changed']);
  });

  it('a notice that cannot be sent is logged by message, the other channels still get theirs, the hint still goes, nothing throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(getIO).mockImplementationOnce(() => { throw new Error('Socket.IO not initialized'); });
      expect(() => emitWebhookDeletion({ ...base, detachedChannelIds: ['ch-1', 'ch-2'] }, false)).not.toThrow();
      expect(error).toHaveBeenCalledWith(
        '[Webhooks] The notice that the messages of deleted webhook wh-1 were detached was not sent to channel ch-1:',
        'Socket.IO not initialized',
      );
      expect(h.emitted.map((e) => e.room)).toEqual(['channel:ch-2', 'server:srv-1']);
    } finally {
      error.mockRestore();
    }
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
