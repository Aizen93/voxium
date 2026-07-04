import type { Server as SocketServer } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { getRedis, getRedisPubSub, getRedisConfigSub, NODE_ID, isNodeAlive } from '../utils/redis';
import { cleanupServerVoice, reapVoiceChannelMirror, reapOrphanedRemoteParticipants } from './voiceHandler';

type IO = SocketServer<ClientToServerEvents, ServerToClientEvents>;

// Cross-node voice coordination channel. mediasoup objects (Routers, Transports,
// Producers, Consumers) are node-local C++ handles — operations that must touch
// every node's local voice state (e.g. server deletion) are fanned out here.
const CLUSTER_CHANNEL = 'voice:cluster';

const REAPER_INTERVAL_MS = 60_000;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

interface ServerCleanupMessage {
  type: 'server_cleanup';
  serverId: string;
  fromNode: string;
}

/**
 * Subscribe to cross-node voice coordination and start the dead-node reaper.
 * Call once at startup after Socket.IO is initialized.
 */
export async function initVoiceCluster(io: IO): Promise<void> {
  const configSub = getRedisConfigSub();
  await configSub.subscribe(CLUSTER_CHANNEL, (message) => {
    try {
      const msg = JSON.parse(message) as ServerCleanupMessage;
      if (msg.fromNode === NODE_ID()) return; // originator already ran locally
      if (msg.type === 'server_cleanup' && typeof msg.serverId === 'string') {
        cleanupServerVoice(io, msg.serverId);
      }
    } catch (err) {
      console.warn('[VoiceCluster] Malformed cluster message:', err);
    }
  });

  reaperTimer = setInterval(() => {
    reapDeadNodeVoiceState(io).catch((err) =>
      console.warn('[VoiceCluster] Dead-node voice reap failed:', err));
    // Owner-side sweep: relayed participants whose HOME node crashed never send
    // a disconnect — tear down their sessions once their socket is gone
    reapOrphanedRemoteParticipants(io).catch((err) =>
      console.warn('[VoiceCluster] Orphaned-participant reap failed:', err));
  }, REAPER_INTERVAL_MS);
  reaperTimer.unref?.();
}

export function stopVoiceCluster(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

/**
 * Clean up all voice state for a deleted server on EVERY node.
 * Runs the local cleanup immediately, then broadcasts so each peer node reaps
 * its own node-local mediasoup objects (cleanupServerVoice is inherently local).
 */
export async function broadcastServerVoiceCleanup(io: IO, serverId: string): Promise<void> {
  cleanupServerVoice(io, serverId);
  try {
    const { pub } = getRedisPubSub();
    await pub.publish(CLUSTER_CHANNEL, JSON.stringify({
      type: 'server_cleanup',
      serverId,
      fromNode: NODE_ID(),
    } satisfies ServerCleanupMessage));
  } catch (err) {
    // Peers self-heal via the dead-channel paths; the local cleanup already ran.
    console.warn('[VoiceCluster] Failed to broadcast server voice cleanup:', err);
  }
}

/**
 * Reap the Redis voice mirror of channels owned by nodes with no live heartbeat
 * (crashed or SIGKILLed peers). Runs on an interval on every node, so ghost
 * occupants disappear within ~heartbeat-TTL + one reaper tick even if the dead
 * node never comes back. Emits voice:user_left for each ghost so connected
 * clients clear them immediately.
 */
export async function reapDeadNodeVoiceState(io: IO): Promise<void> {
  const redis = getRedis();
  const active = await redis.sMembers('voice:active');
  for (const channelId of active) {
    const owner = await redis.get(`voice:channel:node:${channelId}`);
    if (owner === NODE_ID()) continue;               // our own live channel
    if (owner && await isNodeAlive(owner)) continue; // healthy peer's channel
    const userIds = await reapVoiceChannelMirror(channelId);
    for (const userId of userIds) {
      io.to(`channel:${channelId}`).emit('voice:user_left', { channelId, userId });
    }
    console.warn(`[VoiceCluster] Reaped voice channel ${channelId} owned by dead node ${owner ?? '(none)'} — ${userIds.length} ghost user(s)`);
  }
}
