import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma', () => ({
  prisma: {
    user: { deleteMany: vi.fn(), count: vi.fn() },
    ipRecord: { deleteMany: vi.fn() },
  },
}));

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
    vi.mocked(prisma.user.deleteMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.ipRecord.deleteMany).mockResolvedValue({ count: 7 } as never);
  });

  it('deletes only STALE, UNVERIFIED, plain-role, serverless accounts', async () => {
    const before = Date.now();
    const result = await runRegistrationHygiene();
    expect(result).toEqual({ deletedUsers: 3, deletedIpRecords: 7 });

    const where = vi.mocked(prisma.user.deleteMany).mock.calls[0][0]!.where as {
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
