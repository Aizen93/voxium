import type { Server as SocketServer } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, AdminMetricsSnapshot } from '@voxium/shared';
import { getOnlineUsers } from '../utils/redis';
import { getActiveVoiceChannelCount, getTotalVoiceUsers } from './voiceHandler';
import { getActiveDMCallCount, getTotalDMVoiceUsers } from './dmVoiceHandler';
import { prisma } from '../utils/prisma';

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

export function startAdminMetricsEmitter(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>
) {
  if (!stopped) return;
  stopped = false;

  async function tick() {
    if (stopped) return;

    // Only emit if someone is subscribed
    const room = io.sockets.adapter.rooms.get('admin:metrics');
    if (room && room.size > 0) {
      try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        const [onlineUserIds, messagesLastHour, dmCalls, dmVoiceUsers, voiceChannels, voiceUsers] = await Promise.all([
          getOnlineUsers(),
          prisma.message.count({ where: { createdAt: { gte: oneHourAgo } } }),
          getActiveDMCallCount(),
          getTotalDMVoiceUsers(),
          getActiveVoiceChannelCount(),
          getTotalVoiceUsers(),
        ]);

        const snapshot: AdminMetricsSnapshot = {
          onlineUsers: onlineUserIds.length,
          voiceChannels,
          voiceUsers,
          dmCalls,
          dmVoiceUsers,
          messagesLastHour,
        };

        io.to('admin:metrics').emit('admin:metrics', snapshot);
      } catch (err) {
        console.error('[AdminMetrics] Error emitting metrics:', err);
      }
    }

    // Schedule next tick only if not stopped
    if (!stopped) {
      timeoutId = setTimeout(tick, 5000);
    }
  }

  timeoutId = setTimeout(tick, 5000);
}

export function stopAdminMetricsEmitter() {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}
