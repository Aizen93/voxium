import { WS_EVENTS } from '@voxium/shared';
import { prisma } from './prisma';
import { getIO } from '../websocket/socketServer';

/**
 * Tells every space a user is in that their display name or avatar changed:
 * `user:updated` to each `server:{id}` room. The one emitter for it — the
 * profile route and the admin storage delete of an avatar both use it. The
 * caller runs it AFTER the committing write and decides what a failure means.
 */
export async function broadcastProfileUpdate(
  userId: string,
  profile: { displayName: string; avatarUrl: string | null },
): Promise<void> {
  const memberships = await prisma.serverMember.findMany({
    where: { userId },
    select: { serverId: true },
  });
  const io = getIO();
  const payload = { userId, displayName: profile.displayName, avatarUrl: profile.avatarUrl };
  for (const { serverId } of memberships) {
    io.to(`server:${serverId}`).emit(WS_EVENTS.USER_UPDATED, payload);
  }
}
