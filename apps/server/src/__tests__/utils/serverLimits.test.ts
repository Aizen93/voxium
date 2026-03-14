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
    });
  });

  it('returns GlobalConfig values when they exist (no server override)', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
    } as any);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce(null);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
    });
  });

  it('server limits override global config completely', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
    } as any);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce({
      serverId: 'server-1',
      maxChannelsPerServer: 100,
      maxVoiceUsersPerChannel: 50,
      maxCategoriesPerServer: 30,
      maxMembersPerServer: 1000,
    } as any);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 100,
      maxVoiceUsersPerChannel: 50,
      maxCategoriesPerServer: 30,
      maxMembersPerServer: 1000,
    });
  });

  it('null server limit fields fall through to global config', async () => {
    vi.mocked(prisma.globalConfig.findUnique).mockResolvedValueOnce({
      id: 'global',
      maxChannelsPerServer: 50,
      maxVoiceUsersPerChannel: 25,
      maxCategoriesPerServer: 20,
      maxMembersPerServer: 500,
    } as any);
    vi.mocked(prisma.serverLimits.findUnique).mockResolvedValueOnce({
      serverId: 'server-1',
      maxChannelsPerServer: null, // falls through
      maxVoiceUsersPerChannel: 99,
      maxCategoriesPerServer: null, // falls through
      maxMembersPerServer: null, // falls through
    } as any);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 50, // from global
      maxVoiceUsersPerChannel: 99, // from server override
      maxCategoriesPerServer: 20, // from global
      maxMembersPerServer: 500, // from global
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
    } as any);

    const limits = await getEffectiveLimits('server-1');

    expect(limits).toEqual({
      maxChannelsPerServer: 20, // hardcoded default
      maxVoiceUsersPerChannel: 99, // server override
      maxCategoriesPerServer: 12, // hardcoded default
      maxMembersPerServer: 0, // hardcoded default (unlimited)
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
    } as any);

    const limits = await getGlobalLimits();

    expect(prisma.globalConfig.upsert).toHaveBeenCalledWith({
      where: { id: 'global' },
      create: { id: 'global' },
      update: {},
    });
    expect(limits.maxChannelsPerServer).toBe(20);
  });
});
