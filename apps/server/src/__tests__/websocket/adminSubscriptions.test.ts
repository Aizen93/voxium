import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.hoisted(() => vi.fn());
vi.mock('../../utils/prisma', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));
const socketRateLimit = vi.hoisted(() => vi.fn((..._a: unknown[]) => true));
vi.mock('../../middleware/rateLimiter', () => ({ socketRateLimit: (...a: unknown[]) => socketRateLimit(...a) }));

import { registerAdminSubscriptionHandlers, isPlatformStaff } from '../../websocket/adminSubscriptions';

type Handler = () => unknown;

function makeSocket(userId: unknown = 'u-1') {
  const handlers = new Map<string, Handler>();
  const rooms = new Set<string>();
  const socket = {
    data: { userId, role: 'admin' } as Record<string, unknown>,
    on: vi.fn((ev: string, fn: Handler) => { handlers.set(ev, fn); }),
    join: vi.fn((room: string) => { rooms.add(room); }),
    leave: vi.fn((room: string) => { rooms.delete(room); }),
  };
  registerAdminSubscriptionHandlers(socket as never);
  const fire = async (ev: string) => { await handlers.get(ev)!(); };
  return { socket, handlers, rooms, fire };
}

const staff = (role: string) => ({ role, bannedAt: null });

beforeEach(() => {
  vi.clearAllMocks();
  socketRateLimit.mockReturnValue(true);
});

const ROOMS = [
  ['admin:subscribe_metrics', 'admin:unsubscribe_metrics', 'admin:metrics'],
  ['admin:subscribe_reports', 'admin:unsubscribe_reports', 'admin:reports'],
  ['admin:subscribe_support', 'admin:unsubscribe_support', 'admin:support'],
] as const;

describe('registerAdminSubscriptionHandlers', () => {
  it('registers all six handlers synchronously', () => {
    const { handlers } = makeSocket();
    expect([...handlers.keys()].sort()).toEqual(ROOMS.flatMap(([s, u]) => [s, u]).sort());
  });

  describe.each(ROOMS)('%s', (subscribe, unsubscribe, room) => {
    it.each(['admin', 'superadmin'])('joins %s accounts, reading the role from the database', async (role) => {
      findUnique.mockResolvedValue(staff(role));
      const { rooms, fire } = makeSocket('u-1');

      await fire(subscribe);

      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'u-1' }, select: { role: true, bannedAt: true } });
      expect(rooms.has(room)).toBe(true);
    });

    it('refuses an account whose role is now "user", whatever the handshake copied into socket.data', async () => {
      findUnique.mockResolvedValue(staff('user'));
      const { socket, rooms, fire } = makeSocket('u-1');
      expect(socket.data.role).toBe('admin');

      await fire(subscribe);

      expect(socket.join).not.toHaveBeenCalled();
      expect(rooms.size).toBe(0);
    });

    it('refuses a deleted account', async () => {
      findUnique.mockResolvedValue(null);
      const { socket, fire } = makeSocket('u-1');

      await fire(subscribe);

      expect(socket.join).not.toHaveBeenCalled();
    });

    it('refuses a banned admin', async () => {
      findUnique.mockResolvedValue({ role: 'admin', bannedAt: new Date() });
      const { socket, fire } = makeSocket('u-1');

      await fire(subscribe);

      expect(socket.join).not.toHaveBeenCalled();
    });

    it('leaves again when the role changed while the first read was in flight', async () => {
      findUnique.mockResolvedValueOnce(staff('admin')).mockResolvedValueOnce(staff('user'));
      const { socket, rooms, fire } = makeSocket('u-1');

      await fire(subscribe);

      expect(socket.join).toHaveBeenCalledWith(room);
      expect(socket.leave).toHaveBeenCalledWith(room);
      expect(rooms.has(room)).toBe(false);
    });

    it('does not read the database when rate-limited', async () => {
      socketRateLimit.mockReturnValue(false);
      const { socket, fire } = makeSocket('u-1');

      await fire(subscribe);

      expect(socketRateLimit).toHaveBeenCalledWith(socket, subscribe, 10);
      expect(findUnique).not.toHaveBeenCalled();
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('logs and refuses when the role lookup fails', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      findUnique.mockRejectedValue(new Error('db down'));
      const { socket, rooms, fire } = makeSocket('u-1');

      await expect(fire(subscribe)).resolves.toBeUndefined();

      expect(rooms.has(room)).toBe(false);
      expect(socket.join).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith(expect.stringContaining(subscribe), 'db down');
      err.mockRestore();
    });

    it('leaves the room when the confirming read fails after the join', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      findUnique.mockResolvedValueOnce(staff('admin')).mockRejectedValueOnce(new Error('db down'));
      const { rooms, fire } = makeSocket('u-1');

      await fire(subscribe);

      expect(rooms.has(room)).toBe(false);
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });

    it('unsubscribes without a database read', async () => {
      findUnique.mockResolvedValue(staff('admin'));
      const { socket, rooms, fire } = makeSocket('u-1');
      await fire(subscribe);
      findUnique.mockClear();

      await fire(unsubscribe);

      expect(socketRateLimit).toHaveBeenCalledWith(socket, 'admin:unsubscribe', 30);
      expect(findUnique).not.toHaveBeenCalled();
      expect(rooms.has(room)).toBe(false);
    });

    it('ignores a rate-limited unsubscribe', async () => {
      const { socket, fire } = makeSocket('u-1');
      socketRateLimit.mockReturnValue(false);

      await fire(unsubscribe);

      expect(socket.leave).not.toHaveBeenCalled();
    });
  });
});

describe('isPlatformStaff', () => {
  it('is false without a usable user id, with no database read', async () => {
    await expect(isPlatformStaff(undefined)).resolves.toBe(false);
    await expect(isPlatformStaff('')).resolves.toBe(false);
    await expect(isPlatformStaff(42)).resolves.toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('is true for admin and superadmin, false for user', async () => {
    findUnique.mockResolvedValueOnce(staff('admin'));
    await expect(isPlatformStaff('u')).resolves.toBe(true);
    findUnique.mockResolvedValueOnce(staff('superadmin'));
    await expect(isPlatformStaff('u')).resolves.toBe(true);
    findUnique.mockResolvedValueOnce(staff('user'));
    await expect(isPlatformStaff('u')).resolves.toBe(false);
  });
});
