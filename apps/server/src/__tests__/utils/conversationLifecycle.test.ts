import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lazyStatement } from '../helpers/lazyStatement';

// ─── A transaction client that records each statement when it RUNS ─────────

const h = vi.hoisted(() => ({
  ran: [] as string[],
  results: new Map<string, unknown>(),
  options: [] as unknown[],
  collectKeysClient: [] as unknown[],
}));

/** A name for a raw statement, from its SQL. */
function rawName(sql: string): string {
  if (/FOR KEY SHARE/.test(sql)) return 'lock: conversation FOR KEY SHARE';
  if (/FOR UPDATE/.test(sql)) return 'lock: conversation FOR UPDATE';
  if (/INSERT INTO conversation_reads/.test(sql)) return 'upsert: remover read row';
  if (/EXISTS/.test(sql)) return 'read: sides with EXISTS above floor';
  return `raw: ${sql.slice(0, 40)}`;
}

const rawCalls: Array<{ sql: string; values: unknown[] }> = [];

function statement(name: string, fallback: unknown) {
  return (...args: unknown[]) => {
    const result = h.results.has(name) ? h.results.get(name) : fallback;
    const value = typeof result === 'function' ? (result as (...a: unknown[]) => unknown)(...args) : result;
    return lazyStatement(h.ran, name, value);
  };
}

const tx = {
  $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    rawCalls.push({ sql, values });
    const name = rawName(sql);
    const result = h.results.has(name) ? h.results.get(name) : [];
    return lazyStatement(h.ran, name, typeof result === 'function' ? (result as () => unknown)() : result);
  }),
  conversation: {
    findUnique: vi.fn(statement('read: conversation sides', null)),
    delete: vi.fn(statement('delete: conversation', {})),
  },
  conversationRead: {
    updateMany: vi.fn(statement('update: unhide read rows', { count: 0 })),
  },
  message: {
    findFirst: vi.fn(statement('read: newest message', null)),
    aggregate: vi.fn(statement('read: newest message time (max)', { _max: { createdAt: null } })),
  },
};

const sharedUpdateMany = vi.hoisted(() => vi.fn());
// the audience read after the commit (utils/conversationAudience.ts), on the shared client
const sharedAudience = vi.hoisted(() => vi.fn());

vi.mock('../../utils/prisma', () => ({
  prisma: {
    $transaction: vi.fn(),
    conversation: { updateMany: (...args: unknown[]) => sharedUpdateMany(...args) },
    conversationRead: { findMany: (...args: unknown[]) => sharedAudience(...args) },
  },
}));

vi.mock('../../utils/attachmentBlobs', () => ({
  collectAttachmentKeys: vi.fn((where: unknown, db: unknown) => {
    h.collectKeysClient.push(db);
    return lazyStatement(h.ran, 'read: attachment keys', ['attachments/dm-conv-1/abc-encrypted.bin']);
  }),
}));

import { prisma } from '../../utils/prisma';
import { collectAttachmentKeys } from '../../utils/attachmentBlobs';
import { LOCK_WAIT_TRANSACTION_OPTIONS } from '../../utils/transactionRetry';
import {
  changeConversationMessage,
  reopenConversationForUser,
  removeConversationForUser,
  writeConversationMessage,
} from '../../utils/conversationLifecycle';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const sides = (reads: Array<{ userId: string; hiddenAt: Date | null; clearedAt: Date | null }>, s: { user1Id: string | null; user2Id: string | null } = { user1Id: 'user-1', user2Id: 'user-2' }) =>
  ({ id: 'conv-1', ...s, reads });

beforeEach(() => {
  h.ran.length = 0;
  h.results.clear();
  h.options.length = 0;
  h.collectKeysClient.length = 0;
  rawCalls.length = 0;
  vi.clearAllMocks();
  sharedUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  sharedAudience.mockReset().mockResolvedValue([]);
  vi.mocked(prisma.$transaction).mockReset().mockImplementation((async (fn: (client: unknown) => unknown, options: unknown) => {
    h.options.push(options);
    return fn(tx);
  }) as any);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});


// ─── A new message ──────────────────────────────────────────────────────────

describe('writeConversationMessage', () => {
  const insert = vi.fn(async (_tx: unknown, ctx: { createdAt: Date }) => {
    h.ran.push('insert: message');
    return { id: 'msg-1', createdAt: ctx.createdAt };
  });
  const announced: Array<{ message: unknown; audience: unknown }> = [];
  const announce = vi.fn((message: unknown, audience: unknown) => {
    h.ran.push('announce');
    announced.push({ message, audience });
  });
  const write = (fn: typeof insert | ((tx: unknown, ctx: { createdAt: Date }) => Promise<{ createdAt: Date }>) = insert) =>
    writeConversationMessage('conv-1', 'user-1', fn as typeof insert, announce);

  /** The rows as the lock reads them, and as the audience read after the commit finds them. */
  function stage(reads: Array<{ userId: string; hiddenAt: Date | null; clearedAt: Date | null }> = [], opts: { newest?: Date | null; audience?: unknown[] } = {}) {
    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', sides(reads));
    h.results.set('read: newest message time (max)', { _max: { createdAt: opts.newest ?? null } });
    sharedAudience.mockImplementation(() => lazyStatement(h.ran, 'read: audience after the commit', opts.audience ?? reads));
  }

  beforeEach(() => {
    insert.mockClear();
    announce.mockClear();
    announced.length = 0;
  });

  it('locks the conversation row FIRST (key share), re-checks participation, reads the newest message, inserts, and unhides in one statement', async () => {
    stage([
      { userId: 'user-1', hiddenAt: null, clearedAt: null },
      { userId: 'user-2', hiddenAt: new Date('2026-11-16T11:00:00Z'), clearedAt: new Date('2026-11-16T10:00:00Z') },
    ]);

    const { message, context } = await write();

    expect(h.ran.slice(0, 5)).toEqual([
      'lock: conversation FOR KEY SHARE',
      'read: conversation sides',
      'read: newest message time (max)',
      'insert: message',
      'update: unhide read rows',
    ]);
    expect(message.createdAt).toEqual(NOW);
    expect(context.authorFloor).toBeNull();
    expect(tx.conversationRead.updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1', hiddenAt: { not: null }, OR: [{ clearedAt: null }, { clearedAt: { lt: NOW } }] },
      data: { hiddenAt: null },
    });
    // the sides and the newest message read through the transaction's own client
    expect(tx.conversation.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv-1' } }));
    expect(tx.message.aggregate).toHaveBeenCalledWith({ where: { conversationId: 'conv-1' }, _max: { createdAt: true } });
    expect(h.options).toEqual([LOCK_WAIT_TRANSACTION_OPTIONS]);
    expect(rawCalls[0].values).toEqual(['conv-1']);
  });

  it('after the commit, holding nothing: the audience read, the event, THEN the list-order bump', async () => {
    stage([]);
    let committed = false;
    vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: (client: unknown) => Promise<unknown>) => {
      const out = await fn(tx);
      committed = true;
      h.ran.push('commit');
      return out;
    }) as any);
    sharedUpdateMany.mockImplementationOnce(() => {
      expect(committed).toBe(true);
      return lazyStatement(h.ran, 'bump: conversation list order', { count: 0 });
    });

    await write();

    expect(h.ran.slice(-4)).toEqual(['commit', 'read: audience after the commit', 'announce', 'bump: conversation list order']);
    expect(sharedAudience).toHaveBeenCalledWith({ where: { conversationId: 'conv-1' }, select: { userId: true, hiddenAt: true, clearedAt: true } });
    expect(sharedUpdateMany).toHaveBeenCalledWith({ where: { id: 'conv-1' }, data: { updatedAt: NOW } });
  });

  it('a removal queued behind the write that commits before the event: the event sees its floor (the audience is read after the commit)', async () => {
    // Under the lock nobody has a floor; by the time the event goes out the
    // remover's floor is the new row itself
    stage([
      { userId: 'user-1', hiddenAt: null, clearedAt: null },
      { userId: 'user-2', hiddenAt: null, clearedAt: null },
    ], {
      audience: [
        { userId: 'user-1', hiddenAt: null, clearedAt: null },
        { userId: 'user-2', hiddenAt: NOW, clearedAt: NOW },
      ],
    });

    const { context } = await write();

    expect(context.sides.every((s) => s.clearedAt === null)).toBe(true);
    expect(announced).toEqual([{
      message: { id: 'msg-1', createdAt: NOW },
      audience: [
        { userId: 'user-1', hiddenAt: null, clearedAt: null },
        { userId: 'user-2', hiddenAt: NOW, clearedAt: NOW },
      ],
    }]);
  });

  it('an audience that cannot be read falls back to the rows read under the lock (logged)', async () => {
    const reads = [{ userId: 'user-2', hiddenAt: null, clearedAt: new Date('2026-11-16T10:00:00Z') }];
    stage(reads);
    sharedAudience.mockImplementationOnce(() => Promise.reject(new Error('db blip')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await write();

    expect(announced[0].audience).toEqual(reads);
    expect(warn).toHaveBeenCalledWith('[DM] The audience of an event in conversation conv-1 could not be read (the floors read earlier apply):', 'db blip');
    warn.mockRestore();
  });

  it('an announce that throws is logged; the bump still runs and the message is still written', async () => {
    stage([]);
    announce.mockImplementationOnce(() => { throw new Error('adapter publish failed'); });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { message } = await write();

    expect(message.id).toBe('msg-1');
    expect(errorLog).toHaveBeenCalledWith('[DM] A message was written in conversation conv-1, but announcing it failed:', 'adapter publish failed');
    expect(sharedUpdateMany).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it('a bump that fails is logged and never fails the message', async () => {
    stage([]);
    sharedUpdateMany.mockRejectedValueOnce(new Error('db blip'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { message } = await write();

    expect(message.id).toBe('msg-1');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[DM] The list order of conversation conv-1 was not moved after a new message:', 'db blip');
    warn.mockRestore();
  });

  it('nobody hidden: no unhide statement at all (a removal cannot hide it while the lock is held)', async () => {
    stage([
      { userId: 'user-1', hiddenAt: null, clearedAt: new Date('2026-11-16T10:00:00Z') },
      { userId: 'user-2', hiddenAt: null, clearedAt: null },
    ]);

    await write();

    expect(h.ran).not.toContain('update: unhide read rows');
  });

  it('the new row is later than every floor: one millisecond after a floor that is now or later', async () => {
    const ahead = new Date('2026-11-16T12:00:03.000Z');
    stage([
      { userId: 'user-1', hiddenAt: null, clearedAt: null },
      { userId: 'user-2', hiddenAt: ahead, clearedAt: ahead },
    ]);

    const { message, context } = await write();

    expect(context.createdAt.toISOString()).toBe('2026-11-16T12:00:03.001Z');
    expect(message.createdAt).toEqual(context.createdAt);
    expect(tx.conversationRead.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ clearedAt: null }, { clearedAt: { lt: context.createdAt } }] }),
    }));
  });

  it('…and later than the newest message: under a floor ahead of the clock, each write gets a later stamp than the one before', async () => {
    const ahead = new Date('2026-11-16T12:00:05.000Z');
    stage([{ userId: 'user-2', hiddenAt: null, clearedAt: ahead }], { newest: new Date('2026-11-16T12:00:05.001Z') });

    const { context } = await write();

    expect(context.createdAt.toISOString()).toBe('2026-11-16T12:00:05.002Z');
  });

  it('never before an existing message, with no floor at all (a message stamped by a clock ahead of this one)', async () => {
    stage([], { newest: new Date('2026-11-16T12:00:09.000Z') });

    const { context } = await write();

    expect(context.createdAt.toISOString()).toBe('2026-11-16T12:00:09.001Z');
  });

  it('gives the write the author\'s own floor, read under the lock', async () => {
    const authorFloor = new Date('2026-11-16T09:00:00Z');
    stage([{ userId: 'user-1', hiddenAt: null, clearedAt: authorFloor }]);

    const { context } = await write();

    expect(context.authorFloor).toEqual(authorFloor);
    expect(insert).toHaveBeenCalledWith(tx, expect.objectContaining({ authorFloor }));
  });

  it('a conversation deleted while it waited answers 404 Conversation, and nothing else runs (no event, no bump)', async () => {
    h.results.set('lock: conversation FOR KEY SHARE', []);

    await expect(write()).rejects.toMatchObject({ statusCode: 404, message: 'Conversation not found' });
    expect(h.ran).toEqual(['lock: conversation FOR KEY SHARE']);
    expect(insert).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(sharedUpdateMany).not.toHaveBeenCalled();
  });

  it('an author who is not a participant (a NULL side never is) answers 403 after the wait', async () => {
    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', sides([], { user1Id: null, user2Id: 'user-2' }));

    await expect(write()).rejects.toMatchObject({ statusCode: 403 });
    expect(insert).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('a conversation whose other side is gone (read-only) is refused under the lock, a write that waited for an account deletion included: 403, nothing written', async () => {
    for (const other of [{ user1Id: 'user-1', user2Id: null }, { user1Id: null, user2Id: 'user-1' }]) {
      h.ran.length = 0;
      h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
      // the sides as the lock finds them: the deletion committed while the write waited
      h.results.set('read: conversation sides', sides([{ userId: 'user-1', hiddenAt: null, clearedAt: null }], other));

      await expect(write()).rejects.toMatchObject({ statusCode: 403, message: 'This conversation is read-only' });
      expect(h.ran).toEqual(['lock: conversation FOR KEY SHARE', 'read: conversation sides']);
    }
    expect(insert).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(sharedUpdateMany).not.toHaveBeenCalled();
    expect(sharedAudience).not.toHaveBeenCalled();
  });

  it('refuses a row written with any other time: the guarantee rests on it', async () => {
    stage([]);

    await expect(write(async () => ({ createdAt: new Date(0) })))
      .rejects.toThrow('writeConversationMessage: the row must carry context.createdAt');
    expect(announce).not.toHaveBeenCalled();
    expect(sharedUpdateMany).not.toHaveBeenCalled();
  });

  it('runs again whole after a deadlock (P2034), and announces once', async () => {
    stage([]);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useRealTimers();

    await write();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[DM] A message write in conversation conv-1 was aborted by a deadlock'));
    warn.mockRestore();
  });
});

// ─── A removal ──────────────────────────────────────────────────────────────

describe('removeConversationForUser', () => {
  const newest = new Date('2026-11-16T11:30:00.000Z');

  function stage(opts: {
    conversationSides?: { user1Id: string | null; user2Id: string | null } | null;
    newestAt?: Date | null;
    clearedAt?: Date | null;
    states?: Array<{ userId: string; hidden: boolean; messageAboveFloor: boolean }>;
  } = {}) {
    h.results.set('lock: conversation FOR UPDATE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', opts.conversationSides === undefined ? { user1Id: 'user-1', user2Id: 'user-2' } : opts.conversationSides);
    h.results.set('read: newest message', opts.newestAt === null ? null : { createdAt: opts.newestAt ?? newest });
    h.results.set('upsert: remover read row', [{ clearedAt: opts.clearedAt === undefined ? null : opts.clearedAt }]);
    h.results.set('read: sides with EXISTS above floor', opts.states ?? [
      { userId: 'user-1', hidden: true, messageAboveFloor: true },
      { userId: 'user-2', hidden: false, messageAboveFloor: true },
    ]);
  }

  it('locks the conversation row FOR UPDATE first, then the sides, the newest message, ONE upsert of the remover\'s row, then every side\'s state', async () => {
    stage();

    const out = await removeConversationForUser('conv-1', 'user-1', { clearHistory: false });

    expect(h.ran).toEqual([
      'lock: conversation FOR UPDATE',
      'read: conversation sides',
      'read: newest message',
      'upsert: remover read row',
      'read: sides with EXISTS above floor',
    ]);
    expect(out).toEqual({ deleted: false, clearedUntil: null, attachmentKeys: [] });
    expect(h.options).toEqual([LOCK_WAIT_TRANSACTION_OPTIONS]);
    expect(tx.message.findFirst).toHaveBeenCalledWith({ where: { conversationId: 'conv-1' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    // never a write to the conversations row on a removal
    expect(tx.conversation.delete).not.toHaveBeenCalled();
    expect(sharedUpdateMany).not.toHaveBeenCalled();
  });

  it('the upsert: hidden, the last read raised to the newest message, the floor raised only with clearHistory, never moved back', async () => {
    stage({ clearedAt: newest });

    const out = await removeConversationForUser('conv-1', 'user-1', { clearHistory: true });

    const upsert = rawCalls.find((c) => /INSERT INTO conversation_reads/.test(c.sql))!;
    expect(upsert.values).toEqual(['user-1', 'conv-1', newest, NOW, newest]);
    expect(upsert.sql).toMatch(/ON CONFLICT \(user_id, conversation_id\) DO UPDATE SET/);
    expect(upsert.sql).toMatch(/hidden_at = COALESCE\(conversation_reads\.hidden_at, EXCLUDED\.hidden_at\)/);
    expect(upsert.sql).toMatch(/last_read_at = GREATEST\(conversation_reads\.last_read_at, EXCLUDED\.last_read_at\)/);
    expect(upsert.sql).toMatch(/cleared_at = GREATEST\(conversation_reads\.cleared_at, EXCLUDED\.cleared_at\)/);
    expect(upsert.sql).toMatch(/RETURNING cleared_at AS "clearedAt"/);
    expect(out.clearedUntil).toEqual(newest);
  });

  it('a hide alone passes no floor (GREATEST keeps any earlier one) and reports none', async () => {
    stage({ clearedAt: new Date('2026-11-01T00:00:00Z') });

    const out = await removeConversationForUser('conv-1', 'user-1', { clearHistory: false });

    const upsert = rawCalls.find((c) => /INSERT INTO conversation_reads/.test(c.sql))!;
    expect(upsert.values).toEqual(['user-1', 'conv-1', newest, NOW, null]);
    expect(out.clearedUntil).toBeNull();
  });

  it('an empty conversation: the last read is now and there is nothing to clear', async () => {
    stage({ newestAt: null, clearedAt: null, states: [{ userId: 'user-1', hidden: true, messageAboveFloor: false }, { userId: 'user-2', hidden: false, messageAboveFloor: false }] });

    const out = await removeConversationForUser('conv-1', 'user-1', { clearHistory: true });

    const upsert = rawCalls.find((c) => /INSERT INTO conversation_reads/.test(c.sql))!;
    expect(upsert.values).toEqual(['user-1', 'conv-1', NOW, NOW, null]);
    expect(out).toEqual({ deleted: false, clearedUntil: null, attachmentKeys: [] });
  });

  it('the EXISTS reads each side\'s messages strictly above its own floor', async () => {
    stage();

    await removeConversationForUser('conv-1', 'user-1', { clearHistory: false });

    const reach = rawCalls.find((c) => /EXISTS/.test(c.sql))!;
    expect(reach.sql).toMatch(/r\.cleared_at IS NULL OR m\.created_at > r\.cleared_at/);
    expect(reach.sql).toMatch(/WHERE r\.conversation_id = \?/);
    expect(reach.values).toEqual(['conv-1']);
  });

  it('nobody can reach it: the attachment keys through the transaction\'s own client, then the delete, in that order and in this transaction', async () => {
    stage({
      clearedAt: newest,
      states: [
        { userId: 'user-1', hidden: true, messageAboveFloor: false },
        { userId: 'user-2', hidden: true, messageAboveFloor: false },
      ],
    });

    const out = await removeConversationForUser('conv-1', 'user-1', { clearHistory: true });

    expect(h.ran.slice(-2)).toEqual(['read: attachment keys', 'delete: conversation']);
    expect(collectAttachmentKeys).toHaveBeenCalledWith({ conversationId: 'conv-1' }, tx);
    expect(tx.conversation.delete).toHaveBeenCalledWith({ where: { id: 'conv-1' } });
    expect(out).toEqual({ deleted: true, clearedUntil: newest, attachmentKeys: ['attachments/dm-conv-1/abc-encrypted.bin'] });
  });

  it('the other side has it hidden but can still reach its history (a hide without clearing): kept', async () => {
    stage({
      states: [
        { userId: 'user-1', hidden: true, messageAboveFloor: false },
        { userId: 'user-2', hidden: true, messageAboveFloor: true },
      ],
    });

    expect((await removeConversationForUser('conv-1', 'user-1', { clearHistory: true })).deleted).toBe(false);
    expect(tx.conversation.delete).not.toHaveBeenCalled();
  });

  it('the other side has no read row: never hidden, so kept', async () => {
    stage({ states: [{ userId: 'user-1', hidden: true, messageAboveFloor: false }] });

    expect((await removeConversationForUser('conv-1', 'user-1', { clearHistory: true })).deleted).toBe(false);
  });

  it('a NULL other side (a deleted account) counts as hidden with an infinite floor: the remover hiding is enough, history or not', async () => {
    for (const conversationSides of [{ user1Id: 'user-1', user2Id: null }, { user1Id: null, user2Id: 'user-1' }]) {
      h.ran.length = 0;
      stage({ conversationSides, states: [{ userId: 'user-1', hidden: true, messageAboveFloor: true }] });
      expect((await removeConversationForUser('conv-1', 'user-1', { clearHistory: false })).deleted, JSON.stringify(conversationSides)).toBe(true);
    }
  });

  it('a conversation already gone answers 404 Conversation and writes nothing', async () => {
    h.results.set('lock: conversation FOR UPDATE', []);

    await expect(removeConversationForUser('conv-1', 'user-1', { clearHistory: true })).rejects.toMatchObject({ statusCode: 404, message: 'Conversation not found' });
    expect(h.ran).toEqual(['lock: conversation FOR UPDATE']);
  });

  it('a caller who is not a participant answers 403 and writes nothing; a NULL side admits nobody', async () => {
    for (const conversationSides of [{ user1Id: 'user-2', user2Id: 'user-3' }, { user1Id: null, user2Id: null }]) {
      h.ran.length = 0;
      stage({ conversationSides });
      await expect(removeConversationForUser('conv-1', 'user-1', { clearHistory: false })).rejects.toMatchObject({ statusCode: 403 });
      expect(h.ran).not.toContain('upsert: remover read row');
    }
  });

  it('runs again whole after a deadlock (the account deletion\'s cascade can hold a row it needs)', async () => {
    stage();
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useRealTimers();

    await removeConversationForUser('conv-1', 'user-1', { clearHistory: false });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[DM] The removal of conversation conv-1 was aborted by a deadlock'));
    warn.mockRestore();
  });
});

// ─── A reopen ───────────────────────────────────────────────────────────────

describe('reopenConversationForUser', () => {
  it('locks the conversation row first (key share), then clears the opener\'s hidden mark only, keeping the floor', async () => {
    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);

    expect(await reopenConversationForUser('conv-1', 'user-1')).toBe(true);

    expect(h.ran).toEqual(['lock: conversation FOR KEY SHARE', 'update: unhide read rows']);
    expect(tx.conversationRead.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', conversationId: 'conv-1', hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    expect(h.options).toEqual([LOCK_WAIT_TRANSACTION_OPTIONS]);
  });

  it('a conversation a removal deleted while it waited: false, nothing written (the route creates a new one)', async () => {
    h.results.set('lock: conversation FOR KEY SHARE', []);

    expect(await reopenConversationForUser('conv-1', 'user-1')).toBe(false);
    expect(h.ran).toEqual(['lock: conversation FOR KEY SHARE']);
  });
});

// ─── An edit, a reaction, a delete ──────────────────────────────────────────

describe('changeConversationMessage', () => {
  const act = vi.fn(async (_tx: unknown, _view: unknown) => {
    h.ran.push('act: the write');
    return 'done';
  });

  beforeEach(() => act.mockClear());

  it("locks the conversation row FIRST (key share), re-reads the view under it, then runs the write on the transaction's own client", async () => {
    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', sides([{ userId: 'user-1', hiddenAt: null, clearedAt: new Date('2026-11-16T10:00:00Z') }]));

    expect(await changeConversationMessage('conv-1', 'user-1', { refuseReadOnly: true }, act)).toBe('done');

    expect(h.ran).toEqual(['lock: conversation FOR KEY SHARE', 'read: conversation sides', 'act: the write']);
    expect(act).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 'conv-1', floor: new Date('2026-11-16T10:00:00Z') }));
    expect(h.options).toEqual([LOCK_WAIT_TRANSACTION_OPTIONS]);
  });

  it('an edit or a reaction in a conversation found read-only under the lock is refused: 403, nothing written', async () => {
    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', sides([], { user1Id: 'user-1', user2Id: null }));

    await expect(changeConversationMessage('conv-1', 'user-1', { refuseReadOnly: true }, act))
      .rejects.toMatchObject({ statusCode: 403, message: 'This conversation is read-only' });
    expect(act).not.toHaveBeenCalled();
  });

  it("a delete of one's own message goes on in a read-only conversation", async () => {
    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', sides([], { user1Id: null, user2Id: 'user-1' }));

    expect(await changeConversationMessage('conv-1', 'user-1', { refuseReadOnly: false }, act)).toBe('done');
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('a conversation deleted while it waited: 404 Conversation; a caller no longer a participant: 403; nothing written', async () => {
    h.results.set('lock: conversation FOR KEY SHARE', []);
    await expect(changeConversationMessage('conv-1', 'user-1', { refuseReadOnly: false }, act)).rejects.toMatchObject({ statusCode: 404, message: 'Conversation not found' });
    expect(h.ran).toEqual(['lock: conversation FOR KEY SHARE']);

    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', sides([], { user1Id: null, user2Id: 'user-2' }));
    await expect(changeConversationMessage('conv-1', 'user-1', { refuseReadOnly: false }, act)).rejects.toMatchObject({ statusCode: 403, message: 'Not a participant of this conversation' });
    expect(act).not.toHaveBeenCalled();
  });

  it('runs again whole after a deadlock (an account deletion of the caller holds its account row)', async () => {
    h.results.set('lock: conversation FOR KEY SHARE', [{ id: 'conv-1' }]);
    h.results.set('read: conversation sides', sides([]));
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useRealTimers();

    expect(await changeConversationMessage('conv-1', 'user-1', { refuseReadOnly: true }, act)).toBe('done');

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[DM] A change of a message in conversation conv-1 was aborted by a deadlock'));
    warn.mockRestore();
  });
});
