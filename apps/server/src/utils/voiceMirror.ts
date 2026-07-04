import { getRedis } from './redis';

/**
 * Delete one channel's entire Redis voice mirror (users hash, server/node
 * mapping, screen-share flag, active-set membership, and the participants'
 * reverse-lookup keys). Returns the userIds that were mirrored so callers can
 * emit voice:user_left for each ghost.
 *
 * Leaf module: used by voiceHandler (boot cleanup), voiceCluster (dead-node
 * reaper), and voiceRelay (dead-owner takeover) without import cycles.
 */
export async function reapVoiceChannelMirror(channelId: string): Promise<string[]> {
  const redis = getRedis();
  const users = await redis.hGetAll(`voice:channel:users:${channelId}`);
  const userIds = Object.keys(users ?? {});
  const pipeline = redis.multi()
    .del(`voice:channel:users:${channelId}`)
    .del(`voice:channel:server:${channelId}`)
    .del(`voice:channel:node:${channelId}`)
    .del(`voice:screen:${channelId}`)
    .sRem('voice:active', channelId);
  for (const uid of userIds) {
    pipeline.del(`voice:user:${uid}`);
  }
  await pipeline.exec();
  return userIds;
}
