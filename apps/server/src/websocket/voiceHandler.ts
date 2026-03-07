import type { Server as SocketServer, Socket } from 'socket.io';
import { type ServerToClientEvents, type ClientToServerEvents } from '@voxium/shared';
import type { WebRtcTransport, Producer, Consumer, DtlsParameters, RtpParameters, RtpCapabilities } from 'mediasoup/node/lib/types';
import { prisma } from '../utils/prisma';
import { leaveCurrentDMVoiceChannel } from './dmVoiceHandler';
import { socketRateLimit } from '../middleware/rateLimiter';
import { isFeatureEnabled } from '../utils/featureFlags';
import { getOrCreateRouter, createWebRtcTransport, releaseRouter, releaseServerRouters, getRouter } from '../mediasoup/mediasoupManager';
import { getEffectiveLimits } from '../utils/serverLimits';

// ─── In-memory voice state ──────────────────────────────────────────────────

interface UserMediaState {
  socketId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  sendTransport: WebRtcTransport | null;
  recvTransport: WebRtcTransport | null;
  producers: Map<string, Producer>;   // producerId → Producer
  consumers: Map<string, Consumer>;   // consumerId → Consumer
  rtpCapabilities: RtpCapabilities | null;
}

// channelId → Map<userId, UserMediaState>
const voiceChannelUsers = new Map<string, Map<string, UserMediaState>>();
// channelId → serverId
const channelServerMap = new Map<string, string>();
// channelId → userId (one screen sharer per channel)
const screenSharers = new Map<string, string>();

// ─── Handler Registration ───────────────────────────────────────────────────

export function handleVoiceEvents(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>
) {
  const userId = socket.data.userId as string;

  // ── voice:join ────────────────────────────────────────────────────────
  socket.on('voice:join', async (channelId: string, state?: { selfMute: boolean; selfDeaf: boolean }) => {
    if (!isFeatureEnabled('voice')) {
      socket.emit('voice:error', { message: 'Voice channels are currently disabled' });
      return;
    }
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

    // Enforce max voice users per channel (dynamic limits)
    const existingChannel = voiceChannelUsers.get(channelId);
    const limits = await getEffectiveLimits(channel.serverId);
    if (existingChannel && existingChannel.size >= limits.maxVoiceUsersPerChannel) {
      socket.emit('voice:error', { message: 'Voice channel is full' });
      return;
    }

    // Leave any current DM voice call first (cross-cleanup)
    leaveCurrentDMVoiceChannel(io, socket, userId);
    // Leave any current voice channel first
    leaveCurrentVoiceChannel(io, socket, userId);

    // Join the voice channel room and set voiceChannelId early so that
    // concurrent voice:leave / disconnecting can clean up properly
    socket.join(`voice:${channelId}`);
    socket.data.voiceChannelId = channelId;
    channelServerMap.set(channelId, channel.serverId);

    if (!voiceChannelUsers.has(channelId)) {
      voiceChannelUsers.set(channelId, new Map());
    }

    const initialMute = state?.selfMute ?? false;
    const initialDeaf = state?.selfDeaf ?? false;

    // Create mediasoup transports
    let router;
    try {
      router = await getOrCreateRouter(channelId);
    } catch (err) {
      console.error(`[Voice] Failed to get Router for channel ${channelId}:`, err);
      socket.emit('voice:error', { message: 'Voice server unavailable. Please try again later.' });
      socket.leave(`voice:${channelId}`);
      socket.data.voiceChannelId = undefined;
      return;
    }

    // Bail if user left during async router creation
    if (socket.data.voiceChannelId !== channelId) return;

    let sendTransport: WebRtcTransport;
    let recvTransport: WebRtcTransport;
    try {
      sendTransport = await createWebRtcTransport(router);
      recvTransport = await createWebRtcTransport(router);
    } catch (err) {
      console.error(`[Voice] Failed to create transports for ${userId}:`, err);
      socket.emit('voice:error', { message: 'Failed to create voice connection.' });
      socket.leave(`voice:${channelId}`);
      socket.data.voiceChannelId = undefined;
      return;
    }

    // Bail if user left during async transport creation
    if (socket.data.voiceChannelId !== channelId) {
      sendTransport.close();
      recvTransport.close();
      return;
    }

    const userMedia: UserMediaState = {
      socketId: socket.id,
      selfMute: initialMute,
      selfDeaf: initialDeaf,
      sendTransport,
      recvTransport,
      producers: new Map(),
      consumers: new Map(),
      rtpCapabilities: null,
    };

    voiceChannelUsers.get(channelId)!.set(userId, userMedia);

    // Fetch user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });

    if (user) {
      // Send existing users in the channel to the joiner
      const existingUsers = voiceChannelUsers.get(channelId)!;
      const existingUserIds = Array.from(existingUsers.keys()).filter((id) => id !== userId);

      if (existingUserIds.length > 0) {
        const existingUserInfos = await prisma.user.findMany({
          where: { id: { in: existingUserIds } },
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        });

        const voiceUsers = existingUserInfos.map((u) => {
          const uState = existingUsers.get(u.id);
          return {
            ...u,
            selfMute: uState?.selfMute ?? false,
            selfDeaf: uState?.selfDeaf ?? false,
            speaking: false,
          };
        });

        socket.emit('voice:channel_users', { channelId, users: voiceUsers });
      }

      // Send current screen share state to the joiner
      const currentSharer = screenSharers.get(channelId);
      if (currentSharer) {
        socket.emit('voice:screen_share:state', { channelId, sharingUserId: currentSharer });
      }

      // Broadcast to the ENTIRE SERVER so all members can see who's in voice
      const voiceUser = { ...user, selfMute: initialMute, selfDeaf: initialDeaf, speaking: false };
      io.to(`server:${channel.serverId}`).emit('voice:user_joined', {
        channelId,
        user: voiceUser,
      });

      // Send transport parameters to the joining client
      socket.emit('voice:transport_created', {
        routerRtpCapabilities: router.rtpCapabilities,
        sendTransport: {
          id: sendTransport.id,
          iceParameters: sendTransport.iceParameters,
          iceCandidates: sendTransport.iceCandidates,
          dtlsParameters: sendTransport.dtlsParameters,
        },
        recvTransport: {
          id: recvTransport.id,
          iceParameters: recvTransport.iceParameters,
          iceCandidates: recvTransport.iceCandidates,
          dtlsParameters: recvTransport.dtlsParameters,
        },
      });
    }
  });

  // ── voice:leave ───────────────────────────────────────────────────────
  socket.on('voice:leave', () => {
    console.log(`[Voice] User ${userId} leaving voice channel`);
    leaveCurrentVoiceChannel(io, socket, userId);
  });

  // ── voice:transport:connect ───────────────────────────────────────────
  socket.on('voice:transport:connect', async (data: { transportId: string; dtlsParameters: unknown }) => {
    if (!socketRateLimit(socket, 'voice:transport:connect', 30)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia) return;

    const transport =
      userMedia.sendTransport?.id === data.transportId ? userMedia.sendTransport :
      userMedia.recvTransport?.id === data.transportId ? userMedia.recvTransport :
      null;

    if (!transport) {
      console.warn(`[Voice] Transport ${data.transportId} not found for user ${userId}`);
      return;
    }

    try {
      await transport.connect({ dtlsParameters: data.dtlsParameters as DtlsParameters });
    } catch (err) {
      console.error(`[Voice] transport.connect failed for ${userId}:`, err);
    }
  });

  // ── voice:produce ─────────────────────────────────────────────────────
  socket.on('voice:produce', async (
    data: { kind: 'audio' | 'video'; rtpParameters: unknown; appData?: Record<string, unknown> },
    callback,
  ) => {
    if (!socketRateLimit(socket, 'voice:produce', 20)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia?.sendTransport) return;

    // Cap at 4 producers per user (1 mic audio + 1 screen video + 1 screen audio + 1 spare)
    if (userMedia.producers.size >= 4) {
      console.warn(`[Voice] User ${userId} exceeded max producers`);
      return;
    }

    try {
      const producer = await userMedia.sendTransport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters as RtpParameters,
        appData: { ...data.appData, userId },
      });

      userMedia.producers.set(producer.id, producer);

      // If muted at join, pause the audio producer immediately
      if (data.kind === 'audio' && userMedia.selfMute) {
        producer.pause();
      }

      producer.on('transportclose', () => {
        userMedia.producers.delete(producer.id);
      });

      // ACK the client with the server-side producerId
      if (typeof callback === 'function') {
        callback({ producerId: producer.id });
      }

      // Create Consumers for all other users in the channel (in parallel)
      const channelUsers = voiceChannelUsers.get(channelId);
      if (channelUsers) {
        const consumerPromises: Promise<void>[] = [];
        for (const [otherUserId, otherMedia] of channelUsers.entries()) {
          if (otherUserId === userId) continue;
          if (!otherMedia.recvTransport || !otherMedia.rtpCapabilities) continue;

          consumerPromises.push(createConsumerForUser(io, channelId, otherUserId, otherMedia, producer, userId));
        }
        await Promise.allSettled(consumerPromises);
      }
    } catch (err) {
      console.error(`[Voice] produce failed for ${userId}:`, err);
    }
  });

  // ── voice:rtp_capabilities ────────────────────────────────────────────
  socket.on('voice:rtp_capabilities', async (data: { rtpCapabilities: unknown }) => {
    if (!socketRateLimit(socket, 'voice:rtp_capabilities', 10)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia) return;

    userMedia.rtpCapabilities = data.rtpCapabilities as RtpCapabilities;

    // Now that we know this user's capabilities, create Consumers for
    // all existing Producers in the channel (in parallel)
    const channelUsers = voiceChannelUsers.get(channelId);
    if (!channelUsers) return;

    const consumerPromises: Promise<void>[] = [];
    for (const [otherUserId, otherMedia] of channelUsers.entries()) {
      if (otherUserId === userId) continue;
      for (const producer of otherMedia.producers.values()) {
        consumerPromises.push(createConsumerForUser(io, channelId, userId, userMedia, producer, otherUserId));
      }
    }
    await Promise.allSettled(consumerPromises);
  });

  // ── voice:consumer:resume ─────────────────────────────────────────────
  socket.on('voice:consumer:resume', async (data: { consumerId: string }) => {
    if (!socketRateLimit(socket, 'voice:consumer:resume', 60)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia) return;

    const consumer = userMedia.consumers.get(data.consumerId);
    if (consumer) {
      try {
        await consumer.resume();
      } catch (err) {
        console.error(`[Voice] consumer.resume failed for ${userId}:`, err);
      }
    }
  });

  // ── voice:mute ────────────────────────────────────────────────────────
  socket.on('voice:mute', (muted: boolean) => {
    if (!socketRateLimit(socket, 'voice:mute', 30)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const channelUsers = voiceChannelUsers.get(channelId);
    const userMedia = channelUsers?.get(userId);
    if (userMedia) {
      userMedia.selfMute = muted;

      // Pause/resume the audio Producer on the server to save bandwidth
      for (const producer of userMedia.producers.values()) {
        if (producer.kind === 'audio') {
          if (muted) { producer.pause(); } else { producer.resume(); }
        }
      }
    }

    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:state_update', {
        channelId,
        userId,
        selfMute: muted,
        selfDeaf: userMedia?.selfDeaf ?? false,
      });
    }
  });

  // ── voice:deaf ────────────────────────────────────────────────────────
  socket.on('voice:deaf', (deafened: boolean) => {
    if (!socketRateLimit(socket, 'voice:deaf', 30)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const channelUsers = voiceChannelUsers.get(channelId);
    const userMedia = channelUsers?.get(userId);
    if (userMedia) {
      userMedia.selfDeaf = deafened;
    }

    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:state_update', {
        channelId,
        userId,
        selfMute: userMedia?.selfMute ?? false,
        selfDeaf: deafened,
      });
    }
  });

  // ── voice:speaking ────────────────────────────────────────────────────
  socket.on('voice:speaking', (speaking: boolean) => {
    if (!socketRateLimit(socket, 'voice:speaking', 120)) return;
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

  // ── voice:signal (kept as no-op for backward compat) ──────────────────
  socket.on('voice:signal', () => {
    // No longer used for server voice (SFU replaced P2P signaling).
    // DM voice uses dm:voice:signal, which is handled separately.
  });

  // ── Screen sharing ────────────────────────────────────────────────────
  socket.on('voice:screen_share:start', () => {
    if (!socketRateLimit(socket, 'voice:screen_share', 10)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    // Only one sharer per channel
    if (screenSharers.has(channelId)) return;

    screenSharers.set(channelId, userId);
    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:screen_share:start', { channelId, userId });
    }
  });

  socket.on('voice:screen_share:stop', () => {
    if (!socketRateLimit(socket, 'voice:screen_share', 10)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    // Only the current sharer can stop
    if (screenSharers.get(channelId) !== userId) return;

    screenSharers.delete(channelId);
    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:screen_share:stop', { channelId, userId });
    }
  });

  // ── Disconnect cleanup ────────────────────────────────────────────────
  socket.on('disconnecting', () => {
    leaveCurrentVoiceChannel(io, socket, userId);
  });
}

// ─── Consumer creation helper ───────────────────────────────────────────────

async function createConsumerForUser(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  channelId: string,
  consumerUserId: string,
  consumerMedia: UserMediaState,
  producer: Producer,
  producerUserId: string,
) {
  if (!consumerMedia.recvTransport || !consumerMedia.rtpCapabilities) return;

  // Check if the Router can create a Consumer for this user's RTP capabilities
  const router = getRouter(channelId);
  if (!router) return;

  if (!router.canConsume({ producerId: producer.id, rtpCapabilities: consumerMedia.rtpCapabilities })) {
    console.warn(`[Voice] Cannot create Consumer for ${consumerUserId} (incompatible caps)`);
    return;
  }

  try {
    const consumer = await consumerMedia.recvTransport.consume({
      producerId: producer.id,
      rtpCapabilities: consumerMedia.rtpCapabilities,
      paused: true, // mediasoup convention: create paused, client resumes after setup
    });

    consumerMedia.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      consumerMedia.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      consumerMedia.consumers.delete(consumer.id);
      // Notify the consumer's client that this producer is gone
      const consumerSocket = io.sockets.sockets.get(consumerMedia.socketId);
      if (consumerSocket) {
        consumerSocket.emit('voice:producer_closed', {
          consumerId: consumer.id,
          producerUserId,
        });
      }
    });

    // Send Consumer info to the client
    const consumerSocket = io.sockets.sockets.get(consumerMedia.socketId);
    if (consumerSocket) {
      consumerSocket.emit('voice:new_consumer', {
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerUserId,
        appData: producer.appData as Record<string, unknown>,
      });
    }
  } catch (err) {
    console.error(`[Voice] Failed to create Consumer for ${consumerUserId}:`, err);
  }
}

// ─── Leave / cleanup ────────────────────────────────────────────────────────

export function leaveCurrentVoiceChannel(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  userId: string
) {
  const channelId = socket.data.voiceChannelId as string;
  if (!channelId) return;

  console.log(`[Voice] Removing user ${userId} from channel ${channelId}`);

  const serverId = channelServerMap.get(channelId);

  // Clean up screen share if this user was sharing
  if (screenSharers.get(channelId) === userId) {
    screenSharers.delete(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:screen_share:stop', { channelId, userId });
    }
  }

  // Close mediasoup resources for this user
  const channelUsers = voiceChannelUsers.get(channelId);
  const userMedia = channelUsers?.get(userId);
  if (userMedia) {
    // Close all consumers
    for (const consumer of userMedia.consumers.values()) {
      consumer.close();
    }
    // Close all producers (triggers 'producerclose' on remote consumers)
    for (const producer of userMedia.producers.values()) {
      producer.close();
    }
    // Close transports
    if (userMedia.sendTransport && !userMedia.sendTransport.closed) {
      userMedia.sendTransport.close();
    }
    if (userMedia.recvTransport && !userMedia.recvTransport.closed) {
      userMedia.recvTransport.close();
    }
  }

  if (channelUsers) {
    channelUsers.delete(userId);
    if (channelUsers.size === 0) {
      voiceChannelUsers.delete(channelId);
      channelServerMap.delete(channelId);
      screenSharers.delete(channelId);
      // Release the Router when the last user leaves
      releaseRouter(channelId);
    }
  }

  socket.leave(`voice:${channelId}`);
  socket.data.voiceChannelId = undefined;

  // Broadcast to the entire server so everyone sees the user leave
  if (serverId) {
    io.to(`server:${serverId}`).emit('voice:user_left', { channelId, userId });
  }
}

/**
 * Silently clean up all voice state for a server being deleted.
 */
export function cleanupServerVoice(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  serverId: string
): void {
  const channelIds: string[] = [];
  for (const [channelId, sid] of channelServerMap.entries()) {
    if (sid === serverId) channelIds.push(channelId);
  }

  for (const channelId of channelIds) {
    const users = voiceChannelUsers.get(channelId);
    if (users) {
      for (const [, userMedia] of users.entries()) {
        // Close mediasoup resources
        for (const consumer of userMedia.consumers.values()) consumer.close();
        for (const producer of userMedia.producers.values()) producer.close();
        if (userMedia.sendTransport && !userMedia.sendTransport.closed) userMedia.sendTransport.close();
        if (userMedia.recvTransport && !userMedia.recvTransport.closed) userMedia.recvTransport.close();

        const socket = io.sockets.sockets.get(userMedia.socketId);
        if (socket) {
          socket.leave(`voice:${channelId}`);
          socket.data.voiceChannelId = undefined;
        }
      }
      voiceChannelUsers.delete(channelId);
    }
    screenSharers.delete(channelId);
    channelServerMap.delete(channelId);
  }

  // Release mediasoup Routers for these channels
  releaseServerRouters(channelIds);
}

export function getScreenShareState(channelId: string): string | null {
  return screenSharers.get(channelId) ?? null;
}

export function getVoiceChannelUsers(channelId: string): string[] {
  const users = voiceChannelUsers.get(channelId);
  return users ? Array.from(users.keys()) : [];
}

/** Returns count of active voice channels (channels with at least one user) */
export function getActiveVoiceChannelCount(): number {
  let count = 0;
  for (const users of voiceChannelUsers.values()) {
    if (users.size > 0) count++;
  }
  return count;
}

/** Returns total number of users in all voice channels */
export function getTotalVoiceUsers(): number {
  let count = 0;
  for (const users of voiceChannelUsers.values()) {
    count += users.size;
  }
  return count;
}

/** Returns aggregate counts of mediasoup transports, producers, and consumers across all channels. */
export function getVoiceMediaCounts(): { transports: number; producers: number; consumers: number } {
  let transports = 0;
  let producers = 0;
  let consumers = 0;
  for (const users of voiceChannelUsers.values()) {
    for (const state of users.values()) {
      if (state.sendTransport) transports++;
      if (state.recvTransport) transports++;
      producers += state.producers.size;
      consumers += state.consumers.size;
    }
  }
  return { transports, producers, consumers };
}

/** Returns transport count per channelId (for per-worker aggregation). */
export function getTransportCountsByChannel(): Map<string, number> {
  const result = new Map<string, number>();
  for (const [channelId, users] of voiceChannelUsers) {
    let count = 0;
    for (const state of users.values()) {
      if (state.sendTransport) count++;
      if (state.recvTransport) count++;
    }
    if (count > 0) result.set(channelId, count);
  }
  return result;
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
