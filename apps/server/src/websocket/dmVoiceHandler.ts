import type { Server as SocketServer, Socket } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, Message } from '@voxium/shared';
import { prisma } from '../utils/prisma';
import { leaveCurrentVoiceChannel } from './voiceHandler';
import { socketRateLimit } from '../middleware/rateLimiter';

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

// conversationId -> Map<userId, { socketId, selfMute, selfDeaf }>
const dmVoiceUsers = new Map<string, Map<string, { socketId: string; selfMute: boolean; selfDeaf: boolean }>>();

// userId -> conversationId (quick lookup for cleanup)
const userDMCall = new Map<string, string>();

// conversationId -> timeout (auto-cancel unanswered calls after 30s)
const DM_CALL_TIMEOUT_MS = 30_000;
const dmCallTimeouts = new Map<string, NodeJS.Timeout>();

function clearCallTimeout(conversationId: string) {
  const timeout = dmCallTimeouts.get(conversationId);
  if (timeout) {
    clearTimeout(timeout);
    dmCallTimeouts.delete(conversationId);
  }
}

export function leaveCurrentDMVoiceChannel(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  userId: string
) {
  const conversationId = userDMCall.get(userId);
  if (!conversationId) return;

  console.log(`[DMVoice] Removing user ${userId} from DM call ${conversationId}`);

  const callUsers = dmVoiceUsers.get(conversationId);

  // Collect remaining users and their socketIds BEFORE removing the leaving user
  const remainingUsers: Array<{ id: string; socketId: string }> = [];
  if (callUsers) {
    for (const [uid, state] of callUsers.entries()) {
      if (uid !== userId) remainingUsers.push({ id: uid, socketId: state.socketId });
    }
    callUsers.delete(userId);
    if (callUsers.size === 0) {
      dmVoiceUsers.delete(conversationId);
    }
  }

  userDMCall.delete(userId);
  socket.leave(`dm:voice:${conversationId}`);

  // DM calls are 1-on-1: always end the call when someone leaves
  // Clean up remaining users' server state and socket rooms so they don't get stuck
  for (const remaining of remainingUsers) {
    if (callUsers) callUsers.delete(remaining.id);
    userDMCall.delete(remaining.id);
    // Remove remaining user's socket from the voice room
    const remainingSocket = io.sockets.sockets.get(remaining.socketId);
    if (remainingSocket) {
      remainingSocket.leave(`dm:voice:${conversationId}`);
    }
  }
  if (callUsers && callUsers.size === 0) {
    dmVoiceUsers.delete(conversationId);
  }

  // Clear any pending call timeout
  clearCallTimeout(conversationId);

  // Emit left then ended — all clients should tear down
  io.to(`dm:${conversationId}`).emit('dm:voice:left', { conversationId, userId });
  io.to(`dm:${conversationId}`).emit('dm:voice:ended', { conversationId });

  // Persist "call ended" system message
  createSystemMessage(io, conversationId, userId, 'Voice call ended');
}

export function handleDMVoiceEvents(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>
) {
  const userId = socket.data.userId as string;

  socket.on('dm:voice:join', async (conversationId: string, state?: { selfMute: boolean; selfDeaf: boolean }) => {
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
    leaveCurrentDMVoiceChannel(io, socket, userId);

    // Join the DM voice room
    socket.join(`dm:voice:${conversationId}`);

    if (!dmVoiceUsers.has(conversationId)) {
      dmVoiceUsers.set(conversationId, new Map());
    }

    const initialMute = state?.selfMute ?? false;
    const initialDeaf = state?.selfDeaf ?? false;

    dmVoiceUsers.get(conversationId)!.set(userId, {
      socketId: socket.id,
      selfMute: initialMute,
      selfDeaf: initialDeaf,
    });
    userDMCall.set(userId, conversationId);

    // Fetch user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });

    if (!user) return;

    const voiceUser = { ...user, selfMute: initialMute, selfDeaf: initialDeaf, speaking: false };
    const callUsers = dmVoiceUsers.get(conversationId)!;

    if (callUsers.size === 1) {
      // First user in the call — send offer/ring to the DM room AND joined so caller appears in own dmCallUsers
      io.to(`dm:${conversationId}`).emit('dm:voice:offer', { conversationId, from: voiceUser });
      socket.emit('dm:voice:joined', { conversationId, user: voiceUser });

      // Persist "call started" system message
      createSystemMessage(io, conversationId, userId, 'Voice call started');

      // Start call timeout — auto-cancel if no one answers within 30s
      clearCallTimeout(conversationId);
      dmCallTimeouts.set(conversationId, setTimeout(() => {
        dmCallTimeouts.delete(conversationId);
        console.log(`[DMVoice] Call timeout for conversation ${conversationId}`);
        leaveCurrentDMVoiceChannel(io, socket, userId);
      }, DM_CALL_TIMEOUT_MS));
    } else {
      // Second user joined — clear the call timeout
      clearCallTimeout(conversationId);
      // Second user joined — notify the room
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

  socket.on('dm:voice:leave', (conversationId: string) => {
    console.log(`[DMVoice] User ${userId} leaving DM call ${conversationId}`);
    leaveCurrentDMVoiceChannel(io, socket, userId);
  });

  socket.on('dm:voice:decline', (conversationId: string) => {
    console.log(`[DMVoice] User ${userId} declined DM call ${conversationId}`);

    // Find the caller in this conversation and end the call
    const callUsers = dmVoiceUsers.get(conversationId);
    if (!callUsers) return;

    // End the call for all participants (the solo caller)
    const callerIds = Array.from(callUsers.keys());
    for (const callerId of callerIds) {
      const callerState = callUsers.get(callerId);
      if (callerState) {
        const callerSocket = io.sockets.sockets.get(callerState.socketId);
        if (callerSocket) {
          leaveCurrentDMVoiceChannel(io, callerSocket, callerId);
          break; // 1-on-1 call, only one caller
        }
      }
    }
  });

  socket.on('dm:voice:mute', (muted: boolean) => {
    const conversationId = userDMCall.get(userId);
    if (!conversationId) return;

    const callUsers = dmVoiceUsers.get(conversationId);
    const userState = callUsers?.get(userId);
    if (userState) {
      userState.selfMute = muted;
    }

    io.to(`dm:${conversationId}`).emit('dm:voice:state_update', {
      conversationId,
      userId,
      selfMute: muted,
      selfDeaf: userState?.selfDeaf ?? false,
    });
  });

  socket.on('dm:voice:deaf', (deafened: boolean) => {
    const conversationId = userDMCall.get(userId);
    if (!conversationId) return;

    const callUsers = dmVoiceUsers.get(conversationId);
    const userState = callUsers?.get(userId);
    if (userState) {
      userState.selfDeaf = deafened;
    }

    io.to(`dm:${conversationId}`).emit('dm:voice:state_update', {
      conversationId,
      userId,
      selfMute: userState?.selfMute ?? false,
      selfDeaf: deafened,
    });
  });

  socket.on('dm:voice:speaking', (speaking: boolean) => {
    const conversationId = userDMCall.get(userId);
    if (!conversationId) return;

    io.to(`dm:${conversationId}`).emit('dm:voice:speaking', {
      conversationId,
      userId,
      speaking,
    });
  });

  socket.on('dm:voice:signal', (data: { to: string; signal: unknown }) => {
    if (!socketRateLimit(socket, 'dm:voice:signal', 300)) return;
    const conversationId = userDMCall.get(userId);
    if (!conversationId) return;

    const targetState = dmVoiceUsers.get(conversationId)?.get(data.to);
    if (targetState) {
      console.log(`[DMVoice] Relaying signal from ${userId} to ${data.to}`);
      io.to(targetState.socketId).emit('dm:voice:signal', {
        from: userId,
        signal: data.signal,
      });
    }
  });

  // Clean up on disconnect
  socket.on('disconnecting', () => {
    leaveCurrentDMVoiceChannel(io, socket, userId);
  });
}
