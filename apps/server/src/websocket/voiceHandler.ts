import type { Server as SocketServer, Socket } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { prisma } from '../utils/prisma';

// In-memory voice state tracking
const voiceChannelUsers = new Map<string, Map<string, { socketId: string; selfMute: boolean; selfDeaf: boolean }>>();
// Track which server each voice channel belongs to
const channelServerMap = new Map<string, string>();

export function handleVoiceEvents(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>
) {
  const userId = socket.data.userId as string;

  socket.on('voice:join', async (channelId: string, state?: { selfMute: boolean; selfDeaf: boolean }) => {
    console.log(`[Voice] User ${userId} requesting to join channel ${channelId}`);

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true, type: true },
    });

    if (!channel || channel.type !== 'voice') {
      console.log(`[Voice] Channel ${channelId} not found or not voice type`);
      return;
    }

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId: channel.serverId } },
    });
    if (!membership) {
      console.log(`[Voice] User ${userId} not a member of server`);
      return;
    }

    // Leave any current voice channel first
    leaveCurrentVoiceChannel(io, socket, userId);

    // Join the voice channel room
    socket.join(`voice:${channelId}`);
    channelServerMap.set(channelId, channel.serverId);

    if (!voiceChannelUsers.has(channelId)) {
      voiceChannelUsers.set(channelId, new Map());
    }

    const initialMute = state?.selfMute ?? false;
    const initialDeaf = state?.selfDeaf ?? false;

    voiceChannelUsers.get(channelId)!.set(userId, {
      socketId: socket.id,
      selfMute: initialMute,
      selfDeaf: initialDeaf,
    });

    socket.data.voiceChannelId = channelId;

    // Fetch user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });

    if (user) {
      // Send existing users in the channel to the joiner
      const existingUsers = voiceChannelUsers.get(channelId)!;
      const existingUserIds = Array.from(existingUsers.keys()).filter((id) => id !== userId);

      console.log(`[Voice] Channel ${channelId} has ${existingUserIds.length} existing users`);

      if (existingUserIds.length > 0) {
        const existingUserInfos = await prisma.user.findMany({
          where: { id: { in: existingUserIds } },
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        });

        const voiceUsers = existingUserInfos.map((u) => {
          const userState = existingUsers.get(u.id);
          return {
            ...u,
            selfMute: userState?.selfMute ?? false,
            selfDeaf: userState?.selfDeaf ?? false,
            speaking: false,
          };
        });

        console.log(`[Voice] Sending ${voiceUsers.length} existing users to joiner ${userId}`);
        socket.emit('voice:channel_users', { channelId, users: voiceUsers });
      }

      // Broadcast to the ENTIRE SERVER so all members can see who's in voice
      const voiceUser = { ...user, selfMute: initialMute, selfDeaf: initialDeaf, speaking: false };
      console.log(`[Voice] Broadcasting user_joined to server:${channel.serverId}`);
      io.to(`server:${channel.serverId}`).emit('voice:user_joined', {
        channelId,
        user: voiceUser,
      });
    }
  });

  socket.on('voice:leave', () => {
    console.log(`[Voice] User ${userId} leaving voice channel`);
    leaveCurrentVoiceChannel(io, socket, userId);
  });

  socket.on('voice:mute', (muted: boolean) => {
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const channelUsers = voiceChannelUsers.get(channelId);
    const userState = channelUsers?.get(userId);
    if (userState) {
      userState.selfMute = muted;
    }

    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:state_update', {
        channelId,
        userId,
        selfMute: muted,
        selfDeaf: userState?.selfDeaf ?? false,
      });
    }
  });

  socket.on('voice:deaf', (deafened: boolean) => {
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const channelUsers = voiceChannelUsers.get(channelId);
    const userState = channelUsers?.get(userId);
    if (userState) {
      userState.selfDeaf = deafened;
    }

    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:state_update', {
        channelId,
        userId,
        selfMute: userState?.selfMute ?? false,
        selfDeaf: deafened,
      });
    }
  });

  socket.on('voice:speaking', (speaking: boolean) => {
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:speaking', {
        channelId,
        userId,
        speaking,
      });
    }
  });

  // WebRTC signaling relay
  socket.on('voice:signal', (data: { to: string; signal: unknown }) => {
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const targetState = voiceChannelUsers.get(channelId)?.get(data.to);
    if (targetState) {
      console.log(`[Voice] Relaying signal from ${userId} to ${data.to}`);
      io.to(targetState.socketId).emit('voice:signal', {
        from: userId,
        signal: data.signal,
      });
    } else {
      console.log(`[Voice] Signal target ${data.to} not found in channel ${channelId}`);
    }
  });

  // Clean up on disconnecting (fires while socket is still in rooms, unlike 'disconnect')
  socket.on('disconnecting', () => {
    leaveCurrentVoiceChannel(io, socket, userId);
  });
}

function leaveCurrentVoiceChannel(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  userId: string
) {
  const channelId = socket.data.voiceChannelId as string;
  if (!channelId) return;

  console.log(`[Voice] Removing user ${userId} from channel ${channelId}`);

  const serverId = channelServerMap.get(channelId);

  const channelUsers = voiceChannelUsers.get(channelId);
  if (channelUsers) {
    channelUsers.delete(userId);
    if (channelUsers.size === 0) {
      voiceChannelUsers.delete(channelId);
    }
  }

  socket.leave(`voice:${channelId}`);
  socket.data.voiceChannelId = undefined;

  // Broadcast to the entire server so everyone sees the user leave
  if (serverId) {
    io.to(`server:${serverId}`).emit('voice:user_left', { channelId, userId });
  }
}

export function getVoiceChannelUsers(channelId: string): string[] {
  const users = voiceChannelUsers.get(channelId);
  return users ? Array.from(users.keys()) : [];
}

/** Returns all channelIds that belong to a given server and have active voice users */
export function getVoiceStateForServer(serverId: string): { channelId: string; userIds: string[]; userStates: Map<string, { selfMute: boolean; selfDeaf: boolean }> }[] {
  const result: { channelId: string; userIds: string[]; userStates: Map<string, { selfMute: boolean; selfDeaf: boolean }> }[] = [];
  for (const [channelId, serverIdForChannel] of channelServerMap.entries()) {
    if (serverIdForChannel === serverId) {
      const users = voiceChannelUsers.get(channelId);
      if (users && users.size > 0) {
        const userStates = new Map<string, { selfMute: boolean; selfDeaf: boolean }>();
        for (const [uid, state] of users.entries()) {
          userStates.set(uid, { selfMute: state.selfMute, selfDeaf: state.selfDeaf });
        }
        result.push({ channelId, userIds: Array.from(users.keys()), userStates });
      }
    }
  }
  return result;
}
