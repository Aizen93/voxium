import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: { findMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    ipRecord: { deleteMany: vi.fn(), count: vi.fn() },
  },
}));

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

import { prisma } from '../../utils/prisma';
import { runRegistrationHygiene, runRegistrationHygieneLocked, getHygieneHistory, UNVERIFIED_ACCOUNT_TTL_DAYS, IP_RETENTION_DAYS } from '../../utils/registrationHygiene';
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
    vi.mocked(prisma.user.deleteMany).mockRejectedValue(new Error('db gone'));

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
