import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The connection handler and `channel:join` read visibility, then join
 * `channel:` rooms, outside the per-space resync queue. A revocation whose
 * resync pass ran between the read and the join found nothing to remove, and
 * the join then applied the stale read (issue #71 review). Each now takes a
 * request mark BEFORE its read and hands it to resyncAfterJoins AFTER its
 * joins; utils/channelVisibilityRooms.test.ts proves what that call does.
 */

const m = vi.hoisted(() => {
  const ioInstance = {
    use: vi.fn(),
    on: vi.fn(),
    adapter: vi.fn(),
    sockets: { sockets: new Map() },
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    in: vi.fn().mockReturnValue({ fetchSockets: vi.fn().mockResolvedValue([]) }),
  };
  return {
    ioInstance,
    mark: vi.fn(),
    resyncAfterJoins: vi.fn(),
    hasChannelPermission: vi.fn(),
    filterVisibleChannelsMulti: vi.fn(),
    prisma: {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      serverMember: { findMany: vi.fn() },
      channel: { findMany: vi.fn(), findUnique: vi.fn() },
      conversation: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
      ipRecord: { upsert: vi.fn().mockResolvedValue({}) },
      ipBan: { findUnique: vi.fn().mockResolvedValue(null) },
      supportTicket: { findUnique: vi.fn().mockResolvedValue(null) },
      announcement: { findMany: vi.fn().mockResolvedValue([]) },
      conversationRead: { createMany: vi.fn() },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock('socket.io', () => ({
  Server: vi.fn().mockImplementation(function () { return m.ioInstance; }),
}));
vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: vi.fn().mockReturnValue('mock-adapter') }));
vi.mock('../../utils/redis', () => ({
  setUserOnline: vi.fn().mockResolvedValue(undefined),
  setUserOffline: vi.fn().mockResolvedValue(null),
  isUserOnline: vi.fn().mockResolvedValue(false),
  getRedisPubSub: vi.fn().mockReturnValue({ pub: {}, sub: {} }),
  getRedis: vi.fn().mockReturnValue({ ping: vi.fn() }),
  getOnlineUsers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../utils/prisma', () => ({ prisma: m.prisma }));
vi.mock('../../middleware/rateLimiter', async (importOriginal) => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
  normalizeIp: (await importOriginal<typeof import('../../middleware/rateLimiter')>()).normalizeIp,
}));
vi.mock('../../websocket/voiceHandler', () => ({
  handleVoiceEvents: vi.fn(),
  replayVoiceState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../websocket/dmVoiceHandler', () => ({ handleDMVoiceEvents: vi.fn() }));
vi.mock('../../websocket/annotationHandler', () => ({ handleAnnotationEvents: vi.fn() }));
vi.mock('../../utils/permissionCalculator', () => ({
  hasChannelPermission: m.hasChannelPermission,
  filterVisibleChannelsMulti: m.filterVisibleChannelsMulti,
}));
vi.mock('../../utils/channelVisibilityRooms', () => ({
  visibilityRequestMark: m.mark,
  resyncAfterJoins: m.resyncAfterJoins,
}));
vi.mock('jsonwebtoken', () => ({
  default: { verify: vi.fn().mockReturnValue({ userId: 'user-1', username: 'alice', tokenVersion: 0 }) },
}));

import http from 'http';
import { initSocketServer } from '../../websocket/socketServer';

function createMockSocket() {
  const rooms = new Set<string>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const socket = {
    id: 'socket-1',
    data: { userId: 'user-1', username: 'alice', tokenVersion: 0 },
    disconnected: false,
    disconnect: vi.fn(),
    handshake: { auth: { token: 'valid-token' }, address: '127.0.0.1', headers: {} },
    join: vi.fn((room: string) => rooms.add(room)),
    leave: vi.fn((room: string) => rooms.delete(room)),
    emit: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); }),
    rooms,
  };
  return { socket, handlers };
}

function connectionHandler(): (socket: unknown) => Promise<void> {
  const call = m.ioInstance.on.mock.calls.find(([event]) => event === 'connection');
  if (!call) throw new Error('No connection handler registered');
  return call[1] as (socket: unknown) => Promise<void>;
}

const MARK = 41;
let httpServer: http.Server;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret';
  m.mark.mockReturnValue(MARK);
  m.prisma.user.findUnique.mockResolvedValue({
    bannedAt: null, tokenVersion: 0, role: 'user',
    emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
  });
  m.prisma.serverMember.findMany.mockResolvedValue([{ serverId: 's-1' }, { serverId: 's-2' }]);
  m.prisma.channel.findMany.mockResolvedValue([
    { id: 'ch-a', serverId: 's-1', type: 'text', secure: false },
    { id: 'ch-b', serverId: 's-2', type: 'text', secure: false },
  ]);
  m.filterVisibleChannelsMulti.mockImplementation(async (_uid: string, channels: unknown[]) => channels);
  httpServer = http.createServer();
  initSocketServer(httpServer);
});
afterEach(() => {
  httpServer.close();
});

const order = (fn: { mock: { invocationCallOrder: number[] } }, i = 0) => fn.mock.invocationCallOrder[i];

describe('the connection handler re-checks its channel rooms when a resync raced its visibility read', () => {
  it('takes the mark before reading memberships and visibility, and hands it over after the channel joins', async () => {
    const { socket } = createMockSocket();

    await connectionHandler()(socket);

    expect(socket.join).toHaveBeenCalledWith('channel:ch-a');
    expect(socket.join).toHaveBeenCalledWith('channel:ch-b');
    expect(m.mark).toHaveBeenCalledTimes(1);
    expect(order(m.mark)).toBeLessThan(order(m.prisma.serverMember.findMany));
    expect(order(m.mark)).toBeLessThan(order(m.filterVisibleChannelsMulti));
    expect(m.resyncAfterJoins).toHaveBeenCalledTimes(1);
    expect(m.resyncAfterJoins).toHaveBeenCalledWith(MARK, 'user-1', ['s-1', 's-2']);
    const lastChannelJoin = Math.max(...socket.join.mock.calls
      .map((c, i) => [c[0], socket.join.mock.invocationCallOrder[i]] as const)
      .filter(([room]) => room.startsWith('channel:'))
      .map(([, at]) => at));
    expect(order(m.resyncAfterJoins)).toBeGreaterThan(lastChannelJoin);
  });

  it('a socket that disconnected during the read joins nothing and re-checks nothing', async () => {
    const { socket } = createMockSocket();
    m.filterVisibleChannelsMulti.mockImplementation(async (_uid: string, channels: unknown[]) => {
      socket.disconnected = true;
      return channels;
    });

    await connectionHandler()(socket);

    expect(socket.join).not.toHaveBeenCalledWith('channel:ch-a');
    expect(m.resyncAfterJoins).not.toHaveBeenCalled();
  });
});

describe('channel:join re-checks the room when a resync raced its permission read', () => {
  async function joinHandler() {
    const { socket, handlers } = createMockSocket();
    await connectionHandler()(socket);
    vi.clearAllMocks();
    m.mark.mockReturnValue(MARK + 1);
    return { socket, join: handlers.get('channel:join')! };
  }

  it('takes the mark before the permission read, and hands it over with the channel after the join', async () => {
    const { socket, join } = await joinHandler();
    m.prisma.channel.findUnique.mockResolvedValue({ serverId: 's-1', server: { members: [{ userId: 'user-1' }] } });
    m.hasChannelPermission.mockResolvedValue(true);

    await join('ch-new');

    expect(socket.join).toHaveBeenCalledWith('channel:ch-new');
    expect(order(m.mark)).toBeLessThan(order(m.hasChannelPermission));
    expect(m.resyncAfterJoins).toHaveBeenCalledWith(MARK + 1, 'user-1', ['s-1'], 'ch-new');
    expect(order(m.resyncAfterJoins)).toBeGreaterThan(order(socket.join));
  });

  it('a refused join re-checks nothing (there is no room to correct)', async () => {
    const { socket, join } = await joinHandler();
    m.prisma.channel.findUnique.mockResolvedValue({ serverId: 's-1', server: { members: [{ userId: 'user-1' }] } });
    m.hasChannelPermission.mockResolvedValue(false);

    await join('ch-hidden');

    expect(socket.join).not.toHaveBeenCalled();
    expect(m.resyncAfterJoins).not.toHaveBeenCalled();
  });
});
