import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: { findMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    ipRecord: { deleteMany: vi.fn() },
  },
}));

const deleteMultipleFromS3 = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../utils/s3', () => ({ deleteMultipleFromS3 }));

const redisSet = vi.hoisted(() => vi.fn());
vi.mock('../../utils/redis', () => ({
  getRedis: () => ({ set: redisSet }),
}));

vi.mock('../../utils/email', () => ({
  sendAdminAlert: vi.fn().mockResolvedValue(undefined),
  describeEmailError: vi.fn((e: unknown) => String(e)),
}));

import { prisma } from '../../utils/prisma';
import { runRegistrationHygiene, UNVERIFIED_ACCOUNT_TTL_DAYS, IP_RETENTION_DAYS } from '../../utils/registrationHygiene';
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
    deleteMultipleFromS3.mockResolvedValue(undefined);
  });

  it('deletes only STALE, UNVERIFIED, plain-role, serverless accounts', async () => {
    const before = Date.now();
    const result = await runRegistrationHygiene();
    expect(result).toEqual({ deletedUsers: 3, deletedIpRecords: 7 });

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
    deleteMultipleFromS3.mockResolvedValue(undefined);
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
