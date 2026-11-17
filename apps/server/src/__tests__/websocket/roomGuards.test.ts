import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Permissions, DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@voxium/shared';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockIOInstance, mockPrisma, mockSocketRateLimit } = vi.hoisted(() => ({
  mockIOInstance: {
    use: vi.fn(),
    on: vi.fn(),
    adapter: vi.fn(),
    to: vi.fn(),
    in: vi.fn().mockReturnValue({ fetchSockets: vi.fn().mockResolvedValue([]) }),
  },
  mockSocketRateLimit: vi.fn(),
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    serverMember: { findMany: vi.fn(), findUnique: vi.fn() },
    channel: { findMany: vi.fn(), findUnique: vi.fn() },
    conversation: { findMany: vi.fn(), findUnique: vi.fn() },
    ipRecord: { upsert: vi.fn().mockResolvedValue({}) },
    ipBan: { findUnique: vi.fn().mockResolvedValue(null) },
    supportTicket: { findUnique: vi.fn().mockResolvedValue(null) },
    announcement: { findMany: vi.fn().mockResolvedValue([]) },
    conversationRead: { createMany: vi.fn() },
    server: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    role: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    memberRole: { findMany: vi.fn().mockResolvedValue([]) },
    channelPermissionOverride: { findMany: vi.fn().mockResolvedValue([]) },
    channelMember: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('socket.io', () => ({
  Server: vi.fn().mockImplementation(function () { return mockIOInstance; }),
}));
vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: vi.fn().mockReturnValue('adapter') }));
vi.mock('../../utils/redis', () => ({
  setUserOnline: vi.fn().mockResolvedValue(undefined),
  setUserOffline: vi.fn().mockResolvedValue(null),
  isUserOnline: vi.fn().mockResolvedValue(false),
  getRedisPubSub: vi.fn().mockReturnValue({ pub: {}, sub: {} }),
  getRedis: vi.fn().mockReturnValue({ ping: vi.fn() }),
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../utils/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../../middleware/rateLimiter', async (importOriginal) => ({
  socketRateLimit: mockSocketRateLimit,
  normalizeIp: (await importOriginal<typeof import('../../middleware/rateLimiter')>()).normalizeIp,
}));
vi.mock('../../websocket/voiceHandler', () => ({
  handleVoiceEvents: vi.fn(),
  replayVoiceState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../websocket/dmVoiceHandler', () => ({ handleDMVoiceEvents: vi.fn() }));
vi.mock('../../websocket/annotationHandler', () => ({ handleAnnotationEvents: vi.fn() }));

import { initSocketServer } from '../../websocket/socketServer';
import http from 'http';

// ─── A small fake database behind the mocked Prisma ─────────────────────────

interface FakeChannel {
  serverId: string;
  secure?: boolean;
  type?: 'text' | 'voice';
}

const state = {
  channels: new Map<string, FakeChannel>(),
  ownerOf: new Map<string, string>(),
  members: new Set<string>(), // `${userId}|${serverId}`
  secureMembers: new Set<string>(), // `${userId}|${channelId}`
  everyonePermissions: DEFAULT_EVERYONE_PERMISSIONS as bigint,
  conversations: new Map<string, { user1Id: string; user2Id: string }>(),
};

function resetState() {
  state.channels.clear();
  state.ownerOf.clear();
  state.members.clear();
  state.secureMembers.clear();
  state.everyonePermissions = DEFAULT_EVERYONE_PERMISSIONS;
  state.conversations.clear();
}

function installFakeDatabase() {
  mockPrisma.channel.findUnique.mockImplementation(async (args: {
    where: { id: string };
    select?: { server?: { select?: { members?: { where?: { userId?: string } } } } };
  }) => {
    const ch = state.channels.get(args.where.id);
    if (!ch) return null;
    // The handler asks for the caller's own membership row only (where: { userId })
    const asked = args.select?.server?.select?.members?.where?.userId;
    return {
      serverId: ch.serverId,
      secure: ch.secure ?? false,
      type: ch.type ?? 'text',
      server: {
        ownerId: state.ownerOf.get(ch.serverId) ?? 'someone-else',
        members: [...state.members]
          .filter((m) => m.endsWith(`|${ch.serverId}`) && (asked === undefined || m.startsWith(`${asked}|`)))
          .map((m) => ({ userId: m.split('|')[0] })),
      },
    };
  });
  mockPrisma.serverMember.findUnique.mockImplementation(async (args: { where: { userId_serverId: { userId: string; serverId: string } } }) => {
    const { userId, serverId } = args.where.userId_serverId;
    return state.members.has(`${userId}|${serverId}`) ? { userId } : null;
  });
  mockPrisma.channelMember.findUnique.mockImplementation(async (args: { where: { channelId_userId: { channelId: string; userId: string } } }) => {
    const { channelId, userId } = args.where.channelId_userId;
    return state.secureMembers.has(`${userId}|${channelId}`) ? { isCreator: false } : null;
  });
  mockPrisma.role.findFirst.mockImplementation(async () => ({
    id: 'everyone',
    permissions: permissionsToString(state.everyonePermissions),
  }));
  mockPrisma.conversation.findUnique.mockImplementation(async (args: { where: { id: string } }) => state.conversations.get(args.where.id) ?? null);
}

// ─── Mock socket that keeps a LIST of handlers per event ────────────────────

function createMockSocket(userId = 'user-1') {
  const rooms = new Set<string>();
  const handlers = new Map<string, Function[]>();
  const emitFn = vi.fn();
  const toEmit = vi.fn();
  const toFn = vi.fn((room: string) => ({ emit: (...a: unknown[]) => toEmit(room, ...a) }));

  const socket: any = {
    id: `socket-${userId}`,
    data: { userId, username: 'alice', tokenVersion: 0 },
    disconnected: false,
    disconnect: vi.fn(() => { socket.disconnected = true; }),
    handshake: { auth: { token: 't' }, address: '127.0.0.1', headers: {} },
    join: vi.fn((room: string) => { rooms.add(room); }),
    leave: vi.fn((room: string) => { rooms.delete(room); }),
    emit: emitFn,
    to: toFn,
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    rooms,
  };
  return { socket, handlers, toEmit };
}

async function fire(handlers: Map<string, Function[]>, event: string, ...args: unknown[]) {
  const list = handlers.get(event);
  if (!list || list.length === 0) throw new Error(`no handler for ${event}`);
  await Promise.all(list.map((h) => h(...args)));
}

function getConnectionHandler(): Function {
  for (const [event, handler] of vi.mocked(mockIOInstance.on).mock.calls) {
    if (event === 'connection') return handler as Function;
  }
  throw new Error('No connection handler registered');
}

/** Connect a socket through the real connection handler and wait for its setup. */
async function connect(userId = 'user-1') {
  const made = createMockSocket(userId);
  await getConnectionHandler()(made.socket);
  // The setup joined user:/server: rooms; the tests below look at what they add
  return made;
}

const MALFORMED: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['a number', 42],
  ['an object', { id: 'c1' }],
  ['an array', ['c1']],
  ['an empty string', ''],
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('socketServer room handlers', () => {
  let httpServer: http.Server;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const savedSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    resetState();
    installFakeDatabase();
    mockSocketRateLimit.mockReturnValue(true);
    mockPrisma.user.findUnique.mockResolvedValue({ bannedAt: null, tokenVersion: 0 });
    mockPrisma.serverMember.findMany.mockResolvedValue([]);
    mockPrisma.channel.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    httpServer = http.createServer();
    initSocketServer(httpServer);
  });

  afterEach(() => {
    httpServer.close();
    vi.restoreAllMocks();
    if (savedSecret !== undefined) process.env.JWT_SECRET = savedSecret;
    else delete process.env.JWT_SECRET;
  });

  // Rule: every room event has exactly one handler, so one event can never act twice.
  describe('registration', () => {
    it('registers exactly one handler for each room event', async () => {
      const { handlers } = await connect();
      for (const ev of ['channel:join', 'channel:leave', 'typing:start', 'typing:stop', 'dm:join', 'dm:typing:start', 'dm:typing:stop']) {
        expect(handlers.get(ev), ev).toHaveLength(1);
      }
    });
  });

  // Rule: channel:join puts a socket in channel:{id} only for a member who may view that channel.
  describe('channel:join', () => {
    beforeEach(() => {
      state.channels.set('c1', { serverId: 's1' });
      state.members.add('user-1|s1');
    });

    it('joins channel:{id} for a space member who may view the channel', async () => {
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'c1');
      expect(socket.rooms.has('channel:c1')).toBe(true);
    });

    it('does not join a member who lacks VIEW_CHANNEL', async () => {
      state.everyonePermissions = DEFAULT_EVERYONE_PERMISSIONS & ~Permissions.VIEW_CHANNEL;
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'c1');
      expect(socket.rooms.has('channel:c1')).toBe(false);
    });

    it('does not join someone who is not a member of the space', async () => {
      state.members.clear();
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'c1');
      expect(socket.rooms.has('channel:c1')).toBe(false);
    });

    it('does not join a channel that does not exist', async () => {
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'nope');
      expect(socket.rooms.has('channel:nope')).toBe(false);
    });

    it('does not join a space member who is not in the secure channel', async () => {
      state.channels.set('sec', { serverId: 's1', secure: true });
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'sec');
      expect(socket.rooms.has('channel:sec')).toBe(false);
    });

    it('does not join the space owner who is not in the secure channel', async () => {
      state.channels.set('sec', { serverId: 's1', secure: true });
      state.ownerOf.set('s1', 'user-1');
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'sec');
      expect(socket.rooms.has('channel:sec')).toBe(false);
    });

    it('joins a member of the secure channel', async () => {
      state.channels.set('sec', { serverId: 's1', secure: true });
      state.secureMembers.add('user-1|sec');
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'sec');
      expect(socket.rooms.has('channel:sec')).toBe(true);
    });

    it('does not join a secure-channel member whose space membership is gone', async () => {
      state.channels.set('sec', { serverId: 's1', secure: true });
      state.secureMembers.add('user-1|sec');
      state.members.clear();
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:join', 'sec');
      expect(socket.rooms.has('channel:sec')).toBe(false);
    });

    it('answers a secure channel the caller is not in exactly like a missing one (nothing joined, nothing emitted, no error)', async () => {
      state.channels.set('sec', { serverId: 's1', secure: true });
      const { socket, handlers, toEmit } = await connect();
      const emitsBefore = socket.emit.mock.calls.length;
      const ret1 = await handlers.get('channel:join')![0]('sec');
      const ret2 = await handlers.get('channel:join')![0]('missing');
      expect(ret1).toBe(ret2);
      expect(socket.emit.mock.calls.length).toBe(emitsBefore);
      expect(toEmit).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it.each(MALFORMED)('ignores a malformed payload (%s) without touching the database', async (_label, payload) => {
      const { socket, handlers } = await connect();
      mockPrisma.channel.findUnique.mockClear();
      const roomsBefore = new Set(socket.rooms);
      await fire(handlers, 'channel:join', payload);
      expect(mockPrisma.channel.findUnique).not.toHaveBeenCalled();
      expect(socket.rooms).toEqual(roomsBefore);
    });

    it('does not join for a very long id string (no such channel)', async () => {
      const { socket, handlers } = await connect();
      const long = 'a'.repeat(100_000);
      await fire(handlers, 'channel:join', long);
      expect(socket.rooms.has(`channel:${long}`)).toBe(false);
    });

    it('joins nothing and reads nothing when the rate limiter refuses', async () => {
      const { socket, handlers } = await connect();
      mockPrisma.channel.findUnique.mockClear();
      mockSocketRateLimit.mockReturnValue(false);
      await fire(handlers, 'channel:join', 'c1');
      expect(mockSocketRateLimit).toHaveBeenCalledWith(socket, 'channel:join', 60);
      expect(mockPrisma.channel.findUnique).not.toHaveBeenCalled();
      expect(socket.rooms.has('channel:c1')).toBe(false);
    });

    it('joins nothing and logs when the database lookup fails', async () => {
      const { socket, handlers } = await connect();
      mockPrisma.channel.findUnique.mockRejectedValue(new Error('db down'));
      await fire(handlers, 'channel:join', 'c1');
      expect(socket.rooms.has('channel:c1')).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('joins nothing when the permission read fails after the membership read', async () => {
      const { socket, handlers } = await connect();
      mockPrisma.role.findFirst.mockRejectedValue(new Error('db down'));
      await fire(handlers, 'channel:join', 'c1');
      expect(socket.rooms.has('channel:c1')).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // Rule: channel:leave only drops a room the socket is actually in, and ignores bad input.
  describe('channel:leave', () => {
    it('leaves a channel room the socket is in', async () => {
      const { socket, handlers } = await connect();
      socket.rooms.add('channel:c1');
      await fire(handlers, 'channel:leave', 'c1');
      expect(socket.leave).toHaveBeenCalledWith('channel:c1');
      expect(socket.rooms.has('channel:c1')).toBe(false);
    });

    it('does nothing for a room the socket is not in', async () => {
      const { socket, handlers } = await connect();
      await fire(handlers, 'channel:leave', 'c1');
      expect(socket.leave).not.toHaveBeenCalled();
    });

    it.each(MALFORMED)('ignores a malformed payload (%s)', async (_label, payload) => {
      const { socket, handlers } = await connect();
      socket.rooms.add('channel:c1');
      await fire(handlers, 'channel:leave', payload);
      expect(socket.leave).not.toHaveBeenCalled();
      expect(socket.rooms.has('channel:c1')).toBe(true);
    });

    it('does nothing when the rate limiter refuses', async () => {
      const { socket, handlers } = await connect();
      socket.rooms.add('channel:c1');
      mockSocketRateLimit.mockReturnValue(false);
      await fire(handlers, 'channel:leave', 'c1');
      expect(socket.leave).not.toHaveBeenCalled();
    });
  });

  // Rule: typing indicators leave only from a socket inside channel:{id} that may send there, and go to that room alone.
  describe('typing:start / typing:stop', () => {
    beforeEach(() => {
      state.channels.set('c1', { serverId: 's1' });
      state.members.add('user-1|s1');
    });

    it('typing:start from a socket in the room with SEND_MESSAGES goes to channel:{id} only', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      await fire(handlers, 'typing:start', 'c1');
      expect(toEmit).toHaveBeenCalledTimes(1);
      expect(toEmit).toHaveBeenCalledWith('channel:c1', 'typing:start', { channelId: 'c1', userId: 'user-1', username: 'alice' });
      expect(socket.to.mock.calls.every(([r]: [string]) => !r.startsWith('server:'))).toBe(true);
    });

    it('typing:start from a socket that is not in the room emits nothing and reads nothing', async () => {
      const { handlers, toEmit } = await connect();
      mockPrisma.channel.findUnique.mockClear();
      await fire(handlers, 'typing:start', 'c1');
      expect(toEmit).not.toHaveBeenCalled();
      expect(mockPrisma.channel.findUnique).not.toHaveBeenCalled();
    });

    it('typing:start from a socket in the room without SEND_MESSAGES emits nothing', async () => {
      state.everyonePermissions = DEFAULT_EVERYONE_PERMISSIONS & ~Permissions.SEND_MESSAGES;
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      await fire(handlers, 'typing:start', 'c1');
      expect(toEmit).not.toHaveBeenCalled();
    });

    it('typing:start for a channel that no longer exists emits nothing', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:gone');
      await fire(handlers, 'typing:start', 'gone');
      expect(toEmit).not.toHaveBeenCalled();
    });

    it('typing:start emits nothing and warns when the permission read fails', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      mockPrisma.channel.findUnique.mockRejectedValue(new Error('db down'));
      await fire(handlers, 'typing:start', 'c1');
      expect(toEmit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it.each(MALFORMED)('typing:start ignores a malformed payload (%s)', async (_label, payload) => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      await fire(handlers, 'typing:start', payload);
      expect(toEmit).not.toHaveBeenCalled();
    });

    it('typing:start emits nothing when the rate limiter refuses', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      mockSocketRateLimit.mockReturnValue(false);
      await fire(handlers, 'typing:start', 'c1');
      expect(mockSocketRateLimit).toHaveBeenCalledWith(socket, 'typing', 30);
      expect(toEmit).not.toHaveBeenCalled();
    });

    it('typing:stop from a socket in the room goes to channel:{id} only', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      await fire(handlers, 'typing:stop', 'c1');
      expect(toEmit).toHaveBeenCalledTimes(1);
      expect(toEmit).toHaveBeenCalledWith('channel:c1', 'typing:stop', { channelId: 'c1', userId: 'user-1' });
    });

    it('typing:stop from a socket that is not in the room emits nothing', async () => {
      const { handlers, toEmit } = await connect();
      await fire(handlers, 'typing:stop', 'c1');
      expect(toEmit).not.toHaveBeenCalled();
    });

    it.each(MALFORMED)('typing:stop ignores a malformed payload (%s)', async (_label, payload) => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      await fire(handlers, 'typing:stop', payload);
      expect(toEmit).not.toHaveBeenCalled();
    });

    it('typing:stop emits nothing when the rate limiter refuses', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('channel:c1');
      mockSocketRateLimit.mockReturnValue(false);
      await fire(handlers, 'typing:stop', 'c1');
      expect(toEmit).not.toHaveBeenCalled();
    });
  });

  // Rule: dm:join puts a socket in dm:{id} only for one of the two participants.
  describe('dm:join', () => {
    beforeEach(() => {
      state.conversations.set('conv-1', { user1Id: 'user-1', user2Id: 'user-2' });
      state.conversations.set('conv-2', { user1Id: 'user-2', user2Id: 'user-3' });
    });

    it('joins dm:{id} for the first participant', async () => {
      const { socket, handlers } = await connect('user-1');
      await fire(handlers, 'dm:join', 'conv-1');
      expect(socket.rooms.has('dm:conv-1')).toBe(true);
    });

    it('joins dm:{id} for the second participant', async () => {
      const { socket, handlers } = await connect('user-2');
      await fire(handlers, 'dm:join', 'conv-1');
      expect(socket.rooms.has('dm:conv-1')).toBe(true);
    });

    it('does not join a user who is not a participant', async () => {
      const { socket, handlers } = await connect('user-1');
      await fire(handlers, 'dm:join', 'conv-2');
      expect(socket.rooms.has('dm:conv-2')).toBe(false);
    });

    it('does not join an unknown conversation', async () => {
      const { socket, handlers } = await connect('user-1');
      await fire(handlers, 'dm:join', 'nope');
      expect(socket.rooms.has('dm:nope')).toBe(false);
    });

    it('does not join a conversation whose side is null (a deleted account) for a stranger', async () => {
      state.conversations.set('conv-3', { user1Id: null as unknown as string, user2Id: 'user-2' });
      const { socket, handlers } = await connect('user-1');
      await fire(handlers, 'dm:join', 'conv-3');
      expect(socket.rooms.has('dm:conv-3')).toBe(false);
    });

    it.each(MALFORMED)('ignores a malformed payload (%s) without touching the database', async (_label, payload) => {
      const { socket, handlers } = await connect('user-1');
      mockPrisma.conversation.findUnique.mockClear();
      const before = new Set(socket.rooms);
      await fire(handlers, 'dm:join', payload);
      expect(mockPrisma.conversation.findUnique).not.toHaveBeenCalled();
      expect(socket.rooms).toEqual(before);
    });

    it('joins nothing and logs when the database lookup fails', async () => {
      const { socket, handlers } = await connect('user-1');
      mockPrisma.conversation.findUnique.mockRejectedValue(new Error('db down'));
      await fire(handlers, 'dm:join', 'conv-1');
      expect(socket.rooms.has('dm:conv-1')).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('joins nothing and reads nothing when the rate limiter refuses', async () => {
      const { socket, handlers } = await connect('user-1');
      mockPrisma.conversation.findUnique.mockClear();
      mockSocketRateLimit.mockReturnValue(false);
      await fire(handlers, 'dm:join', 'conv-1');
      expect(mockSocketRateLimit).toHaveBeenCalledWith(socket, 'dm:join', 60);
      expect(mockPrisma.conversation.findUnique).not.toHaveBeenCalled();
      expect(socket.rooms.has('dm:conv-1')).toBe(false);
    });
  });

  // Rule: DM typing indicators leave only from a socket inside dm:{id}, and go to that room alone.
  describe('dm:typing:start / dm:typing:stop', () => {
    it('dm:typing:start from a socket in the room goes to dm:{id}', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('dm:conv-1');
      await fire(handlers, 'dm:typing:start', 'conv-1');
      expect(toEmit).toHaveBeenCalledTimes(1);
      expect(toEmit).toHaveBeenCalledWith('dm:conv-1', 'dm:typing:start', { conversationId: 'conv-1', userId: 'user-1', username: 'alice' });
    });

    it('dm:typing:start from a socket not in the room emits nothing', async () => {
      const { handlers, toEmit } = await connect();
      await fire(handlers, 'dm:typing:start', 'conv-1');
      expect(toEmit).not.toHaveBeenCalled();
    });

    it('dm:typing:stop from a socket in the room goes to dm:{id}', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('dm:conv-1');
      await fire(handlers, 'dm:typing:stop', 'conv-1');
      expect(toEmit).toHaveBeenCalledWith('dm:conv-1', 'dm:typing:stop', { conversationId: 'conv-1', userId: 'user-1' });
    });

    it('dm:typing:stop from a socket not in the room emits nothing', async () => {
      const { handlers, toEmit } = await connect();
      await fire(handlers, 'dm:typing:stop', 'conv-1');
      expect(toEmit).not.toHaveBeenCalled();
    });

    it.each(MALFORMED)('both ignore a malformed payload (%s)', async (_label, payload) => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('dm:conv-1');
      await fire(handlers, 'dm:typing:start', payload);
      await fire(handlers, 'dm:typing:stop', payload);
      expect(toEmit).not.toHaveBeenCalled();
    });

    it('both emit nothing when the rate limiter refuses', async () => {
      const { socket, handlers, toEmit } = await connect();
      socket.rooms.add('dm:conv-1');
      mockSocketRateLimit.mockReturnValue(false);
      await fire(handlers, 'dm:typing:start', 'conv-1');
      await fire(handlers, 'dm:typing:stop', 'conv-1');
      expect(mockSocketRateLimit).toHaveBeenCalledWith(socket, 'dm:typing', 30);
      expect(toEmit).not.toHaveBeenCalled();
    });
  });
});
