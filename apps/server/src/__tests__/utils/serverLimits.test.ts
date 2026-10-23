import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/prisma', () => ({
  prisma: {
    globalConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    serverLimits: {
      findUnique: vi.fn(),
    },
  },
}));

import { LIMITS } from '@voxium/shared';
import { prisma } from '../../utils/prisma';
import { getEffectiveLimits, getGlobalLimits } from '../../utils/serverLimits';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('serverLimits — getEffectiveLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns hardcoded defaults when no DB records exist', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce(null);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 20,
      maxVoiceUsersPerChannel: 12,
      maxCategoriesPerServer: 12,
      maxMembersPerServer: 0,
      maxWebhooksPerServer: 10,
    });
    // toEqual ignores undefined properties: pin the webhook default explicitly
    expect(limits.maxWebhooksPerServer).toBe(LIMITS.MAX_WEBHOOKS_PER_SERVER);
  });

  it('returns GlobalConfig values when they exist (no server override)', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
      maxWebhooksPerServer: 15,
    } as any);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce(null);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
      maxWebhooksPerServer: 15,
    });
  });

  it('server limits override global config completely', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
      maxWebhooksPerServer: 15,
    } as any);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce({
      serverId: 'server-1',
      maxChannelsPerServer: 100,
      maxVoiceUsersPerChannel: 50,
      maxCategoriesPerServer: 30,
      maxMembersPerServer: 1000,
      maxWebhooksPerServer: 40,
    } as any);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 100,
      maxVoiceUsersPerChannel: 50,
      maxCategoriesPerServer: 30,
      maxMembersPerServer: 1000,
      maxWebhooksPerServer: 40,
    });
  });

  it('null server limit fields fall through to global config', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
      maxWebhooksPerServer: 15,
    } as any);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce({
      serverId: 'server-1',
      maxChannelsPerServer: null, // falls through
      maxVoiceUsersPerChannel: 99,
      maxCategoriesPerServer: null, // falls through
      maxMembersPerServer: null, // falls through
      maxWebhooksPerServer: null, // falls through
    } as any);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 50, // from global
      maxVoiceUsersPerChannel: 99, // from server override
      maxCategoriesPerServer: 20, // from global
      maxMembersPerServer: 500, // from global
      maxWebhooksPerServer: 15, // from global
    });
  });

  it('null server limit fields fall through to hardcoded defaults when no global config', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce({
      serverId: 'server-1',
      maxChannelsPerServer: null,
      maxVoiceUsersPerChannel: 99,
      maxCategoriesPerServer: null,
      maxMembersPerServer: null,
      maxWebhooksPerServer: null,
    } as any);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 20, // hardcoded default
      maxVoiceUsersPerChannel: 99, // server override
      maxCategoriesPerServer: 12, // hardcoded default
      maxMembersPerServer: 0, // hardcoded default (unlimited)
      maxWebhooksPerServer: 10, // hardcoded default (LIMITS.MAX_WEBHOOKS_PER_SERVER)
    });
  });

  it('a server override of the webhook cap alone leaves every other limit on the global values', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
      maxWebhooksPerServer: 10,
    } as any);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce({
      serverId: 'server-1',
      maxChannelsPerServer: null,
      maxVoiceUsersPerChannel: null,
      maxCategoriesPerServer: null,
      maxMembersPerServer: null,
      maxWebhooksPerServer: 0,
    } as any);

    const limits = await getEffectiveLimits('server-1');

    // 0 is a real override (no webhooks at all) — `??` must not fall through on it
    expect(limits.maxWebhooksPerServer).toBe(0);
    expect(limits).toEqual({
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
      maxWebhooksPerServer: 0,
    });
  });
});

describe('serverLimits — getGlobalLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts and returns global config', async () => {
    vi.mocked(prisma.globalConfig.upsert).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 20,
      maxVoiceUsersPerChannel: 12,
      maxCategoriesPerServer: 12,
      maxMembersPerServer: 0,
      maxWebhooksPerServer: 10,
    } as any);

    const limits = await getGlobalLimits();

    expect(prisma.globalConfig.upsert).toHaveBeenCalledWith({
      where: { id: 'global' },
      create: { id: 'global' },
      update: {},
    });
    expect(limits.maxChannelsPerServer).toBe(20);
    expect(limits.maxWebhooksPerServer).toBe(10);
  });
});
