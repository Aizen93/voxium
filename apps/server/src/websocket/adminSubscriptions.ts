import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@voxium/shared';
import { prisma } from '../utils/prisma';
import { socketRateLimit } from '../middleware/rateLimiter';

type AdminSocket = Pick<Socket<ClientToServerEvents, ServerToClientEvents>, 'on' | 'join' | 'leave' | 'data'>;

/** The staff subscriptions: client event → the room it joins. */
const SUBSCRIPTIONS = [
  { subscribe: 'admin:subscribe_metrics', unsubscribe: 'admin:unsubscribe_metrics', room: 'admin:metrics' },
  { subscribe: 'admin:subscribe_reports', unsubscribe: 'admin:unsubscribe_reports', room: 'admin:reports' },
  { subscribe: 'admin:subscribe_support', unsubscribe: 'admin:unsubscribe_support', room: 'admin:support' },
] as const;

/**
 * Whether `userId` is platform staff NOW. Read from the database on every
 * subscription, never from `socket.data.role`: that copy is taken once, at
 * the handshake, and a role change since then would not reach it. The events
 * are rare and rate-limited, so the read is cheap. A failed read refuses.
 */
export async function isPlatformStaff(userId: unknown): Promise<boolean> {
  if (typeof userId !== 'string' || !userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, bannedAt: true } });
  return !!user && !user.bannedAt && (user.role === 'admin' || user.role === 'superadmin');
}

/**
 * The admin dashboard's room subscriptions. Registered synchronously by the
 * connection handler (the DB read happens inside each callback).
 *
 * The role is read again AFTER the join: a demotion that commits while the
 * first read is in flight must not leave the socket in the room it was
 * joining (the demotion also ends the account's sockets, routes/admin.ts).
 * The second read sees the new role and leaves.
 */
export function registerAdminSubscriptionHandlers(socket: AdminSocket): void {
  for (const { subscribe, unsubscribe, room } of SUBSCRIPTIONS) {
    socket.on(subscribe, async () => {
      if (!socketRateLimit(socket, subscribe, 10)) return;
      const userId: unknown = socket.data.userId;
      try {
        if (!(await isPlatformStaff(userId))) return;
        socket.join(room);
        if (!(await isPlatformStaff(userId))) socket.leave(room);
      } catch (err) {
        socket.leave(room);
        console.error(`[WS] Could not check the role for ${subscribe} (user ${String(userId)}):`, err instanceof Error ? err.message : err);
      }
    });

    socket.on(unsubscribe, () => {
      if (!socketRateLimit(socket, 'admin:unsubscribe', 30)) return;
      socket.leave(room);
    });
  }
}
