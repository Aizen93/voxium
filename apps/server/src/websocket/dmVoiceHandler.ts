import type { Server as SocketServer, Socket } from 'socket.io';
import { DM_SIGNAL_MAX, E2E_DEVICE_ID_RE } from '@voxium/shared';
import type { ServerToClientEvents, ClientToServerEvents, Message } from '@voxium/shared';
import { prisma } from '../utils/prisma';
import { leaveCurrentVoiceChannel } from './voiceHandler';
import { socketRateLimit } from '../middleware/rateLimiter';
import { isFeatureEnabled } from '../utils/featureFlags';
import { getRedis, anyOtherNodeAlive, socketExistsInCluster, type ClusterSocketLookup } from '../utils/redis';

const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true },
} as const;

async function createSystemMessage(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  conversationId: string,
  authorId: string,
  content: string
) {
  try {
    const message = await prisma.message.create({
      data: {
        content,
        type: 'system',
        conversationId,
        authorId,
      },
      include: { author: { select: authorSelect.select } },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    const payload: Message = {
      id: message.id,
      content: message.content,
      type: message.type,
      channelId: message.channelId,
      conversationId: message.conversationId,
      author: message.author,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
      reactions: [],
    };
    io.to(`dm:${conversationId}`).emit('dm:message:new', payload);
  } catch (err) {
    console.error('[DMVoice] Failed to create system message:', err);
  }
}

// ─── Redis keys ───────────────────────────────────────────────────────────────
// dm:voice:users:{conversationId}  — Hash: userId → JSON({ socketId, selfMute, selfDeaf })
// dm:voice:call:{userId}           — String: conversationId
// dm:voice:active                  — Set of conversationIds with active calls

// Timeout map stays node-local (Node.js timeouts can't be serialized)
const DM_CALL_TIMEOUT_MS = 30_000;
const dmCallTimeouts = new Map<string, NodeJS.Timeout>();

function clearCallTimeout(conversationId: string) {
  const timeout = dmCallTimeouts.get(conversationId);
  if (timeout) {
    clearTimeout(timeout);
    dmCallTimeouts.delete(conversationId);
  }
}

// ─── Redis helpers ────────────────────────────────────────────────────────────

interface DMVoiceUserState {
  socketId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  /**
   * The E2E device the participant is calling from. Routing metadata only —
   * the server validates the SHAPE and relays it so peers know which device
   * to seal call signals to; the cryptographic binding happens client-side
   * (a lied-about deviceId fails Olm decryption against the pinned identity).
   */
  deviceId?: string;
}

async function getDMVoiceUsers(conversationId: string): Promise<Map<string, DMVoiceUserState>> {
  const redis = getRedis();
  const data = await redis.hGetAll(`dm:voice:users:${conversationId}`);
  const map = new Map<string, DMVoiceUserState>();
  for (const [userId, json] of Object.entries(data)) {
    map.set(userId, JSON.parse(json));
  }
  return map;
}

async function addDMVoiceUser(
  conversationId: string,
  userId: string,
  state: DMVoiceUserState
): Promise<void> {
  // NOTE: These keys are intentionally created WITHOUT a TTL. A prior 10-minute TTL
  // safety net expired keys mid-call (signaling/mute/hangup silently broke past 10
  // minutes). Stale keys from a crash are instead reaped by clearDMVoiceState() on
  // boot — correct for single-node, since a restart drops every socket anyway.
  // Multi-node would additionally need a per-node heartbeat/TTL to reap a crashed peer.
  const redis = getRedis();
  await redis.multi()
    .hSet(`dm:voice:users:${conversationId}`, userId, JSON.stringify(state))
    .set(`dm:voice:call:${userId}`, conversationId)
    .sAdd('dm:voice:active', conversationId)
    .exec();
}

/**
 * Rebind a user's registered socket for an ongoing call WITHOUT ending it — used when
 * a reconnected socket rejoins the same call. Preserves the call and re-targets
 * signaling relay at the new socket. Returns false if the user is no longer in the call.
 */
async function updateDMVoiceUserSocket(
  conversationId: string,
  userId: string,
  socketId: string,
  selfMute: boolean,
  selfDeaf: boolean,
  deviceId?: string
): Promise<boolean> {
  const redis = getRedis();
  // A rebind that omits deviceId (transient E2E init failure on reconnect)
  // must not erase the stored routing hint: the peer's next replay would read
  // a deviceId-less state and abort the call as "peer must update". A rebind
  // WITH a deviceId still overwrites — that is a legitimate device change.
  let effectiveDeviceId = deviceId;
  if (!effectiveDeviceId) {
    try {
      const currentStr = await redis.hGet(`dm:voice:users:${conversationId}`, userId);
      if (currentStr) {
        const current = JSON.parse(currentStr) as DMVoiceUserState;
        if (current.deviceId) effectiveDeviceId = current.deviceId;
      }
    } catch (err) {
      console.warn(`[DMVoice] Could not read call state for deviceId merge (rebind proceeds without it):`, err);
    }
  }
  const state: DMVoiceUserState = { socketId, selfMute, selfDeaf, ...(effectiveDeviceId && { deviceId: effectiveDeviceId }) };
  const updated = await redis.eval(
    `if redis.call('hexists', KEYS[1], ARGV[1]) == 0 then return 0 end
     redis.call('hset', KEYS[1], ARGV[1], ARGV[2])
     redis.call('set', KEYS[2], ARGV[3])
     return 1`,
    { keys: [`dm:voice:users:${conversationId}`, `dm:voice:call:${userId}`], arguments: [userId, JSON.stringify(state), conversationId] },
  ) as number;
  return updated === 1;
}

/**
 * Clear stale DM-voice Redis state on startup.
 *
 * Multi-node aware: DM-call state is fully Redis-based and calls keep working
 * across nodes, so when other nodes are alive a full wipe would destroy the
 * state of LIVE calls between users on peer nodes (mute/leave/signal handlers
 * validate against these keys). In that case only entries whose registered
 * socket no longer exists ANYWHERE in the cluster (crash ghosts) are reaped.
 * The full wipe runs only when this is the sole node — every socket is dead.
 */
export async function clearDMVoiceState(
  io?: ClusterSocketLookup & { to: (room: string) => { emit: (event: 'dm:voice:left', data: { conversationId: string; userId: string }) => void } },
): Promise<void> {
  const redis = getRedis();

  if (io && await anyOtherNodeAlive()) {
    let reaped = 0;
    const activeConvs = await redis.sMembers('dm:voice:active');
    for (const conversationId of activeConvs) {
      const users = await redis.hGetAll(`dm:voice:users:${conversationId}`);
      for (const [userId, json] of Object.entries(users)) {
        let socketId: string | undefined;
        try {
          socketId = (JSON.parse(json) as DMVoiceUserState).socketId;
        } catch {
          socketId = undefined; // malformed entry — treat as ghost
        }
        try {
          if (socketId && await socketExistsInCluster(io, socketId)) continue;
        } catch (err) {
          console.warn('[DMVoice] Cluster socket lookup failed, skipping reap for', userId, err);
          continue;
        }
        await removeDMVoiceUser(conversationId, userId);
        io.to(`dm:voice:${conversationId}`).emit('dm:voice:left', { conversationId, userId });
        reaped++;
      }
    }
    // Orphaned reverse-lookup keys pointing at conversations with no user entry
    for await (const batch of redis.scanIterator({ MATCH: 'dm:voice:call:*', COUNT: 200 })) {
      for (const key of batch) {
        const userId = key.slice('dm:voice:call:'.length);
        const conversationId = await redis.get(key);
        if (!conversationId) continue;
        const stillInCall = await redis.hExists(`dm:voice:users:${conversationId}`, userId);
        if (!stillInCall) await redis.del(key);
      }
    }
    if (reaped > 0) {
      console.log(`[DMVoice] Reaped ${reaped} stale DM-call participant(s) (scoped, peers alive)`);
    }
    return;
  }

  // Sole node: every socket is gone, all DM-voice state is stale — full wipe.
  const keys: string[] = [];
  for await (const batch of redis.scanIterator({ MATCH: 'dm:voice:*', COUNT: 200 })) {
    for (const k of batch) keys.push(k);
  }
  if (keys.length > 0) {
    await redis.del(keys);
    console.log(`[DMVoice] Cleared ${keys.length} stale DM-voice key(s)`);
  }
}

async function removeDMVoiceUser(conversationId: string, userId: string): Promise<void> {
  // Atomic via Lua: the hLen check and the hash/active-set deletion must be indivisible.
  // A non-atomic version let a concurrent addDMVoiceUser for the same conversation slot
  // between them, which could delete a just-joined user's hash and orphan a
  // dm:voice:call:{userId} key (never reaped from the active set).
  await getRedis().eval(
    `redis.call('hdel', KEYS[1], ARGV[1])
     redis.call('del', KEYS[2])
     if redis.call('hlen', KEYS[1]) == 0 then
       redis.call('del', KEYS[1])
       redis.call('srem', KEYS[3], ARGV[2])
     end
     return 1`,
    {
      keys: [`dm:voice:users:${conversationId}`, `dm:voice:call:${userId}`, 'dm:voice:active'],
      arguments: [userId, conversationId],
    },
  );
}

async function getUserDMCall(userId: string): Promise<string | null> {
  return await getRedis().get(`dm:voice:call:${userId}`);
}

/**
 * Arm (or re-arm) the 30s auto-cancel timer for an unanswered call — fires only while the
 * call still has a single participant (i.e. is still ringing). Used both when a call first
 * starts ringing and when the caller's socket reconnects mid-ring (so the timer survives
 * the reconnect instead of being cancelled and never re-armed).
 */
function armCallTimeout(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  conversationId: string,
  ringingUserId: string,
) {
  clearCallTimeout(conversationId);
  dmCallTimeouts.set(conversationId, setTimeout(async () => {
    dmCallTimeouts.delete(conversationId);
    // Check Redis — call may have been answered on another node
    try {
      const currentUsers = await getDMVoiceUsers(conversationId);
      // Exactly 1 => still ringing (auto-cancel). 0 => already ended (do nothing).
      if (currentUsers.size === 1) {
        console.log(`[DMVoice] Call timeout for conversation ${conversationId}`);
        // Clean up all remaining users. socketsLeave is fire-and-forget across
        // the cluster — fetchSockets here used to WAIT for every node's reply,
        // so one dead/unresponsive peer node made this throw after 5s and the
        // ended/left emits below never ran (clients stuck "in a call").
        for (const [uid] of currentUsers) {
          await removeDMVoiceUser(conversationId, uid);
          io.in(`user:${uid}`).socketsLeave(`dm:voice:${conversationId}`);
        }
        io.to(`dm:${conversationId}`).emit('dm:voice:left', { conversationId, userId: ringingUserId });
        io.to(`dm:${conversationId}`).emit('dm:voice:ended', { conversationId });
        createSystemMessage(io, conversationId, ringingUserId, 'Voice call ended');
      }
    } catch (err) {
      console.error(`[DMVoice] Redis error during call timeout cleanup:`, err);
    }
  }, DM_CALL_TIMEOUT_MS));
}

// ─── Leave / cleanup ──────────────────────────────────────────────────────────

export async function leaveCurrentDMVoiceChannel(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  // Structural subset so voiceHandler can pass either a real Socket or a
  // relay shim (multi-node) — only id / leave / data are touched here.
  socket: Pick<Socket<ClientToServerEvents, ServerToClientEvents>, 'id' | 'leave'> & { data: { dmCallConversationId?: string } },
  userId: string,
  opts?: { force?: boolean }
) {
  const conversationId = await getUserDMCall(userId);
  if (!conversationId) return;

  const force = opts?.force ?? false;

  // Socket-ownership guard (skip on force): only the socket currently registered in
  // the call may end it. A stale socket — whose session a reconnect has since taken
  // over — must NOT tear down the live 1-on-1 call, otherwise the call would end
  // ~10-35s after any network blip when the old socket finally times out.
  if (!force) {
    const selfStr = await getRedis().hGet(`dm:voice:users:${conversationId}`, userId);
    if (selfStr) {
      let selfSocketId: string | undefined;
      try { selfSocketId = (JSON.parse(selfStr) as DMVoiceUserState).socketId; } catch { selfSocketId = undefined; }
      if (selfSocketId && selfSocketId !== socket.id) {
        socket.leave(`dm:voice:${conversationId}`);
        if (socket.data.dmCallConversationId === conversationId) socket.data.dmCallConversationId = undefined;
        return;
      }
    }
  }

  console.log(`[DMVoice] Removing user ${userId} from DM call ${conversationId}`);

  // Collect remaining users BEFORE removing the leaving user
  const callUsers = await getDMVoiceUsers(conversationId);
  const remainingUsers: Array<{ id: string }> = [];
  for (const [uid] of callUsers.entries()) {
    if (uid !== userId) remainingUsers.push({ id: uid });
  }

  // Remove the leaving user from Redis
  await removeDMVoiceUser(conversationId, userId);
  socket.leave(`dm:voice:${conversationId}`);
  socket.data.dmCallConversationId = undefined;

  // DM calls are 1-on-1: always end the call when someone leaves.
  // Clean up remaining users' state and socket rooms. socketsLeave is
  // fire-and-forget across the cluster — fetchSockets here used to WAIT for
  // every node's reply, so one dead/unresponsive peer node made this throw
  // after 5s and the left/ended emits below never ran: the remaining
  // participant's client stayed "in a call" forever.
  for (const remaining of remainingUsers) {
    await removeDMVoiceUser(conversationId, remaining.id);
    io.in(`user:${remaining.id}`).socketsLeave(`dm:voice:${conversationId}`);
  }

  clearCallTimeout(conversationId);

  // Emit left then ended — all clients should tear down
  io.to(`dm:${conversationId}`).emit('dm:voice:left', { conversationId, userId });
  io.to(`dm:${conversationId}`).emit('dm:voice:ended', { conversationId });

  // Persist "call ended" system message
  createSystemMessage(io, conversationId, userId, 'Voice call ended');
}

/** Returns count of active DM calls (cross-node via Redis) */
export async function getActiveDMCallCount(): Promise<number> {
  return await getRedis().sCard('dm:voice:active');
}

/** Returns total number of users in all DM calls (cross-node via Redis) */
export async function getTotalDMVoiceUsers(): Promise<number> {
  const redis = getRedis();
  const activeConvs = await redis.sMembers('dm:voice:active');
  if (activeConvs.length === 0) return 0;
  const pipeline = redis.multi();
  for (const convId of activeConvs) {
    pipeline.hLen(`dm:voice:users:${convId}`);
  }
  const results = await pipeline.exec();
  let count = 0;
  for (const val of results) {
    if (typeof val === 'number') count += val;
  }
  return count;
}

export function handleDMVoiceEvents(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>
) {
  const userId = socket.data.userId as string;

  socket.on('dm:voice:join', async (conversationId: string, state?: { selfMute: boolean; selfDeaf: boolean; deviceId?: string }) => {
    if (!socketRateLimit(socket, 'dm:voice:join', 10)) return;
    if (typeof conversationId !== 'string' || !conversationId) return;
    if (!isFeatureEnabled('dm_voice')) {
      socket.emit('voice:error', { message: 'Voice calls are currently disabled' });
      return;
    }
    console.log(`[DMVoice] User ${userId} requesting to join DM call ${conversationId}`);

    // Verify user is a participant of this conversation
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    });
    if (!conv || (conv.user1Id !== userId && conv.user2Id !== userId)) {
      console.log(`[DMVoice] User ${userId} not a participant of conversation ${conversationId}`);
      return;
    }

    // Leave any current server voice channel first (mutual exclusivity; force-evict
    // any stale session so a reconnected socket doesn't orphan old voice transports).
    leaveCurrentVoiceChannel(io, socket, userId, { force: true });

    const initialMute = state?.selfMute ?? false;
    const initialDeaf = state?.selfDeaf ?? false;
    // E2E call-signaling routing hint: shape-validated, stripped if malformed
    // (never trusted — clients bind it cryptographically via Olm)
    const deviceId =
      typeof state?.deviceId === 'string' && E2E_DEVICE_ID_RE.test(state.deviceId)
        ? state.deviceId
        : undefined;

    // Handle an existing DM call for this user.
    const existingCall = await getUserDMCall(userId);
    if (existingCall === conversationId) {
      // Reconnect into the SAME call: rebind our socket in place without ending the
      // call or re-ringing the peer, then rehydrate this socket's participant view.
      const rebound = await updateDMVoiceUserSocket(conversationId, userId, socket.id, initialMute, initialDeaf, deviceId);
      if (rebound) {
        socket.join(`dm:voice:${conversationId}`);
        socket.data.dmCallConversationId = conversationId;
        const rejoinUsers = await getDMVoiceUsers(conversationId);
        // Re-arm (still ringing) or clear (already answered) the auto-cancel timer.
        // Without re-arming, a caller reconnecting mid-ring would cancel the 30s
        // unanswered-call timeout and never restore it, stranding the call ringing
        // forever with orphaned Redis keys (the safety-net TTL was removed for HIGH-2).
        if (rejoinUsers.size === 1) armCallTimeout(io, conversationId, userId);
        else clearCallTimeout(conversationId);
        const ids = Array.from(rejoinUsers.keys());
        const infos = ids.length > 0 ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        }) : [];
        for (const u of infos) {
          const st = rejoinUsers.get(u.id);
          socket.emit('dm:voice:joined', { conversationId, user: { ...u, selfMute: st?.selfMute ?? false, selfDeaf: st?.selfDeaf ?? false, serverMuted: false, serverDeafened: false, speaking: false, ...(st?.deviceId && { deviceId: st.deviceId }) } });
        }
        console.log(`[DMVoice] User ${userId} rebound socket for existing call ${conversationId}`);
        return;
      }
      // Rebind failed (user left the call between checks) — fall through to a fresh join.
    } else if (existingCall) {
      // Joining a DIFFERENT call — leave the old one (force-evict; ends that 1-on-1 call).
      await leaveCurrentDMVoiceChannel(io, socket, userId, { force: true });
    }

    // DM calls are 1-on-1 — reject if call already has 2 participants
    let existingUsers: Map<string, DMVoiceUserState>;
    try {
      existingUsers = await getDMVoiceUsers(conversationId);
    } catch (err) {
      console.error(`[DMVoice] Redis error checking call capacity:`, err);
      socket.emit('voice:error', { message: 'Voice service temporarily unavailable.' });
      return;
    }
    if (existingUsers.size >= 2) {
      socket.emit('voice:error', { message: 'This call is already full.' });
      return;
    }

    // Join the DM voice room
    socket.join(`dm:voice:${conversationId}`);
    socket.data.dmCallConversationId = conversationId;

    try {
      await addDMVoiceUser(conversationId, userId, {
        socketId: socket.id,
        selfMute: initialMute,
        selfDeaf: initialDeaf,
        ...(deviceId && { deviceId }),
      });
    } catch (err) {
      console.error(`[DMVoice] Redis error adding user to call:`, err);
      socket.leave(`dm:voice:${conversationId}`);
      socket.data.dmCallConversationId = undefined;
      socket.emit('voice:error', { message: 'Voice service temporarily unavailable.' });
      return;
    }

    // Fetch user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });

    if (!user) return;

    const voiceUser = { ...user, selfMute: initialMute, selfDeaf: initialDeaf, serverMuted: false, serverDeafened: false, speaking: false, ...(deviceId && { deviceId }) };
    const callUsers = await getDMVoiceUsers(conversationId);

    if (callUsers.size === 1) {
      // First user in the call — send offer/ring to the DM room AND joined so caller appears in own dmCallUsers
      io.to(`dm:${conversationId}`).emit('dm:voice:offer', { conversationId, from: voiceUser });
      socket.emit('dm:voice:joined', { conversationId, user: voiceUser });

      // Persist "call started" system message
      createSystemMessage(io, conversationId, userId, 'Voice call started');

      // Start call timeout — auto-cancel if no one answers within 30s
      armCallTimeout(io, conversationId, userId);
    } else {
      // Second user joined — clear the call timeout
      clearCallTimeout(conversationId);
      // Notify the room
      io.to(`dm:${conversationId}`).emit('dm:voice:joined', { conversationId, user: voiceUser });

      // Send existing users to the joiner
      const existingUserIds = Array.from(callUsers.keys()).filter((id) => id !== userId);
      if (existingUserIds.length > 0) {
        const existingUserInfos = await prisma.user.findMany({
          where: { id: { in: existingUserIds } },
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        });
        const existingVoiceUsers = existingUserInfos.map((u) => {
          const uState = callUsers.get(u.id);
          return { ...u, selfMute: uState?.selfMute ?? false, selfDeaf: uState?.selfDeaf ?? false, serverMuted: false, serverDeafened: false, speaking: false, ...(uState?.deviceId && { deviceId: uState.deviceId }) };
        });
        // Send as joined events to the new joiner so they know who's already there
        for (const vu of existingVoiceUsers) {
          socket.emit('dm:voice:joined', { conversationId, user: vu });
        }
      }
    }
  });

  socket.on('dm:voice:leave', async (conversationId: string) => {
    if (!socketRateLimit(socket, 'dm:voice:leave', 30)) return;
    console.log(`[DMVoice] User ${userId} leaving DM call ${conversationId}`);
    await leaveCurrentDMVoiceChannel(io, socket, userId);
  });

  socket.on('dm:voice:decline', async (conversationId: string) => {
    if (!socketRateLimit(socket, 'dm:voice:decline', 10)) return;
    if (typeof conversationId !== 'string' || !conversationId) return;

    // Authorization: verify the declining user is a participant of this conversation
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    });
    if (!conv || (conv.user1Id !== userId && conv.user2Id !== userId)) return;

    console.log(`[DMVoice] User ${userId} declined DM call ${conversationId}`);

    const callUsers = await getDMVoiceUsers(conversationId);
    if (callUsers.size === 0) return;

    // End the call for all users in the conversation
    const callerIdForMsg = Array.from(callUsers.keys())[0];
    for (const [callerId] of callUsers) {
      await removeDMVoiceUser(conversationId, callerId);
      // socketsLeave: adapter-wide and fire-and-forget (never blocks on peers)
      io.in(`user:${callerId}`).socketsLeave(`dm:voice:${conversationId}`);
    }

    clearCallTimeout(conversationId);

    io.to(`dm:${conversationId}`).emit('dm:voice:left', { conversationId, userId: callerIdForMsg });
    io.to(`dm:${conversationId}`).emit('dm:voice:ended', { conversationId });
    createSystemMessage(io, conversationId, callerIdForMsg, 'Voice call ended');
  });

  socket.on('dm:voice:mute', async (muted: boolean) => {
    if (!socketRateLimit(socket, 'dm:voice:mute', 120)) return;
    if (typeof muted !== 'boolean') return;
    // Use socket.data for fast local lookup (source of truth is Redis)
    const conversationId = socket.data.dmCallConversationId as string;
    if (!conversationId) return;

    // Atomic read-modify-write via Lua to prevent race conditions
    const redis = getRedis();
    const updatedStr = await redis.eval(
      `local d = redis.call('hget', KEYS[1], ARGV[1])
       if not d then return nil end
       local t = cjson.decode(d)
       t.selfMute = ARGV[2] == '1'
       local s = cjson.encode(t)
       redis.call('hset', KEYS[1], ARGV[1], s)
       return s`,
      { keys: [`dm:voice:users:${conversationId}`], arguments: [userId, muted ? '1' : '0'] },
    ) as string | null;
    if (!updatedStr) return;

    const data: DMVoiceUserState = JSON.parse(updatedStr);
    io.to(`dm:${conversationId}`).emit('dm:voice:state_update', {
      conversationId,
      userId,
      selfMute: data.selfMute,
      selfDeaf: data.selfDeaf,
    });
  });

  socket.on('dm:voice:deaf', async (deafened: boolean) => {
    if (!socketRateLimit(socket, 'dm:voice:deaf', 120)) return;
    if (typeof deafened !== 'boolean') return;
    const conversationId = socket.data.dmCallConversationId as string;
    if (!conversationId) return;

    // Atomic read-modify-write via Lua to prevent race conditions
    const redis = getRedis();
    const updatedStr = await redis.eval(
      `local d = redis.call('hget', KEYS[1], ARGV[1])
       if not d then return nil end
       local t = cjson.decode(d)
       t.selfDeaf = ARGV[2] == '1'
       local s = cjson.encode(t)
       redis.call('hset', KEYS[1], ARGV[1], s)
       return s`,
      { keys: [`dm:voice:users:${conversationId}`], arguments: [userId, deafened ? '1' : '0'] },
    ) as string | null;
    if (!updatedStr) return;

    const data: DMVoiceUserState = JSON.parse(updatedStr);
    io.to(`dm:${conversationId}`).emit('dm:voice:state_update', {
      conversationId,
      userId,
      selfMute: data.selfMute,
      selfDeaf: data.selfDeaf,
    });
  });

  socket.on('dm:voice:speaking', (speaking: boolean) => {
    if (!socketRateLimit(socket, 'dm:voice:speaking', 120)) return;
    if (typeof speaking !== 'boolean') return;
    // Hot path — use socket.data for zero-latency local lookup
    const conversationId = socket.data.dmCallConversationId as string;
    if (!conversationId) return;

    io.to(`dm:${conversationId}`).emit('dm:voice:speaking', {
      conversationId,
      userId,
      speaking,
    });
  });

  socket.on('dm:voice:signal', async (data: { to: string; signal: unknown }) => {
    if (!socketRateLimit(socket, 'dm:voice:signal', 300)) return;
    if (!data || typeof data !== 'object' || typeof data.to !== 'string' || !data.to) return;
    // Only strings (olm1 envelopes after the E2E cutover) and plain objects
    // (legacy signals during rollout) are relayable. This gate also fixes a
    // latent crash: JSON.stringify(undefined | function | symbol) returns
    // undefined, so `.length` on it threw inside this async handler — an
    // unhandled rejection any client could trigger with a malformed frame.
    const signalType = typeof data.signal;
    if (data.signal == null || (signalType !== 'string' && signalType !== 'object')) return;
    // Reject excessively large signal payloads (serialized, UTF-16 chars)
    if (JSON.stringify(data.signal).length > DM_SIGNAL_MAX) return;
    const conversationId = socket.data.dmCallConversationId as string;
    if (!conversationId) return;

    // Look up target user's socketId from Redis (works cross-node)
    const redis = getRedis();
    const targetDataStr = await redis.hGet(`dm:voice:users:${conversationId}`, data.to);
    if (targetDataStr) {
      const targetData: DMVoiceUserState = JSON.parse(targetDataStr);
      console.log(`[DMVoice] Relaying signal from ${userId} to ${data.to}`);
      // io.to(socketId) works across nodes via Redis adapter
      io.to(targetData.socketId).emit('dm:voice:signal', {
        from: userId,
        signal: data.signal,
      });
    }
  });

  // Clean up on disconnect
  socket.on('disconnecting', async () => {
    await leaveCurrentDMVoiceChannel(io, socket, userId);
  });
}
