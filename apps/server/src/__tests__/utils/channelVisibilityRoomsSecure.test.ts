import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@voxium/shared';

/**
 * The visibility resync with the REAL permission calculator: a secure channel
 * is decided by its membership alone, BEFORE the owner and ADMINISTRATOR fast
 * paths, on the local pass and on the fail-closed fallback. The other suite
 * mocks the calculator, so it can only prove that `secure` is selected.
 */

const m = vi.hoisted(() => ({
  clusterIn: vi.fn(),
  clusterExcept: vi.fn(),
  clusterLeave: vi.fn(),
  localIn: vi.fn(),
  localFetch: vi.fn(),
  publish: vi.fn(),
  prisma: {
    channel: { findMany: vi.fn() },
    server: { findUnique: vi.fn() },
    role: { findFirst: vi.fn() },
    memberRole: { findMany: vi.fn() },
    channelPermissionOverride: { findMany: vi.fn() },
    serverMember: { findMany: vi.fn() },
    channelMember: { findMany: vi.fn() },
  },
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: () => ({ in: m.clusterIn, local: { in: m.localIn, to: vi.fn() } }),
}));
vi.mock('../../websocket/voiceHandler', () => ({
  getVoiceStateForServers: vi.fn().mockResolvedValue([]),
  replayVoiceState: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: m.prisma }));
vi.mock('../../utils/redis', () => ({
  getRedisPubSub: () => ({ pub: { publish: m.publish } }),
  getRedisConfigSub: () => ({ subscribe: vi.fn() }),
  liveNodeCounts: vi.fn().mockResolvedValue({ total: 1, peers: 0 }),
  NODE_ID: () => 'node-a',
}));

import { syncChannelVisibilityRooms, RESYNC_RETRY_DELAYS_MS } from '../../utils/channelVisibilityRooms';

const CHANNELS = [{ id: 'ch-pub', secure: false }, { id: 'ch-sec', secure: true }];

function socketOf(userId: string) {
  return {
    data: { userId },
    rooms: new Set([`user:${userId}`, 'channel:ch-pub', 'channel:ch-sec']),
    join: vi.fn(),
    leave: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.clusterIn.mockReturnValue({ except: m.clusterExcept });
  m.clusterExcept.mockReturnValue({ socketsLeave: m.clusterLeave });
  m.localIn.mockReturnValue({ fetchSockets: m.localFetch });
  m.publish.mockResolvedValue(1);
  m.prisma.channel.findMany.mockResolvedValue(CHANNELS);
  m.prisma.server.findUnique.mockResolvedValue({ ownerId: 'owner' });
  m.prisma.role.findFirst.mockResolvedValue({ id: 'everyone', permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS) });
  // `admin` holds a role with every permission
  m.prisma.memberRole.findMany.mockResolvedValue([{ userId: 'admin', roleId: 'r-admin', role: { permissions: permissionsToString(ALL_PERMISSIONS) } }]);
  m.prisma.channelPermissionOverride.findMany.mockResolvedValue([]);
  m.prisma.serverMember.findMany.mockResolvedValue([{ userId: 'owner' }, { userId: 'admin' }, { userId: 'invited' }]);
  // Only `invited` is a member of the secure channel
  m.prisma.channelMember.findMany.mockResolvedValue([{ channelId: 'ch-sec', userId: 'invited' }]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('syncChannelVisibilityRooms — secure channels with the real calculator', () => {
  it('the local pass takes the owner and an ADMINISTRATOR out of a secure channel they were not invited to, and keeps the invited member in', async () => {
    const owner = socketOf('owner');
    const admin = socketOf('admin');
    const invited = socketOf('invited');
    m.localFetch.mockResolvedValueOnce([owner, admin, invited]);

    await syncChannelVisibilityRooms('server-1');

    for (const s of [owner, admin]) {
      expect(s.join).toHaveBeenCalledWith('channel:ch-pub');
      expect(s.leave).toHaveBeenCalledWith('channel:ch-sec');
      expect(s.join).not.toHaveBeenCalledWith('channel:ch-sec');
    }
    expect(invited.join).toHaveBeenCalledWith('channel:ch-sec');
    expect(invited.leave).not.toHaveBeenCalled();
  });

  it('the fail-closed fallback removes the owner and the ADMINISTRATOR from the secure channel on every node, and nobody from the plaintext one', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.localFetch.mockResolvedValue([]);
    m.publish.mockRejectedValue(new Error('redis away'));

    const done = syncChannelVisibilityRooms('server-1');
    await vi.advanceTimersByTimeAsync(RESYNC_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await done;

    expect(m.clusterIn).toHaveBeenCalledTimes(1);
    expect(m.clusterIn).toHaveBeenCalledWith(['user:owner', 'user:admin']);
    expect(m.clusterExcept).toHaveBeenCalledWith('voice:ch-sec');
    expect(m.clusterLeave).toHaveBeenCalledWith('channel:ch-sec');
  });
});
