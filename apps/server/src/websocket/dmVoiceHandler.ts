import type { Server as SocketServer, Socket } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, Message } from '@voxium/shared';
import { prisma } from '../utils/prisma';
import { leaveCurrentVoiceChannel } from './voiceHandler';
import { socketRateLimit } from '../middleware/rateLimiter';
import { isFeatureEnabled } from '../utils/featureFlags';
import { getRedis } from '../utils/redis';

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
  const redis = getRedis();
  await redis.multi()
    .hSet(`dm:voice:users:${conversationId}`, userId, JSON.stringify(state))
    .set(`dm:voice:call:${userId}`, conversationId)
    .sAdd('dm:voice:active', conversationId)
    .exec();
}

async function removeDMVoiceUser(conversationId: string, userId: string): Promise<void> {
  const redis = getRedis();
  await redis.multi()
    .hDel(`dm:voice:users:${conversationId}`, userId)
    .del(`dm:voice:call:${userId}`)
    .exec();
  // Clean up empty hash + active set (separate call to check remaining)
  const remaining = await redis.hLen(`dm:voice:users:${conversationId}`);
  if (remaining === 0) {
    await redis.multi()
      .del(`dm:voice:users:${conversationId}`)
      .sRem('dm:voice:active', conversationId)
      .exec();
  }
}

async function getUserDMCall(userId: string): Promise<string | null> {
  return await getRedis().get(`dm:voice:call:${userId}`);
}

// ─── Leave / cleanup ──────────────────────────────────────────────────────────

export async function leaveCurrentDMVoiceChannel(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  userId: string
) {
  const conversationId = await getUserDMCall(userId);
  if (!conversationId) return;

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

  // DM calls are 1-on-1: always end the call when someone leaves
  // Clean up remaining users' state and socket rooms
  for (const remaining of remainingUsers) {
    await removeDMVoiceUser(conversationId, remaining.id);
    // fetchSockets works across nodes via Redis adapter
    const sockets = await io.in(`user:${remaining.id}`).fetchSockets();
    for (const s of sockets) s.leave(`dm:voice:${conversationId}`);
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

  socket.on('dm:voice:join', async (conversationId: string, state?: { selfMute: boolean; selfDeaf: boolean }) => {
    if (!socketRateLimit(socket, 'dm:voice:join', 10)) return;
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

    // Leave any current server voice channel first
    leaveCurrentVoiceChannel(io, socket, userId);

    // Leave any existing DM call
    await leaveCurrentDMVoiceChannel(io, socket, userId);

    // Join the DM voice room
    socket.join(`dm:voice:${conversationId}`);
    socket.data.dmCallConversationId = conversationId;

    const initialMute = state?.selfMute ?? false;
    const initialDeaf = state?.selfDeaf ?? false;

    await addDMVoiceUser(conversationId, userId, {
      socketId: socket.id,
      selfMute: initialMute,
      selfDeaf: initialDeaf,
    });

    // Fetch user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });

    if (!user) return;

    const voiceUser = { ...user, selfMute: initialMute, selfDeaf: initialDeaf, speaking: false };
    const callUsers = await getDMVoiceUsers(conversationId);

    if (callUsers.size === 1) {
      // First user in the call — send offer/ring to the DM room AND joined so caller appears in own dmCallUsers
      io.to(`dm:${conversationId}`).emit('dm:voice:offer', { conversationId, from: voiceUser });
      socket.emit('dm:voice:joined', { conversationId, user: voiceUser });

      // Persist "call started" system message
      createSystemMessage(io, conversationId, userId, 'Voice call started');

      // Start call timeout — auto-cancel if no one answers within 30s
      clearCallTimeout(conversationId);
      dmCallTimeouts.set(conversationId, setTimeout(async () => {
        dmCallTimeouts.delete(conversationId);
        // Check Redis — call may have been answered on another node
        const currentUsers = await getDMVoiceUsers(conversationId);
        if (currentUsers.size <= 1) {
          console.log(`[DMVoice] Call timeout for conversation ${conversationId}`);
          // Clean up all remaining users
          for (const [uid] of currentUsers) {
            await removeDMVoiceUser(conversationId, uid);
            const sockets = await io.in(`user:${uid}`).fetchSockets();
            for (const s of sockets) s.leave(`dm:voice:${conversationId}`);
          }
          io.to(`dm:${conversationId}`).emit('dm:voice:left', { conversationId, userId });
          io.to(`dm:${conversationId}`).emit('dm:voice:ended', { conversationId });
          createSystemMessage(io, conversationId, userId, 'Voice call ended');
        }
      }, DM_CALL_TIMEOUT_MS));
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
          return { ...u, selfMute: uState?.selfMute ?? false, selfDeaf: uState?.selfDeaf ?? false, speaking: false };
        });
        // Send as joined events to the new joiner so they know who's already there
        for (const vu of existingVoiceUsers) {
          socket.emit('dm:voice:joined', { conversationId, user: vu });
        }
      }
    }
  });

  socket.on('dm:voice:leave', async (conversationId: string) => {
    console.log(`[DMVoice] User ${userId} leaving DM call ${conversationId}`);
    await leaveCurrentDMVoiceChannel(io, socket, userId);
  });

  socket.on('dm:voice:decline', async (conversationId: string) => {
    if (!socketRateLimit(socket, 'dm:voice:decline', 10)) return;

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
      // fetchSockets works across nodes via Redis adapter
      const sockets = await io.in(`user:${callerId}`).fetchSockets();
      for (const s of sockets) s.leave(`dm:voice:${conversationId}`);
    }

    clearCallTimeout(conversationId);

    io.to(`dm:${conversationId}`).emit('dm:voice:left', { conversationId, userId: callerIdForMsg });
    io.to(`dm:${conversationId}`).emit('dm:voice:ended', { conversationId });
    createSystemMessage(io, conversationId, callerIdForMsg, 'Voice call ended');
  });

  socket.on('dm:voice:mute', async (muted: boolean) => {
    // Use socket.data for fast local lookup (source of truth is Redis)
    const conversationId = socket.data.dmCallConversationId as string;
    if (!conversationId) return;

    const redis = getRedis();
    const dataStr = await redis.hGet(`dm:voice:users:${conversationId}`, userId);
    if (!dataStr) return;

    const data: DMVoiceUserState = JSON.parse(dataStr);
    data.selfMute = muted;
    await redis.hSet(`dm:voice:users:${conversationId}`, userId, JSON.stringify(data));

    io.to(`dm:${conversationId}`).emit('dm:voice:state_update', {
      conversationId,
      userId,
      selfMute: muted,
      selfDeaf: data.selfDeaf,
    });
  });

  socket.on('dm:voice:deaf', async (deafened: boolean) => {
    const conversationId = socket.data.dmCallConversationId as string;
    if (!conversationId) return;

    const redis = getRedis();
    const dataStr = await redis.hGet(`dm:voice:users:${conversationId}`, userId);
    if (!dataStr) return;

    const data: DMVoiceUserState = JSON.parse(dataStr);
    data.selfDeaf = deafened;
    await redis.hSet(`dm:voice:users:${conversationId}`, userId, JSON.stringify(data));

    io.to(`dm:${conversationId}`).emit('dm:voice:state_update', {
      conversationId,
      userId,
      selfMute: data.selfMute,
      selfDeaf: deafened,
    });
  });

  socket.on('dm:voice:speaking', (speaking: boolean) => {
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
