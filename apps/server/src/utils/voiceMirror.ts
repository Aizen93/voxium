import { E2E_CALL_EPOCH_RE } from '@voxium/shared';
import { getRedis } from './redis';
import { annotationKey } from './annotationState';

/** One occupant a reap removed, with the E2E epoch their session announced (secure voice only). */
export interface ReapedVoiceOccupant {
  userId: string;
  epoch?: string;
}

/**
 * The epoch a mirrored occupant's session announced, when its entry holds a
 * well-formed one. Anything else (malformed JSON, another shape, an older
 * entry without it) gives none, and the departure then applies as before.
 */
function mirroredEpoch(json: string): string | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const epoch = (value as { e2eEpoch?: unknown }).e2eEpoch;
    return typeof epoch === 'string' && E2E_CALL_EPOCH_RE.test(epoch) ? epoch : undefined;
  } catch {
    // Not JSON: the entry carries no epoch to report (the reap still removes it)
    return undefined;
  }
}

/**
 * Delete one channel's entire Redis voice mirror (users hash, server/node
 * mapping, screen-share flag, active-set membership, and the participants'
 * reverse-lookup keys). Returns the occupants that were mirrored, each with the
 * epoch its entry holds, so callers can emit voice:user_left for each ghost.
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
): Promise<ReapedVoiceOccupant[]> {
  const redis = getRedis();
  const users = await redis.hGetAll(`voice:channel:users:${channelId}`);
  const occupants = Object.entries(users ?? {}).map(([userId, json]): ReapedVoiceOccupant => {
    const epoch = mirroredEpoch(json);
    return epoch ? { userId, epoch } : { userId };
  });
  const userIds = occupants.map((occupant) => occupant.userId);
  const pipeline = redis.multi()
    .del(`voice:channel:users:${channelId}`)
    .del(`voice:channel:server:${channelId}`)
    .del(`voice:screen:${channelId}`)
    .del(annotationKey(channelId))
    .sRem('voice:active', channelId);
  if (!opts?.preserveNodeKey) {
    pipeline.del(`voice:channel:node:${channelId}`);
  }
  for (const uid of userIds) {
    pipeline.del(`voice:user:${uid}`);
  }
  await pipeline.exec();
  return occupants;
}

/**
 * Guarded reap for a channel whose owner was OBSERVED to be dead. Atomically
 * deletes `voice:channel:node:{id}` ONLY IF it still records that same dead
 * owner (Lua CAS) — if a peer took the channel over between our liveness check
 * and this call, the fresh owner's mirror is left untouched and `null` is
 * returned. Prevents the reaper from wiping a concurrent takeover.
 *
 * Returns the reaped occupants, or null when ownership changed under us.
 */
export async function reapDeadOwnerChannelMirror(
  channelId: string,
  observedOwner: string | null,
): Promise<ReapedVoiceOccupant[] | null> {
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
