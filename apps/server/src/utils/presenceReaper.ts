import type { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@voxium/shared';
import { clearPresenceState, getRedis } from './redis';

type IO = SocketServer<ClientToServerEvents, ServerToClientEvents>;

/** The subset of the Prisma client the sweep reads and writes. */
export interface PresenceReaperDb {
  user: { updateMany: (args: { where: { status: string; id?: { in: string[] } }; data: { status: string } }) => Promise<unknown> };
  serverMember: { findMany: (args: { where: { userId: string }; select: { serverId: true } }) => Promise<Array<{ serverId: string }>> };
  conversation: {
    findMany: (args: { where: { OR: Array<{ user1Id: string } | { user2Id: string }> }; select: { id: true } }) => Promise<Array<{ id: string }>>;
  };
}

export const PRESENCE_REAP_INTERVAL_MS = 60_000;
// Shorter than the interval so the next tick can take it; long enough that
// two nodes whose timers fire a few seconds apart do not both sweep.
const PRESENCE_REAP_LOCK_TTL_S = 45;
const PRESENCE_REAP_LOCK_KEY = 'lock:presencereap';

let reaperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reconcile presence with the sockets that actually exist, cluster-wide, and
 * tell everyone about the users this took offline.
 *
 * The connect and disconnect handlers keep presence right on every path they
 * see, but a socket whose unregistration never ran — a node killed hard, a
 * Redis command that failed mid-disconnect — leaves a user who reads as online
 * with no socket behind them, in Redis, in the DB column the People panel is
 * built from, and on every client that heard the last `presence:update`.
 * Nothing used to look again until the next boot. The voice side has had its
 * 60 s dead-node reaper since multi-node; this is the presence side's.
 *
 * It is the boot sweep's scoped path (`allowFullWipe: false`: this node is
 * serving, so only sockets missing from the cluster snapshot are reaped, and
 * a snapshot that cannot see every live peer is refused), under a short
 * cluster lock so one node sweeps per tick. A reaped user's contacts are told
 * the way the disconnect handler tells them: `presence:update` to every
 * server they are in and every DM room they are part of.
 *
 * Returns how many users were taken offline (0 when the lock was held, the
 * snapshot refused, or nothing was stale).
 */
export async function reapStalePresence(io: IO, db: PresenceReaperDb): Promise<number> {
  const redis = getRedis();
  const claimed = await redis.set(PRESENCE_REAP_LOCK_KEY, '1', { NX: true, EX: PRESENCE_REAP_LOCK_TTL_S });
  if (claimed !== 'OK') return 0;

  const { skipped, offlineUserIds } = await clearPresenceState(db, io, { allowFullWipe: false });
  if (skipped || offlineUserIds.length === 0) return 0;

  for (const userId of offlineUserIds) {
    try {
      const [memberships, conversations] = await Promise.all([
        db.serverMember.findMany({ where: { userId }, select: { serverId: true } }),
        db.conversation.findMany({ where: { OR: [{ user1Id: userId }, { user2Id: userId }] }, select: { id: true } }),
      ]);
      for (const m of memberships) {
        io.to(`server:${m.serverId}`).emit('presence:update', { userId, status: 'offline' });
      }
      for (const c of conversations) {
        io.to(`dm:${c.id}`).emit('presence:update', { userId, status: 'offline' });
      }
    } catch (err) {
      // Redis and the DB column are already right; the clients catch up on
      // their next fetch. Logged, and the next user still gets its broadcast.
      console.warn(`[Presence] Could not broadcast the reaped offline status of ${userId}:`, err instanceof Error ? err.message : err);
    }
  }
  console.warn(`[Presence] Reaper took ${offlineUserIds.length} ghost user(s) offline`);
  return offlineUserIds.length;
}

/** Start the periodic sweep. Call once after Socket.IO is initialized. */
export function startPresenceReaper(io: IO, db: PresenceReaperDb): void {
  if (reaperTimer) clearInterval(reaperTimer);
  reaperTimer = setInterval(() => {
    reapStalePresence(io, db).catch((err) =>
      console.warn('[Presence] Stale presence reap failed:', err instanceof Error ? err.message : err));
  }, PRESENCE_REAP_INTERVAL_MS);
  // Never keep the process alive just for the sweep
  reaperTimer.unref?.();
}

export function stopPresenceReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
