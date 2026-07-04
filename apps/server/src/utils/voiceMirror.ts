import { getRedis } from './redis';

/**
 * Delete one channel's entire Redis voice mirror (users hash, server/node
 * mapping, screen-share flag, active-set membership, and the participants'
 * reverse-lookup keys). Returns the userIds that were mirrored so callers can
 * emit voice:user_left for each ghost.
 *
 * `preserveNodeKey` keeps `voice:channel:node:{id}` intact — used by the
 * dead-owner takeover, which has already CAS'd that key to itself and must not
 * delete its own fresh claim.
 *
 * Leaf module: used by voiceHandler (boot cleanup), voiceCluster (dead-node
 * reaper), and voiceRelay (dead-owner takeover) without import cycles.
 */
export async function reapVoiceChannelMirror(
  channelId: string,
  opts?: { preserveNodeKey?: boolean },
): Promise<string[]> {
  const redis = getRedis();
  const users = await redis.hGetAll(`voice:channel:users:${channelId}`);
  const userIds = Object.keys(users ?? {});
  const pipeline = redis.multi()
    .del(`voice:channel:users:${channelId}`)
    .del(`voice:channel:server:${channelId}`)
    .del(`voice:screen:${channelId}`)
    .sRem('voice:active', channelId);
  if (!opts?.preserveNodeKey) {
    pipeline.del(`voice:channel:node:${channelId}`);
  }
  for (const uid of userIds) {
    pipeline.del(`voice:user:${uid}`);
  }
  await pipeline.exec();
  return userIds;
}

/**
 * Guarded reap for a channel whose owner was OBSERVED to be dead. Atomically
 * deletes `voice:channel:node:{id}` ONLY IF it still records that same dead
 * owner (Lua CAS) — if a peer took the channel over between our liveness check
 * and this call, the fresh owner's mirror is left untouched and `null` is
 * returned. Prevents the reaper from wiping a concurrent takeover.
 *
 * Returns the reaped userIds, or null when ownership changed under us.
 */
export async function reapDeadOwnerChannelMirror(
  channelId: string,
  observedOwner: string | null,
): Promise<string[] | null> {
  const redis = getRedis();
  if (observedOwner) {
    const won = await redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then
         redis.call('del', KEYS[1])
         return 1
       end
       return 0`,
      { keys: [`voice:channel:node:${channelId}`], arguments: [observedOwner] },
    ) as number;
    if (won !== 1) return null; // a live node took over — hands off
  }
  return await reapVoiceChannelMirror(channelId);
}
