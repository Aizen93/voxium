import type { Server as SocketServer } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, AdminMetricsSnapshot } from '@voxium/shared';
import { getOnlineUsers } from '../utils/redis';
import { getActiveVoiceChannelCount, getTotalVoiceUsers } from './voiceHandler';
import { getActiveDMCallCount, getTotalDMVoiceUsers } from './dmVoiceHandler';
import { prisma } from '../utils/prisma';

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startAdminMetricsEmitter(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>
) {
  if (intervalId) return;

  intervalId = setInterval(async () => {
    // Only emit if someone is subscribed
    const room = io.sockets.adapter.rooms.get('admin:metrics');
    if (!room || room.size === 0) return;

    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      const [onlineUserIds, messagesLastHour] = await Promise.all([
        getOnlineUsers(),
        prisma.message.count({ where: { createdAt: { gte: oneHourAgo } } }),
      ]);

      const snapshot: AdminMetricsSnapshot = {
        onlineUsers: onlineUserIds.length,
        voiceChannels: getActiveVoiceChannelCount(),
        voiceUsers: getTotalVoiceUsers(),
        dmCalls: getActiveDMCallCount(),
        dmVoiceUsers: getTotalDMVoiceUsers(),
        messagesLastHour,
      };

      io.to('admin:metrics').emit('admin:metrics', snapshot);
    } catch (err) {
      console.error('[AdminMetrics] Error emitting metrics:', err);
    }
  }, 5000);
}

export function stopAdminMetricsEmitter() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
