import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Permissions, permissionsToString } from '@voxium/shared';

// The moderator audience: who hears about a server's join requests — never
// the server room.

const prismaMock = vi.hoisted(() => ({
  server: { findUnique: vi.fn() },
  role: { findMany: vi.fn() },
  memberRole: { findMany: vi.fn() },
  serverMember: { findMany: vi.fn() },
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const io = vi.hoisted(() => {
  const emit = vi.fn();
  return { emit, to: vi.fn(() => ({ emit })) };
});
vi.mock('../../websocket/socketServer', () => ({ getIO: () => io }));

import { moderatorAudienceUserIds, emitToModerators } from '../../utils/moderatorAudience';

const KICK = permissionsToString(Permissions.KICK_MEMBERS | Permissions.VIEW_CHANNEL);
const ADMIN = permissionsToString(Permissions.ADMINISTRATOR);
const PLAIN = permissionsToString(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.server.findUnique.mockResolvedValue({ ownerId: 'owner' });
  prismaMock.role.findMany.mockResolvedValue([]);
  prismaMock.memberRole.findMany.mockResolvedValue([]);
  prismaMock.serverMember.findMany.mockResolvedValue([]);
});

describe('moderatorAudienceUserIds', () => {
  it('is the owner alone when no role grants KICK_MEMBERS or ADMINISTRATOR', async () => {
    prismaMock.role.findMany.mockResolvedValue([{ id: 'r-everyone', permissions: PLAIN, isDefault: true }]);
    await expect(moderatorAudienceUserIds('s-1')).resolves.toEqual(['owner']);
    expect(prismaMock.memberRole.findMany).not.toHaveBeenCalled();
    expect(prismaMock.serverMember.findMany).not.toHaveBeenCalled();
  });

  it('adds holders of KICK_MEMBERS roles and of ADMINISTRATOR roles, distinct, owner included once', async () => {
    prismaMock.role.findMany.mockResolvedValue([
      { id: 'r-everyone', permissions: PLAIN, isDefault: true },
      { id: 'r-mod', permissions: KICK, isDefault: false },
      { id: 'r-admin', permissions: ADMIN, isDefault: false },
      { id: 'r-plain', permissions: PLAIN, isDefault: false },
    ]);
    prismaMock.memberRole.findMany.mockResolvedValue([{ userId: 'mod-1' }, { userId: 'owner' }, { userId: 'admin-1' }]);

    const ids = await moderatorAudienceUserIds('s-1');
    expect(ids.sort()).toEqual(['admin-1', 'mod-1', 'owner']);
    expect(prismaMock.memberRole.findMany).toHaveBeenCalledWith({
      where: { serverId: 's-1', roleId: { in: ['r-mod', 'r-admin'] } },
      distinct: ['userId'],
      select: { userId: true },
    });
  });

  it('when @everyone itself moderates, the audience is the member list — still per user, never the server room', async () => {
    prismaMock.role.findMany.mockResolvedValue([{ id: 'r-everyone', permissions: KICK, isDefault: true }]);
    prismaMock.serverMember.findMany.mockResolvedValue([{ userId: 'a' }, { userId: 'owner' }, { userId: 'b' }]);
    const ids = await moderatorAudienceUserIds('s-1');
    expect(ids.sort()).toEqual(['a', 'b', 'owner']);
    expect(prismaMock.memberRole.findMany).not.toHaveBeenCalled();
  });

  it('is empty for an unknown server', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    await expect(moderatorAudienceUserIds('gone')).resolves.toEqual([]);
  });
});

describe('emitToModerators', () => {
  it('emits to user:{id} rooms in batches of 500 and never to server:{id}', async () => {
    prismaMock.role.findMany.mockResolvedValue([{ id: 'r-everyone', permissions: KICK, isDefault: true }]);
    prismaMock.serverMember.findMany.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => ({ userId: `u${i}` })));

    await emitToModerators('s-1', 'server:join_request_resolved', { serverId: 's-1', userId: 'x', outcome: 'cancelled' });

    expect(io.to).toHaveBeenCalledTimes(3);
    const rooms = io.to.mock.calls.flatMap(([r]: any[]) => r as string[]);
    expect(rooms).toHaveLength(1002); // 1001 members + the owner
    expect(rooms.every((r) => r.startsWith('user:'))).toBe(true);
    expect(rooms).not.toContain('server:s-1');
    expect(io.to.mock.calls[0][0]).toHaveLength(500);
    expect(io.to.mock.calls[2][0]).toHaveLength(2);
    expect(io.emit).toHaveBeenCalledTimes(3);
    expect(io.emit).toHaveBeenCalledWith('server:join_request_resolved', { serverId: 's-1', userId: 'x', outcome: 'cancelled' });
  });

  it('logs and swallows a failure — the caller\'s write is already committed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.role.findMany.mockRejectedValue(new Error('db gone'));
    await expect(emitToModerators('s-1', 'server:join_request_resolved', { serverId: 's-1', userId: 'x', outcome: 'joined' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('server:join_request_resolved for server s-1'), 'db gone');
    expect(io.to).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('emits nothing for an unknown server', async () => {
    prismaMock.server.findUnique.mockResolvedValue(null);
    await emitToModerators('gone', 'server:join_request_resolved', { serverId: 'gone', userId: 'x', outcome: 'cancelled' });
    expect(io.to).not.toHaveBeenCalled();
  });
});
