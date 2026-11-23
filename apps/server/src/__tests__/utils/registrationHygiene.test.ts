import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lazyStatement } from '../helpers/lazyStatement';

// The order the deletion's statements RUN in (lazyStatement), across the suite
const ran = vi.hoisted(() => [] as string[]);

vi.mock('../../utils/prisma', () => {
  const prisma: Record<string, unknown> = {
    user: { findMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    ipRecord: { deleteMany: vi.fn(), count: vi.fn() },
  };
  // The deletion's transaction runs on this same mocked client. Its raw
  // statements: the account lock answers every id it is asked for (each
  // still satisfies the guards), the conversation lock finds none.
  prisma.$queryRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM users/.test(sql)) return Promise.resolve((values[0] as string[]).map((id) => ({ id })));
    return Promise.resolve([]);
  });
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});

// The conversation step (its own suites: conversationLifecycle.test.ts, and a
// real database) and what follows its commit (accountDeletion.test.ts)
const settle = vi.hoisted(() => vi.fn());
vi.mock('../../utils/conversationLifecycle', () => ({ settleConversationsOfDeletedAccount: (...a: unknown[]) => settle(...a) }));
// The reports step (reportSettlement.test.ts): here whether it runs, where, for whom
const settleReports = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../../utils/reportSettlement', () => ({ settleReportsOfDeletedAccounts: (...a: unknown[]) => settleReports(...(a as [])) }));
const announce = vi.hoisted(() => vi.fn());
vi.mock('../../utils/accountDeletion', () => ({ announceConversationsOfDeletedAccount: (...a: unknown[]) => announce(...a) }));
const deleteBlobs = vi.hoisted(() => vi.fn());
vi.mock('../../utils/attachmentBlobs', () => ({ deleteAttachmentBlobs: (...a: unknown[]) => deleteBlobs(...a) }));
const flag = vi.hoisted(() => vi.fn((_name?: string) => false));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: (...a: unknown[]) => flag(...(a as [])) }));

const deleteMultipleFromS3 = vi.hoisted(() => vi.fn(async (keys: string[]) => keys.length));
vi.mock('../../utils/s3', () => ({ deleteMultipleFromS3 }));

const { redisSet, redisDel, redisGet, redisLPush, redisLTrim, redisLRange, redisEval } = vi.hoisted(() => ({
  redisSet: vi.fn(),
  redisDel: vi.fn().mockResolvedValue(1),
  redisGet: vi.fn().mockResolvedValue(null),
  redisLPush: vi.fn().mockResolvedValue(1),
  redisLTrim: vi.fn().mockResolvedValue('OK'),
  redisLRange: vi.fn().mockResolvedValue([]),
  redisEval: vi.fn().mockResolvedValue(1),
}));
vi.mock('../../utils/redis', () => ({
  getRedis: () => ({
    set: redisSet, del: redisDel, get: redisGet, eval: redisEval,
    lPush: redisLPush, lTrim: redisLTrim, lRange: redisLRange,
  }),
  NODE_ID: () => 'node-under-test',
}));

const logAuditEvent = vi.hoisted(() => vi.fn());
vi.mock('../../utils/auditLog', () => ({ logAuditEvent }));

vi.mock('../../utils/email', () => ({
  sendAdminAlert: vi.fn().mockResolvedValue(undefined),
  describeEmailError: vi.fn((e: unknown) => String(e)),
}));

// The verify-first sign-up purge has its own suite (signupService.test.ts);
// here it is a spy, so the sweep's handling of it is what is observed.
const purgeExpiredSignupState = vi.hoisted(() => vi.fn());
vi.mock('../../services/signupService', () => ({
  purgeExpiredSignupState: (...a: unknown[]) => purgeExpiredSignupState(...a),
}));

import { prisma } from '../../utils/prisma';
import { runRegistrationHygiene, runRegistrationHygieneLocked, getHygieneHistory, UNVERIFIED_ACCOUNT_TTL_DAYS, IP_RETENTION_DAYS, SWEEP_ACCOUNTS_PER_TRANSACTION, HygieneBatchFailedError } from '../../utils/registrationHygiene';
import { subnetOf } from '../../middleware/rateLimiter';

// The sweep is what makes bot registration harvests worthless: unverified
// rows stop accumulating, and squatted usernames/emails free themselves.
describe('registration hygiene sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', avatarUrl: null }, { id: 'u-2', avatarUrl: null }, { id: 'u-3', avatarUrl: null },
    ] as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.ipRecord.deleteMany).mockResolvedValue({ count: 7 } as never);
    deleteMultipleFromS3.mockImplementation(async (keys: string[]) => keys.length);
  });

  it('deletes only STALE, UNVERIFIED, plain-role, serverless accounts', async () => {
    const before = Date.now();
    const result = await runRegistrationHygiene();
    expect(result).toMatchObject({ deletedUsers: 3, deletedIpRecords: 7, dryRun: false });

    // The guards moved to the SELECT that decides who dies; the delete is then
    // by id, so the S3 keys can be read before the rows go.
    const where = vi.mocked(prisma.user.findMany).mock.calls[0][0]!.where as {
      emailVerified: boolean; createdAt: { lt: Date }; role: string; ownedServers: { none: object };
    };
    // Every guard is load-bearing: emailVerified=false is the target,
    // role='user' protects any anomalous admin, ownedServers:none keeps the
    // sweep clear of Server.owner's onDelete: Restrict.
    expect(where.emailVerified).toBe(false);
    expect(where.role).toBe('user');
    expect(where.ownedServers).toEqual({ none: {} });
    const ageDays = (before - where.createdAt.lt.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThanOrEqual(UNVERIFIED_ACCOUNT_TTL_DAYS - 0.01);
    expect(ageDays).toBeLessThan(UNVERIFIED_ACCOUNT_TTL_DAYS + 0.01);
  });

  it('expires IP records unseen for the GDPR retention window', async () => {
    const before = Date.now();
    await runRegistrationHygiene();

    const where = vi.mocked(prisma.ipRecord.deleteMany).mock.calls[0][0]!.where as { lastSeenAt: { lt: Date } };
    const ageDays = (before - where.lastSeenAt.lt.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThanOrEqual(IP_RETENTION_DAYS - 0.01);
    expect(ageDays).toBeLessThan(IP_RETENTION_DAYS + 0.01);
  });
});

describe('subnetOf — the range key the slow-drip counters group by', () => {
  it('collapses IPv4 to /24 and IPv6 to /48', () => {
    expect(subnetOf('203.0.113.9')).toBe('203.0.113.0/24');
    expect(subnetOf('::ffff:203.0.113.9')).toBe('203.0.113.0/24');
    expect(subnetOf('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
  });

  it('passes through unparseable input rather than grouping strangers together', () => {
    expect(subnetOf('unknown')).toBe('unknown');
  });
});

// ─── The swept accounts' direct conversations (#131) ────────────────────────
// The sweep deletes accounts without deleteUserAccount, so it settles their
// conversations itself, by the rule and the flag an account deletion uses:
// nothing it does rests on the foreign keys from a conversation's sides.

describe('registration hygiene sweep — the swept accounts and their conversations', () => {
  const EMPTY = { kept: [], deleted: [], attachmentKeys: [] };
  // the mocked client's own behaviour, put back after each test here
  const defaultQueryRaw = vi.mocked(prisma.$queryRaw).getMockImplementation()!;
  const defaultTransaction = vi.mocked(prisma.$transaction).getMockImplementation()!;
  afterEach(() => {
    vi.mocked(prisma.$queryRaw).mockImplementation(defaultQueryRaw);
    vi.mocked(prisma.$transaction).mockImplementation(defaultTransaction);
    deleteBlobs.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ran.length = 0;
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', avatarUrl: null }, { id: 'u-2', avatarUrl: null }, { id: 'u-3', avatarUrl: null },
    ] as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.ipRecord.deleteMany).mockResolvedValue({ count: 0 } as never);
    settle.mockImplementation(async () => EMPTY);
    announce.mockImplementation(async () => {});
    flag.mockImplementation(() => false);
  });

  /**
   * The raw statements recorded when they RUN: the account lock answers
   * `locked`, the ownership re-read `owners`, the conversation lock `sides`.
   */
  function stage(locked: string[], sides: Array<{ user1Id: string | null; user2Id: string | null }> = [], owners: string[] = []) {
    vi.mocked(prisma.$queryRaw).mockImplementation(((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (/FROM users/.test(sql)) return lazyStatement(ran, 'lock: the accounts that still qualify', locked.map((id) => ({ id })));
      if (/FROM servers WHERE owner_id/.test(sql)) return lazyStatement(ran, 'read: which of them own a space now', owners.map((ownerId) => ({ ownerId })));
      return lazyStatement(ran, 'lock: their conversations', sides);
    }) as never);
    settle.mockImplementation((_tx: unknown, userId: string) => { ran.push(`conversations of ${userId}`); return Promise.resolve(EMPTY); });
    vi.mocked(prisma.user.deleteMany).mockImplementation(((args: { where: { id: { in: string[] } } }) =>
      lazyStatement(ran, 'delete: the accounts', { count: args.where.id.in.length })) as never);
  }

  it('in one transaction: the accounts that STILL satisfy every guard first, then their conversations in one statement, then the step for each account that is a side of one, then the delete by id', async () => {
    stage(['u-1', 'u-2', 'u-3'], [{ user1Id: 'u-1', user2Id: 'v-9' }, { user1Id: 'v-8', user2Id: 'u-3' }]);

    const result = await runRegistrationHygiene();

    expect(result.deletedUsers).toBe(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
    expect(ran).toEqual([
      'lock: the accounts that still qualify',
      'read: which of them own a space now',
      'lock: their conversations',
      'conversations of u-1',
      'conversations of u-3',
      'delete: the accounts',
    ]);
    // the step runs on the transaction's own client
    expect(settle).toHaveBeenCalledWith(prisma, 'u-1', { keep: false });
  });

  it('the account lock repeats every guard and takes the rows in id order; the conversation lock takes every conversation of them in id order', async () => {
    await runRegistrationHygiene();

    const calls = vi.mocked(prisma.$queryRaw).mock.calls as unknown as Array<[string[], ...unknown[]]>;
    const accounts = calls.find(([strings]) => /FROM users/.test(strings.join('?')))!;
    const text = accounts[0].join('?').replace(/\s+/g, ' ');
    for (const guard of ['u.email_verified = false', 'u.created_at < ?', "u.role = 'user'", 'NOT EXISTS (SELECT 1 FROM servers s WHERE s.owner_id = u.id)']) {
      expect(text).toContain(guard);
    }
    expect(text).toMatch(/ORDER BY u\.id FOR UPDATE OF u$/);
    expect(accounts[1]).toEqual(['u-1', 'u-2', 'u-3']);
    const conversations = calls.find(([strings]) => /FROM conversations/.test(strings.join('?')))!;
    expect(conversations[0].join('?').replace(/\s+/g, ' ')).toMatch(/WHERE user1_id = ANY\(\?::text\[\]\) OR user2_id = ANY\(\?::text\[\]\) ORDER BY id FOR UPDATE$/);
  });

  it('an account verified since the select is not locked, so it is neither settled nor deleted (the delete names the locked ids, the guards repeated)', async () => {
    stage(['u-1', 'u-3'], [{ user1Id: 'u-2', user2Id: 'v-9' }]);

    const result = await runRegistrationHygiene();

    expect(result.deletedUsers).toBe(2);
    expect(settle).not.toHaveBeenCalled();
    const where = vi.mocked(prisma.user.deleteMany).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.id).toEqual({ in: ['u-1', 'u-3'] });
    expect(where).toMatchObject({ emailVerified: false, role: 'user', ownedServers: { none: {} } });
  });

  it('nothing still qualifies: no conversation statement, no delete', async () => {
    stage([]);

    expect((await runRegistrationHygiene()).deletedUsers).toBe(0);
    expect(ran).toEqual(['lock: the accounts that still qualify']);
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it('a locked account that owns a space NOW (an ownership write the lock waited for) is dropped before anything is settled or deleted', async () => {
    // The lock re-checks only the account row's own columns after a wait; the
    // ownership guard reads `servers`, so it is read again in a statement of
    // its own, on a snapshot taken after the lock was granted
    stage(['u-1', 'u-2', 'u-3'], [{ user1Id: 'u-2', user2Id: 'v-9' }, { user1Id: 'u-3', user2Id: 'v-8' }], ['u-2']);

    const result = await runRegistrationHygiene();

    expect(result.deletedUsers).toBe(2);
    expect(ran.slice(0, 3)).toEqual(['lock: the accounts that still qualify', 'read: which of them own a space now', 'lock: their conversations']);
    expect(settle.mock.calls.map((c) => c[1])).toEqual(['u-3']);
    expect((vi.mocked(prisma.user.deleteMany).mock.calls[0][0]!.where as { id: { in: string[] } }).id.in).toEqual(['u-1', 'u-3']);
    const calls = vi.mocked(prisma.$queryRaw).mock.calls as unknown as Array<[string[], ...unknown[]]>;
    const owners = calls.find(([strings]) => /FROM servers WHERE owner_id/.test(strings.join('?')))!;
    expect(owners[0].join('?').replace(/\s+/g, ' ').trim()).toBe('SELECT DISTINCT owner_id AS "ownerId" FROM servers WHERE owner_id = ANY(?::text[])');
    expect(owners[1]).toEqual(['u-1', 'u-2', 'u-3']);
    // the conversation lock names only the accounts left
    const conversations = calls.find(([strings]) => /FROM conversations/.test(strings.join('?')))!;
    expect(conversations.slice(1)).toEqual([['u-1', 'u-3'], ['u-1', 'u-3']]);
  });

  it('every locked account owns a space now: nothing settled, nothing deleted', async () => {
    stage(['u-1'], [{ user1Id: 'u-1', user2Id: 'v-9' }], ['u-1']);

    expect((await runRegistrationHygiene()).deletedUsers).toBe(0);
    expect(ran).toEqual(['lock: the accounts that still qualify', 'read: which of them own a space now']);
    expect(settle).not.toHaveBeenCalled();
  });

  it('a final delete that removes another number of accounts than were settled rolls the batch back whole (no settlement without its delete) and stops the sweep there', async () => {
    stage(['u-1', 'u-2', 'u-3'], [{ user1Id: 'u-1', user2Id: 'v-9' }]);
    vi.mocked(prisma.user.deleteMany).mockImplementation((() => lazyStatement(ran, 'delete: the accounts', { count: 2 })) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runRegistrationHygiene();

      // thrown inside the transaction: it rolls back the settlement too
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.deletedUsers).toBe(0);
      expect(result.failedBatch).toEqual({ name: 'SweepDeleteMismatchError', code: 'SWEEP_DELETE_MISMATCH' });
      expect(announce).not.toHaveBeenCalled();
      expect(deleteBlobs).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('the flag is read ONCE for the sweep and given to every step', async () => {
    flag.mockImplementation((name?: string) => name === 'account_deletion_keeps_conversations');
    stage(['u-1', 'u-2'], [{ user1Id: 'u-1', user2Id: 'v-9' }, { user1Id: 'u-2', user2Id: 'v-8' }]);

    await runRegistrationHygiene();

    expect(flag.mock.calls.filter(([name]) => name === 'account_deletion_keeps_conversations')).toHaveLength(1);
    expect(settle.mock.calls.map((c) => c.slice(1))).toEqual([['u-1', { keep: true }], ['u-2', { keep: true }]]);
  });

  it('after the commit: the files of the conversations deleted, then the notices, with what every step settled', async () => {
    stage(['u-1', 'u-2'], [{ user1Id: 'u-1', user2Id: 'v-9' }, { user1Id: 'u-2', user2Id: 'v-8' }]);
    settle
      .mockImplementationOnce(async () => ({ kept: ['c-1'], deleted: [], attachmentKeys: [] }))
      .mockImplementationOnce(async () => ({ kept: [], deleted: ['c-2'], attachmentKeys: ['attachments/dm-c-2/f1-encrypted.bin'] }));
    let committed = false;
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown) => {
      const result = await fn(prisma);
      committed = true;
      return result;
    }) as never);
    // recorded, not asserted inside the step: a throw there is caught by the sweep
    let committedAtCleanup: boolean | null = null;
    deleteBlobs.mockImplementation(() => { committedAtCleanup = committed; });

    await runRegistrationHygiene();

    expect(committedAtCleanup).toBe(true);
    expect(deleteBlobs).toHaveBeenCalledWith(['attachments/dm-c-2/f1-encrypted.bin'], '[RegHygiene]', 'the conversations of swept accounts');
    expect(announce).toHaveBeenCalledWith({ kept: ['c-1'], deleted: ['c-2'], attachmentKeys: ['attachments/dm-c-2/f1-encrypted.bin'] }, '[RegHygiene]');
    expect(vi.mocked(announce).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(deleteBlobs).mock.invocationCallOrder[0]);
  });

  it('a step that throws after a batch committed is a warning: the batch stays counted, its other step still runs and the next batch is taken', async () => {
    const many = Array.from({ length: SWEEP_ACCOUNTS_PER_TRANSACTION + 1 }, (_, i) => ({ id: `u-${String(i).padStart(5, '0')}`, avatarUrl: null }));
    vi.mocked(prisma.user.findMany).mockResolvedValue(many as never);
    vi.mocked(prisma.user.deleteMany).mockImplementation((async (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length })) as never);
    deleteBlobs.mockImplementationOnce(() => { throw new Error('the store is away'); });
    announce.mockImplementationOnce(async () => { throw new Error('no socket server'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runRegistrationHygiene();

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(result.deletedUsers).toBe(SWEEP_ACCOUNTS_PER_TRANSACTION + 1);
      expect(result.failedBatch).toBeUndefined();
      // the first batch's notices were still asked for after its file cleanup threw
      expect(announce).toHaveBeenCalledTimes(2);
      expect(deleteBlobs).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('[RegHygiene] After a batch of the unverified-account deletion, the attachment file cleanup failed:', 'the store is away');
      expect(warn).toHaveBeenCalledWith('[RegHygiene] After a batch of the unverified-account deletion, the notices of its direct conversations failed:', 'no socket server');
      // neither is reported as a failed batch
      expect(JSON.stringify(error.mock.calls)).not.toContain('A batch of the unverified-account deletion failed');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a conversation of two swept accounts, kept for the first and deleted for the second, ends deleted, never kept', async () => {
    stage(['u-1', 'u-2'], [{ user1Id: 'u-1', user2Id: 'u-2' }]);
    settle
      .mockImplementationOnce(async () => ({ kept: ['c-12'], deleted: [], attachmentKeys: [] }))
      .mockImplementationOnce(async () => ({ kept: [], deleted: ['c-12'], attachmentKeys: [] }));

    await runRegistrationHygiene();

    expect(announce).toHaveBeenCalledWith({ kept: [], deleted: ['c-12'], attachmentKeys: [] }, '[RegHygiene]');
  });

  it(`deletes ${SWEEP_ACCOUNTS_PER_TRANSACTION} accounts per transaction, the counts added up`, async () => {
    const many = Array.from({ length: SWEEP_ACCOUNTS_PER_TRANSACTION + 1 }, (_, i) => ({ id: `u-${String(i).padStart(5, '0')}`, avatarUrl: null }));
    vi.mocked(prisma.user.findMany).mockResolvedValue(many as never);
    vi.mocked(prisma.user.deleteMany).mockImplementation((async (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length })) as never);

    const result = await runRegistrationHygiene();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(result.deletedUsers).toBe(SWEEP_ACCOUNTS_PER_TRANSACTION + 1);
    expect((vi.mocked(prisma.user.deleteMany).mock.calls[1][0]!.where as { id: { in: string[] } }).id.in).toEqual([many[SWEEP_ACCOUNTS_PER_TRANSACTION].id]);
  });

  it('a batch PostgreSQL aborted to break a deadlock runs again whole and is counted once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = vi.mocked(prisma.$transaction).getMockImplementation()!;
    vi.mocked(prisma.$transaction)
      .mockImplementationOnce((async () => { throw Object.assign(new Error('deadlock'), { code: 'P2034' }); }) as never)
      .mockImplementation(real);
    try {
      const result = await runRegistrationHygiene();

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(result.deletedUsers).toBe(3);
      expect(announce).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed batch: nothing of it announced or deleted, the rest of the night\'s work done, the failure answered by name and code only', async () => {
    vi.mocked(prisma.user.deleteMany).mockRejectedValue(Object.assign(new Error('connection to user@db.internal lost'), { code: 'P1017' }) as never);
    vi.mocked(prisma.ipRecord.deleteMany).mockResolvedValue({ count: 4 } as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runRegistrationHygiene();

      expect(result).toMatchObject({ deletedUsers: 0, deletedIpRecords: 4, failedBatch: { name: 'Error', code: 'P1017' } });
      expect(announce).not.toHaveBeenCalled();
      expect(deleteBlobs).not.toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain('db.internal');
    } finally {
      error.mockRestore();
    }
  });

  it('a batch that fails after earlier ones committed: those stay deleted and announced, their avatars go, no further batch is taken', async () => {
    const many = Array.from({ length: SWEEP_ACCOUNTS_PER_TRANSACTION * 2 + 1 }, (_, i) => ({ id: `u-${String(i).padStart(5, '0')}`, avatarUrl: `avatars/a${i}.webp` }));
    vi.mocked(prisma.user.findMany).mockResolvedValue(many as never);
    vi.mocked(prisma.user.deleteMany)
      .mockImplementationOnce((async (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length })) as never)
      .mockRejectedValueOnce(Object.assign(new Error('deadlock... no, a lost connection'), { code: 'P1017' }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runRegistrationHygiene();

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(result.deletedUsers).toBe(SWEEP_ACCOUNTS_PER_TRANSACTION);
      expect(result.failedBatch).toEqual({ name: 'Error', code: 'P1017' });
      expect(announce).toHaveBeenCalledTimes(1);
      // exactly the first batch's avatars
      const handed = deleteMultipleFromS3.mock.calls[0][0] as string[];
      expect(handed).toHaveLength(SWEEP_ACCOUNTS_PER_TRANSACTION);
      expect(handed[0]).toBe('avatars/a0.webp');
      expect(handed).not.toContain(`avatars/a${SWEEP_ACCOUNTS_PER_TRANSACTION}.webp`);
      expect(prisma.ipRecord.deleteMany).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('the locked run records a failed batch (partial count, name and code) in the run record and the audit row, releases its lock, then reports the failure', async () => {
    vi.mocked(prisma.user.deleteMany).mockRejectedValue(Object.assign(new Error('secret detail'), { code: 'P1017' }) as never);
    redisSet.mockResolvedValue('OK');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const refusal = await runRegistrationHygieneLocked({ trigger: 'scheduled' }).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(HygieneBatchFailedError);
      expect((refusal as Error).message).not.toContain('secret detail');
      const record = JSON.parse(redisLPush.mock.calls[0][1] as string);
      expect(record).toMatchObject({ deletedUsers: 0, failedBatch: { name: 'Error', code: 'P1017' } });
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'registration.hygiene_sweep',
        metadata: expect.objectContaining({ deletedUsers: 0, failedBatch: { name: 'Error', code: 'P1017' } }),
      }));
      expect(JSON.stringify(logAuditEvent.mock.calls)).not.toContain('secret detail');
      expect(redisEval).toHaveBeenCalled(); // the lock released
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('a dry run touches no conversation and opens no transaction', async () => {
    await runRegistrationHygiene({ dryRun: true });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(settleReports).not.toHaveBeenCalled();
    expect(flag).not.toHaveBeenCalled();
  });

  // ─── Their moderation reports (#48) ───────────────────────────────────────

  describe('the reports filed by or about the swept accounts', () => {
    const reportsFlag = (on: boolean) => flag.mockImplementation((name?: string) => name === 'account_deletion_keeps_reports' && on);
    beforeEach(() => {
      settleReports.mockImplementation((async () => { ran.push('reports of the batch'); return 0; }) as never);
    });

    it('flag off: no report statement, the batch runs exactly the statements it ran before the step existed', async () => {
      reportsFlag(false);
      stage(['u-1', 'u-2', 'u-3'], [{ user1Id: 'u-1', user2Id: 'v-9' }]);

      await runRegistrationHygiene();

      expect(settleReports).not.toHaveBeenCalled();
      expect(ran).toEqual([
        'lock: the accounts that still qualify',
        'read: which of them own a space now',
        'lock: their conversations',
        'conversations of u-1',
        'delete: the accounts',
      ]);
    });

    it('flag on: ONE call for every account of the batch still eligible, on the transaction\'s client, BETWEEN the conversations\' lock and the conversation steps, so no report row is written twice (a reported account need not have a conversation)', async () => {
      reportsFlag(true);
      // u-2 owns a space now and is dropped; u-3 is a side of no conversation
      stage(['u-1', 'u-2', 'u-3'], [{ user1Id: 'u-1', user2Id: 'v-9' }], ['u-2']);

      const result = await runRegistrationHygiene();

      expect(result.deletedUsers).toBe(2);
      expect(settleReports).toHaveBeenCalledTimes(1);
      expect(settleReports).toHaveBeenCalledWith(prisma, ['u-1', 'u-3']);
      expect(ran).toEqual([
        'lock: the accounts that still qualify',
        'read: which of them own a space now',
        'lock: their conversations',
        'reports of the batch',
        'conversations of u-1',
        'delete: the accounts',
      ]);
    });

    it('the flag is read ONCE for the sweep, before any batch, and the step runs in each batch', async () => {
      reportsFlag(true);
      const ids = Array.from({ length: SWEEP_ACCOUNTS_PER_TRANSACTION + 1 }, (_, i) => ({ id: `u-${i}`, avatarUrl: null }));
      vi.mocked(prisma.user.findMany).mockResolvedValue(ids as never);
      vi.mocked(prisma.$queryRaw).mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (/FROM users/.test(sql)) return Promise.resolve((values[0] as string[]).map((id) => ({ id })));
        return Promise.resolve([]);
      }) as never);
      vi.mocked(prisma.user.deleteMany).mockImplementation(((args: { where: { id: { in: string[] } } }) => Promise.resolve({ count: args.where.id.in.length })) as never);

      await runRegistrationHygiene();

      expect(flag.mock.calls.filter(([name]) => name === 'account_deletion_keeps_reports')).toHaveLength(1);
      expect(settleReports).toHaveBeenCalledTimes(2);
      expect((settleReports.mock.calls[0] as unknown[])[1]).toHaveLength(SWEEP_ACCOUNTS_PER_TRANSACTION);
      expect((settleReports.mock.calls[1] as unknown[])[1]).toEqual([`u-${SWEEP_ACCOUNTS_PER_TRANSACTION}`]);
    });

    it('a final delete that disagrees rolls the batch back whole, the reports step with it (it ran inside the transaction)', async () => {
      reportsFlag(true);
      stage(['u-1', 'u-2'], []);
      vi.mocked(prisma.user.deleteMany).mockImplementation((() => lazyStatement(ran, 'delete: the accounts', { count: 1 })) as never);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await runRegistrationHygiene();

        expect(ran).toContain('reports of the batch');
        expect(ran.indexOf('reports of the batch')).toBeLessThan(ran.indexOf('delete: the accounts'));
        expect(result.deletedUsers).toBe(0);
        expect(result.failedBatch).toEqual({ name: 'SweepDeleteMismatchError', code: 'SWEEP_DELETE_MISMATCH' });
      } finally {
        error.mockRestore();
      }
    });

    it('nothing still qualifies: no report step either', async () => {
      reportsFlag(true);
      stage([]);

      await runRegistrationHygiene();

      expect(settleReports).not.toHaveBeenCalled();
    });
  });
});

// ─── Hourly spike alert ──────────────────────────────────────────────────────

import { checkRegistrationSpike, REGISTRATION_SPIKE_PER_HOUR } from '../../utils/registrationHygiene';
import { sendAdminAlert } from '../../utils/email';
import { getRedis } from '../../utils/redis';

describe('registration spike alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLEANUP_REPORT_EMAIL = 'ops@voxium.test';
    vi.mocked(getRedis().set).mockResolvedValue('OK' as never);
  });

  it('mails the operator when signups/hour cross the threshold', async () => {
    vi.mocked(prisma.user.count).mockResolvedValueOnce(REGISTRATION_SPIKE_PER_HOUR + 5 as never);
    await checkRegistrationSpike();
    expect(sendAdminAlert).toHaveBeenCalledWith('ops@voxium.test', expect.stringContaining('spike'), expect.any(Array));
  });

  it('stays quiet below the threshold', async () => {
    vi.mocked(prisma.user.count).mockResolvedValueOnce(2 as never);
    await checkRegistrationSpike();
    expect(sendAdminAlert).not.toHaveBeenCalled();
  });

  it('dedupes across the alert window and across nodes (SET NX)', async () => {
    vi.mocked(prisma.user.count).mockResolvedValueOnce(999 as never);
    vi.mocked(getRedis().set).mockResolvedValueOnce(null as never); // another node already claimed
    await checkRegistrationSpike();
    expect(sendAdminAlert).not.toHaveBeenCalled();
  });

  it('does nothing when no alert address is configured', async () => {
    delete process.env.CLEANUP_REPORT_EMAIL;
    await checkRegistrationSpike();
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});

// ─── Avatars go with the rows (F15) ─────────────────────────────────────────

describe('registration hygiene sweep — S3 cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.ipRecord.deleteMany).mockResolvedValue({ count: 0 } as never);
    deleteMultipleFromS3.mockImplementation(async (keys: string[]) => keys.length);
  });

  it('deletes the swept accounts\' avatars, after their rows are gone', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', avatarUrl: 'avatars/u1.png' },
      { id: 'u-2', avatarUrl: null },
      { id: 'u-3', avatarUrl: 'avatars/u3.png' },
    ] as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 3 } as never);

    await runRegistrationHygiene();

    // The guards are REPEATED on the delete: a user who verifies between the
    // select and the delete must survive, and only Postgres can decide that.
    const where = vi.mocked(prisma.user.deleteMany).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.id).toEqual({ in: ['u-1', 'u-2', 'u-3'] });
    expect(where.emailVerified).toBe(false);
    expect(where.role).toBe('user');
    expect(where.ownedServers).toEqual({ none: {} });
    expect(deleteMultipleFromS3).toHaveBeenCalledWith(['avatars/u1.png', 'avatars/u3.png']);
    // AFTER the rows, not before: a failed delete must not strand a live
    // account without its avatar. The title said so; nothing checked it.
    const rowsGone = vi.mocked(prisma.user.deleteMany).mock.invocationCallOrder[0];
    const blobsGone = vi.mocked(deleteMultipleFromS3).mock.invocationCallOrder[0];
    expect(rowsGone).toBeLessThan(blobsGone);
  });

  it('reports the avatars S3 ACCEPTED, not the ones it was handed', async () => {
    // DeleteObjects answers 200 with a populated Errors[] when the credentials
    // lack s3:DeleteObject, which is why deleteMultipleFromS3 returns a count.
    // Reporting the candidate count instead puts a clean number in the durable
    // audit row and the operator panel while nothing actually moved.
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', avatarUrl: 'avatars/u1.png' },
      { id: 'u-2', avatarUrl: 'avatars/u2.png' },
    ] as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 2 } as never);
    deleteMultipleFromS3.mockResolvedValue(0); // S3 refused both
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runRegistrationHygiene();

    expect(result.deletedAvatars).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('S3 refused 2 avatar deletion'));
    error.mockRestore();
  });

  it('reports the full count in a dry run, where nothing is handed to S3 at all', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u-1', avatarUrl: 'avatars/u1.png' }] as never);

    const result = await runRegistrationHygiene({ dryRun: true });

    expect(result.deletedAvatars).toBe(1);
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
  });

  it('does NOT delete blobs when the row delete removed nothing', async () => {
    // A failed or raced delete must never strand a live account without its avatar
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u-1', avatarUrl: 'avatars/u1.png' }] as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 0 } as never);

    await runRegistrationHygiene();

    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
  });

  it('still reports success when S3 cleanup fails — the orphan sweep reclaims them', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u-1', avatarUrl: 'avatars/u1.png' }] as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 1 } as never);
    deleteMultipleFromS3.mockRejectedValue(new Error('s3 down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runRegistrationHygiene()).resolves.toMatchObject({ deletedUsers: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips both queries when nothing is stale', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

    const result = await runRegistrationHygiene();

    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    expect(result.deletedUsers).toBe(0);
  });
});

// ─── Cluster lock, run record, dry run ──────────────────────────────────────

describe('registration hygiene sweep — locking and observability', () => {
  function stale(n: number, avatar: string | null = null) {
    return Array.from({ length: n }, (_, i) => ({ id: `u-${i}`, avatarUrl: avatar }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.user.findMany).mockResolvedValue(stale(3) as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.ipRecord.deleteMany).mockResolvedValue({ count: 7 } as never);
    vi.mocked(prisma.ipRecord.count).mockResolvedValue(7 as never);
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);
    deleteMultipleFromS3.mockImplementation(async (keys: string[]) => keys.length);
  });

  it('claims a cluster lock and releases it afterwards', async () => {
    // Both nodes fire at 04:30. Without the lock the loser's deleteMany matches
    // zero rows, its count disagrees with its own select, and it logs a
    // misleading "spared by the delete guards" warning every single night.
    const run = await runRegistrationHygieneLocked({ trigger: 'scheduled' });

    // The token is unique per ACQUISITION, not per process: the admin's manual
    // trigger runs in the same node as the scheduler, and with NODE_ID alone
    // the scheduled run's release matched — and freed — the manual run's lock
    // after a TTL overrun.
    expect(redisSet).toHaveBeenCalledWith('lock:reghygiene', expect.stringMatching(/^node-under-test:[0-9a-f-]{36}$/), { NX: true, EX: 900 });
    expect(redisDel).not.toHaveBeenCalled();
    // Compare-and-delete, never a blind DEL: a large backlog can outrun the
    // 15-minute TTL, and by then the lock in Redis belongs to the next runner.
    const token = redisSet.mock.calls.find((c) => c[0] === 'lock:reghygiene')![1];
    expect(redisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      { keys: ['lock:reghygiene'], arguments: [token] },
    );
    expect(run).toMatchObject({ deletedUsers: 3, trigger: 'scheduled', actorId: null });
  });

  it('uses a different token for every acquisition, so a same-node re-acquire is another runner\'s lock', async () => {
    await runRegistrationHygieneLocked({ trigger: 'scheduled' });
    await runRegistrationHygieneLocked({ trigger: 'manual', actorId: 'admin-1' });

    const tokens = redisSet.mock.calls.filter((c) => c[0] === 'lock:reghygiene').map((c) => c[1]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    // And the release compares against the OWN token each time
    const released = redisEval.mock.calls.map((c) => c[1].arguments[0]);
    expect(released).toEqual(tokens);
  });

  it('does NOTHING when a peer already holds the lock', async () => {
    redisSet.mockResolvedValue(null);

    const run = await runRegistrationHygieneLocked({ trigger: 'scheduled' });

    expect(run).toEqual({ skipped: 'locked' });
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the lock cannot be reached', async () => {
    // Skipping a night costs nothing — the accounts are still there tomorrow.
    redisSet.mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const run = await runRegistrationHygieneLocked({ trigger: 'scheduled' });

    expect(run).toEqual({ skipped: 'locked' });
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('releases the lock even when the sweep throws', async () => {
    vi.mocked(prisma.user.findMany).mockRejectedValue(new Error('db gone'));

    await expect(runRegistrationHygieneLocked({ trigger: 'scheduled' })).rejects.toThrow('db gone');
    expect(redisDel).not.toHaveBeenCalled();
    // Compare-and-delete, never a blind DEL: a large backlog can outrun the
    // 15-minute TTL, and by then the lock in Redis belongs to the next runner.
    expect(redisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      { keys: ['lock:reghygiene'], arguments: [expect.stringMatching(/^node-under-test:/)] },
    );
  });

  it('records the run so an operator can see when it last happened', async () => {
    await runRegistrationHygieneLocked({ trigger: 'manual', actorId: 'admin-1' });

    const [key, json] = redisSet.mock.calls.find((c) => c[0] === 'hygiene:last-run')!;
    expect(key).toBe('hygiene:last-run');
    expect(JSON.parse(json as string)).toMatchObject({
      deletedUsers: 3, deletedIpRecords: 7, trigger: 'manual', actorId: 'admin-1',
    });
    // and a capped history
    expect(redisLPush).toHaveBeenCalledWith('hygiene:history', expect.any(String));
    expect(redisLTrim).toHaveBeenCalledWith('hygiene:history', 0, 19);
  });

  it('writes a durable audit row, with a null actor for the scheduled run', async () => {
    await runRegistrationHygieneLocked({ trigger: 'scheduled' });

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorId: null,
      action: 'registration.hygiene_sweep',
      metadata: expect.objectContaining({ trigger: 'scheduled', deletedUsers: 3 }),
    }));
  });

  it('still completes when the run record cannot be written', async () => {
    redisSet.mockImplementation(async (key: string) => {
      if (key === 'hygiene:last-run') throw new Error('redis down');
      return 'OK';
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runRegistrationHygieneLocked({ trigger: 'scheduled' }))
      .resolves.toMatchObject({ deletedUsers: 3 });
    warn.mockRestore();
  });

  it('a DRY RUN deletes nothing, takes no lock, and records nothing', async () => {
    const run = await runRegistrationHygieneLocked({ trigger: 'manual', actorId: 'admin-1', dryRun: true });

    expect(run).toMatchObject({ deletedUsers: 3, deletedIpRecords: 7, dryRun: true });
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    expect(prisma.ipRecord.deleteMany).not.toHaveBeenCalled();
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('a dry run reports the avatars it WOULD delete without touching S3', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue(stale(2, 'avatars/x.webp') as never);

    const run = await runRegistrationHygieneLocked({ trigger: 'manual', dryRun: true });

    expect(run).toMatchObject({ deletedUsers: 2, deletedAvatars: 2, dryRun: true });
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
  });

  it('reads back the last run and history', async () => {
    const record = { at: '2026-08-21T04:30:00.000Z', deletedUsers: 5, trigger: 'scheduled' };
    redisGet.mockResolvedValue(JSON.stringify(record));
    redisLRange.mockResolvedValue([JSON.stringify(record), 'corrupt-not-json']);

    const { lastRun, history } = await getHygieneHistory();

    expect(lastRun).toMatchObject({ deletedUsers: 5 });
    // a corrupt entry is dropped, not thrown
    expect(history).toHaveLength(1);
  });

  it('answers "never run" rather than throwing when Redis is unavailable', async () => {
    redisGet.mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(getHygieneHistory()).resolves.toEqual({ lastRun: null, history: [] });
    warn.mockRestore();
  });
});

// ─── Verify-first sign-up state ─────────────────────────────────────────────

describe('registration hygiene sweep — expired sign-up state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    purgeExpiredSignupState.mockReset();
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u-1', avatarUrl: null }] as never);
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.ipRecord.deleteMany).mockResolvedValue({ count: 7 } as never);
    vi.mocked(prisma.ipRecord.count).mockResolvedValue(7 as never);
  });

  it('purges expired pending registrations and spent ledger rows on a real run, and says so', async () => {
    purgeExpiredSignupState.mockResolvedValueOnce({ pending: 2, ledger: 1 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runRegistrationHygiene();

    expect(purgeExpiredSignupState).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[RegHygiene] Purged 2 expired pending registration(s) and 1 sign-up mail ledger row(s)');
    // The sweep's own result does not carry the purge
    expect(result).toEqual({ deletedUsers: 1, deletedIpRecords: 7, deletedAvatars: 0, dryRun: false });
    log.mockRestore();
  });

  it('logs nothing when there was nothing to purge', async () => {
    purgeExpiredSignupState.mockResolvedValueOnce({ pending: 0, ledger: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runRegistrationHygiene();

    expect(purgeExpiredSignupState).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('[RegHygiene] Purged'));
    log.mockRestore();
  });

  it('a dry run purges nothing', async () => {
    const result = await runRegistrationHygiene({ dryRun: true });

    expect(purgeExpiredSignupState).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true });
  });

  it('a failed purge is logged and does not change the result of the sweep', async () => {
    purgeExpiredSignupState.mockRejectedValueOnce(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runRegistrationHygiene();

    expect(error).toHaveBeenCalledWith('[RegHygiene] Sign-up state purge failed:', 'db gone');
    expect(result).toEqual({ deletedUsers: 1, deletedIpRecords: 7, deletedAvatars: 0, dryRun: false });
    error.mockRestore();
  });

  it('runs BEFORE the account and IP steps: a failing step of the sweep cannot skip it', async () => {
    purgeExpiredSignupState.mockResolvedValueOnce({ pending: 3, ledger: 0 });
    vi.mocked(prisma.user.findMany).mockRejectedValueOnce(new Error('users table locked'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // The sweep's own failure still surfaces to its caller
    await expect(runRegistrationHygiene()).rejects.toThrow('users table locked');

    expect(purgeExpiredSignupState).toHaveBeenCalledTimes(1);
    expect(purgeExpiredSignupState.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(prisma.user.findMany).mock.invocationCallOrder[0]);
    expect(log).toHaveBeenCalledWith('[RegHygiene] Purged 3 expired pending registration(s) and 0 sign-up mail ledger row(s)');
    log.mockRestore();
  });

  it('runs even when the IP record step fails', async () => {
    purgeExpiredSignupState.mockResolvedValueOnce({ pending: 0, ledger: 0 });
    vi.mocked(prisma.ipRecord.deleteMany).mockRejectedValueOnce(new Error('db gone'));

    await expect(runRegistrationHygiene()).rejects.toThrow('db gone');
    expect(purgeExpiredSignupState).toHaveBeenCalledTimes(1);
  });

  it('a failed purge does not fail the locked run either', async () => {
    redisSet.mockResolvedValue('OK');
    purgeExpiredSignupState.mockRejectedValueOnce(new Error('db gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const run = await runRegistrationHygieneLocked({ trigger: 'scheduled' });

    expect(run).toMatchObject({ deletedUsers: 1, deletedIpRecords: 7, dryRun: false, trigger: 'scheduled' });
    error.mockRestore();
  });
});
