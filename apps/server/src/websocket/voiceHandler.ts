import type { Server as SocketServer, Socket } from 'socket.io';
import { type ServerToClientEvents, type ClientToServerEvents } from '@voxium/shared';
import type { WebRtcTransport, Producer, Consumer, DtlsParameters, RtpParameters, RtpCapabilities } from 'mediasoup/node/lib/types';
import { prisma } from '../utils/prisma';
import { leaveCurrentDMVoiceChannel } from './dmVoiceHandler';
import { socketRateLimit } from '../middleware/rateLimiter';
import { isFeatureEnabled } from '../utils/featureFlags';
import { getOrCreateRouter, createWebRtcTransport, releaseRouter, releaseServerRouters, getRouter } from '../mediasoup/mediasoupManager';
import { RECV_TRANSPORT_MAX_BITRATE } from '../mediasoup/mediasoupConfig';
import { getEffectiveLimits } from '../utils/serverLimits';
import { getRedis, NODE_ID } from '../utils/redis';
import { hasChannelPermission, hasServerPermission, getHighestRolePosition } from '../utils/permissionCalculator';
import { Permissions } from '@voxium/shared';

/** Runtime type guard — returns false if value is not a non-empty string */
function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ─── In-memory voice state ──────────────────────────────────────────────────
// mediasoup objects (Routers, Transports, Producers, Consumers) are C++ handles
// that MUST stay node-local. The Maps below are authoritative for mediasoup ops.
// Redis mirrors metadata (who's in which channel, mute/deaf, screen share) so
// other nodes can see voice state for stats and initial-state-on-connect.

interface UserMediaState {
  socketId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
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

// ─── Redis metadata mirror ──────────────────────────────────────────────────
// Redis keys:
// voice:channel:users:{channelId}  — Hash: userId → JSON({ selfMute, selfDeaf, nodeId })
// voice:channel:server:{channelId} — String: serverId
// voice:channel:node:{channelId}   — String: nodeId (which node owns the Router)
// voice:user:{userId}              — String: channelId (reverse lookup)
// voice:screen:{channelId}         — String: userId (screen sharer)
// voice:active                     — Set of channelIds with active voice users

function mirrorVoiceJoin(channelId: string, serverId: string, userId: string, selfMute: boolean, selfDeaf: boolean, serverMuted = false, serverDeafened = false): void {
  getRedis().multi()
    .hSet(`voice:channel:users:${channelId}`, userId, JSON.stringify({ selfMute, selfDeaf, serverMuted, serverDeafened, nodeId: NODE_ID() }))
    .set(`voice:channel:server:${channelId}`, serverId)
    .set(`voice:channel:node:${channelId}`, NODE_ID())
    .set(`voice:user:${userId}`, channelId)
    .sAdd('voice:active', channelId)
    .exec().catch((err) => console.warn('[Redis] Voice mirror failed:', err));
}

function mirrorVoiceLeave(channelId: string, userId: string, channelEmpty: boolean): void {
  const redis = getRedis();
  const pipeline = redis.multi()
    .hDel(`voice:channel:users:${channelId}`, userId)
    .del(`voice:user:${userId}`);
  if (channelEmpty) {
    pipeline
      .del(`voice:channel:users:${channelId}`)
      .del(`voice:channel:server:${channelId}`)
      .del(`voice:channel:node:${channelId}`)
      .sRem('voice:active', channelId)
      .del(`voice:screen:${channelId}`);
  }
  pipeline.exec().catch((err) => console.warn('[Redis] Voice mirror failed:', err));
}

function mirrorVoiceStateUpdate(channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean, serverMuted = false, serverDeafened = false): void {
  getRedis().hSet(`voice:channel:users:${channelId}`, userId, JSON.stringify({ selfMute, selfDeaf, serverMuted, serverDeafened, nodeId: NODE_ID() })).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
}

// ─── Persistent server-mute/deafen (survives reconnect) ─────────────────────

async function setServerMutePersist(serverId: string, userId: string, muted: boolean): Promise<void> {
  const redis = getRedis();
  if (muted) {
    await redis.set(`voice:server_muted:${serverId}:${userId}`, '1').catch((err) => console.warn('[Redis] Voice mirror failed:', err));
  } else {
    await redis.del(`voice:server_muted:${serverId}:${userId}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
  }
}

async function setServerDeafenPersist(serverId: string, userId: string, deafened: boolean): Promise<void> {
  const redis = getRedis();
  if (deafened) {
    await redis.set(`voice:server_deafened:${serverId}:${userId}`, '1').catch((err) => console.warn('[Redis] Voice mirror failed:', err));
  } else {
    await redis.del(`voice:server_deafened:${serverId}:${userId}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
  }
}

async function getPersistedServerMuteDeaf(serverId: string, userId: string): Promise<{ serverMuted: boolean; serverDeafened: boolean }> {
  const redis = getRedis();
  const [muted, deafened] = await Promise.all([
    redis.get(`voice:server_muted:${serverId}:${userId}`),
    redis.get(`voice:server_deafened:${serverId}:${userId}`),
  ]);
  return { serverMuted: muted === '1', serverDeafened: deafened === '1' };
}

function mirrorScreenShare(channelId: string, userId: string | null): void {
  const redis = getRedis();
  if (userId) {
    redis.set(`voice:screen:${channelId}`, userId).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
  } else {
    redis.del(`voice:screen:${channelId}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
  }
}

// ─── Handler Registration ───────────────────────────────────────────────────

export function handleVoiceEvents(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>
) {
  const userId = socket.data.userId as string;

  // ── voice:join ────────────────────────────────────────────────────────
  socket.on('voice:join', async (channelId: string, state?: { selfMute: boolean; selfDeaf: boolean }) => {
    if (!socketRateLimit(socket, 'voice:join', 10)) return;
    if (!isString(channelId)) return;
    if (!isFeatureEnabled('voice')) {
      socket.emit('voice:error', { message: 'Voice channels are currently disabled' });
      return;
    }
    console.log(`[Voice] User ${userId} requesting to join channel ${channelId}`);

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true, type: true },
    });

    const VOICE_CAPABLE_TYPES = ['voice', 'canvas', 'code'];
    if (!channel || !VOICE_CAPABLE_TYPES.includes(channel.type)) {
      console.log(`[Voice] Channel ${channelId} not found or not voice-capable type`);
      socket.emit('voice:error', { message: 'Voice channel not found.' });
      return;
    }

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId: channel.serverId } },
    });
    if (!membership) {
      console.log(`[Voice] User ${userId} not a member of server`);
      socket.emit('voice:error', { message: 'You are not a member of this server.' });
      return;
    }

    // Check CONNECT permission for this voice channel
    const canConnect = await hasChannelPermission(userId, channelId, channel.serverId, Permissions.CONNECT);
    if (!canConnect) {
      socket.emit('voice:error', { message: 'You do not have permission to join this voice channel.' });
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
    await leaveCurrentDMVoiceChannel(io, socket, userId);
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
      // Cap downstream bandwidth per consumer for fair distribution
      await recvTransport.setMaxOutgoingBitrate(RECV_TRANSPORT_MAX_BITRATE);
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
      serverMuted: false,
      serverDeafened: false,
      sendTransport,
      recvTransport,
      producers: new Map(),
      consumers: new Map(),
      rtpCapabilities: null,
    };

    voiceChannelUsers.get(channelId)!.set(userId, userMedia);

    // Re-apply persisted server-mute/deafen (survives disconnect+rejoin)
    const persisted = await getPersistedServerMuteDeaf(channel.serverId, userId);
    if (persisted.serverMuted) {
      userMedia.serverMuted = true;
      userMedia.selfMute = true; // deafen-implies-mute
    }
    if (persisted.serverDeafened) {
      userMedia.serverDeafened = true;
      userMedia.serverMuted = true; // deafen-implies-mute
      userMedia.selfMute = true;
      userMedia.selfDeaf = true;
    }

    // Mirror to Redis for cross-node visibility
    mirrorVoiceJoin(channelId, channel.serverId, userId, userMedia.selfMute, userMedia.selfDeaf, userMedia.serverMuted, userMedia.serverDeafened);

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
            serverMuted: uState?.serverMuted ?? false,
            serverDeafened: uState?.serverDeafened ?? false,
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
      const voiceUser = { ...user, selfMute: userMedia.selfMute, selfDeaf: userMedia.selfDeaf, serverMuted: userMedia.serverMuted, serverDeafened: userMedia.serverDeafened, speaking: false };
      io.to(`server:${channel.serverId}`).emit('voice:user_joined', {
        channelId,
        user: voiceUser,
      });

      // If server-muted/deafened (persisted), notify the joining user so their UI updates
      if (userMedia.serverMuted || userMedia.serverDeafened) {
        socket.emit('voice:state_update', {
          channelId,
          userId,
          selfMute: userMedia.selfMute,
          selfDeaf: userMedia.selfDeaf,
          serverMuted: userMedia.serverMuted,
          serverDeafened: userMedia.serverDeafened,
        });
      }

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
    if (!socketRateLimit(socket, 'voice:leave', 30)) return;
    console.log(`[Voice] User ${userId} leaving voice channel`);
    leaveCurrentVoiceChannel(io, socket, userId);
  });

  // ── voice:transport:connect ───────────────────────────────────────────
  socket.on('voice:transport:connect', async (data: { transportId: string; dtlsParameters: unknown }, ackCallback) => {
    if (!socketRateLimit(socket, 'voice:transport:connect', 30)) {
      if (typeof ackCallback === 'function') ackCallback({ error: 'Rate limited' });
      return;
    }
    if (!data || typeof data !== 'object' || !isString(data.transportId) || !data.dtlsParameters || typeof data.dtlsParameters !== 'object') {
      if (typeof ackCallback === 'function') ackCallback({ error: 'Invalid parameters' });
      return;
    }
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) {
      if (typeof ackCallback === 'function') ackCallback({ error: 'Not in a voice channel' });
      return;
    }

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia) {
      if (typeof ackCallback === 'function') ackCallback({ error: 'Voice state not found' });
      return;
    }

    const transport =
      userMedia.sendTransport?.id === data.transportId ? userMedia.sendTransport :
      userMedia.recvTransport?.id === data.transportId ? userMedia.recvTransport :
      null;

    if (!transport) {
      console.warn(`[Voice] Transport ${data.transportId} not found for user ${userId}`);
      if (typeof ackCallback === 'function') ackCallback({ error: 'Transport not found' });
      return;
    }

    try {
      await transport.connect({ dtlsParameters: data.dtlsParameters as DtlsParameters });
      if (typeof ackCallback === 'function') ackCallback({});
    } catch (err) {
      console.error(`[Voice] transport.connect failed for ${userId}:`, err);
      if (typeof ackCallback === 'function') ackCallback({ error: 'DTLS connect failed' });
    }
  });

  // ── voice:produce ─────────────────────────────────────────────────────
  socket.on('voice:produce', async (
    data: { kind: 'audio' | 'video'; rtpParameters: unknown; appData?: Record<string, unknown> },
    callback,
  ) => {
    if (!socketRateLimit(socket, 'voice:produce', 20)) return;
    if (!data || typeof data !== 'object' || (data.kind !== 'audio' && data.kind !== 'video') || !data.rtpParameters || typeof data.rtpParameters !== 'object') return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia?.sendTransport) return;

    // Check SPEAK permission for audio producers (screen-share audio/video are separate)
    if (data.kind === 'audio' && (!data.appData || data.appData.type !== 'screen-audio')) {
      const serverId = channelServerMap.get(channelId);
      if (serverId) {
        const canSpeak = await hasChannelPermission(userId, channelId, serverId, Permissions.SPEAK);
        if (!canSpeak) return;
      }
    }

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

      // If muted (self or server) at join, pause the audio producer immediately
      if (data.kind === 'audio' && (userMedia.selfMute || userMedia.serverMuted)) {
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
        const results = await Promise.allSettled(consumerPromises);

        // Retry once for transient failures (consumer creation can fail due to timing)
        const retryTargets = [...channelUsers.entries()].filter(([uid]) => uid !== userId);
        const retryPromises: Promise<void>[] = [];
        results.forEach((result, i) => {
          if (result.status === 'rejected' && retryTargets[i]) {
            const [otherUserId, otherMedia] = retryTargets[i];
            if (otherMedia.recvTransport && otherMedia.rtpCapabilities && !otherMedia.recvTransport.closed) {
              console.warn(`[Voice] Retrying consumer creation for ${otherUserId}`);
              retryPromises.push(createConsumerForUser(io, channelId, otherUserId, otherMedia, producer, userId));
            }
          }
        });
        if (retryPromises.length > 0) {
          await Promise.allSettled(retryPromises);
        }
      }
    } catch (err) {
      console.error(`[Voice] produce failed for ${userId}:`, err);
    }
  });

  // ── voice:rtp_capabilities ────────────────────────────────────────────
  socket.on('voice:rtp_capabilities', async (data: { rtpCapabilities: unknown }) => {
    if (!socketRateLimit(socket, 'voice:rtp_capabilities', 10)) return;
    if (!data || typeof data !== 'object' || !data.rtpCapabilities || typeof data.rtpCapabilities !== 'object') return;
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
    if (!data || typeof data !== 'object' || !isString(data.consumerId)) return;
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

  /** Helper: emit full voice:state_update for a user */
  function emitStateUpdate(channelId: string, uid: string, media: UserMediaState) {
    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:state_update', {
        channelId,
        userId: uid,
        selfMute: media.selfMute,
        selfDeaf: media.selfDeaf,
        serverMuted: media.serverMuted,
        serverDeafened: media.serverDeafened,
      });
    }
  }

  /** Helper: pause all audio producers for a user */
  function pauseUserAudio(media: UserMediaState) {
    for (const producer of media.producers.values()) {
      if (producer.kind === 'audio') producer.pause();
    }
  }

  /** Helper: resume audio producers (only if neither selfMute nor serverMuted) */
  function resumeUserAudioIfAllowed(media: UserMediaState) {
    if (media.selfMute || media.serverMuted) return;
    for (const producer of media.producers.values()) {
      if (producer.kind === 'audio') producer.resume();
    }
  }

  // ── voice:mute ────────────────────────────────────────────────────────
  socket.on('voice:mute', (muted: boolean) => {
    if (!socketRateLimit(socket, 'voice:mute', 30)) return;
    if (typeof muted !== 'boolean') return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia) return;

    // If server-muted, user cannot unmute themselves
    if (!muted && userMedia.serverMuted) return;

    userMedia.selfMute = muted;

    if (muted) {
      pauseUserAudio(userMedia);
    } else {
      resumeUserAudioIfAllowed(userMedia);
    }

    mirrorVoiceStateUpdate(channelId, userId, userMedia.selfMute, userMedia.selfDeaf, userMedia.serverMuted, userMedia.serverDeafened);
    emitStateUpdate(channelId, userId, userMedia);
  });

  // ── voice:deaf ────────────────────────────────────────────────────────
  socket.on('voice:deaf', (deafened: boolean) => {
    if (!socketRateLimit(socket, 'voice:deaf', 30)) return;
    if (typeof deafened !== 'boolean') return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia) return;

    // If server-deafened, user cannot undeafen themselves
    if (!deafened && userMedia.serverDeafened) return;

    userMedia.selfDeaf = deafened;

    // Deafen implies mute — if deafening, also mute
    if (deafened && !userMedia.selfMute) {
      userMedia.selfMute = true;
      pauseUserAudio(userMedia);
    }

    mirrorVoiceStateUpdate(channelId, userId, userMedia.selfMute, userMedia.selfDeaf, userMedia.serverMuted, userMedia.serverDeafened);
    emitStateUpdate(channelId, userId, userMedia);
  });

  // ── voice:speaking ────────────────────────────────────────────────────
  socket.on('voice:speaking', (speaking: boolean) => {
    if (!socketRateLimit(socket, 'voice:speaking', 120)) return;
    if (typeof speaking !== 'boolean') return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    // Only control producers if not self-muted AND not server-muted
    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (userMedia && !userMedia.selfMute && !userMedia.serverMuted) {
      for (const producer of userMedia.producers.values()) {
        if (producer.kind === 'audio' && (producer.appData as Record<string, unknown>)?.type === 'audio') {
          if (speaking) { producer.resume(); } else { producer.pause(); }
        }
      }
    }

    // Don't broadcast speaking indicator if server-muted (prevents UI deception by modified clients)
    if (userMedia?.serverMuted) return;

    const serverId = channelServerMap.get(channelId);
    if (serverId) {
      io.to(`server:${serverId}`).emit('voice:speaking', { channelId, userId, speaking });
    }
  });

  // ── voice:server_mute (force-mute another user) ────────────────────────
  socket.on('voice:server_mute', async (data: unknown) => {
    if (!socketRateLimit(socket, 'voice:server_mute', 20)) return;
    if (!data || typeof data !== 'object') return;
    const { userId: targetId, muted } = data as { userId: string; muted: boolean };
    if (typeof targetId !== 'string' || typeof muted !== 'boolean') return;

    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;
    const serverId = channelServerMap.get(channelId);
    if (!serverId) return;

    // Permission check: MUTE_MEMBERS
    const canMute = await hasChannelPermission(userId, channelId, serverId, Permissions.MUTE_MEMBERS);
    if (!canMute) {
      socket.emit('voice:error', { message: 'You do not have permission to mute members.' });
      return;
    }

    // Hierarchy check: can't mute users with equal/higher role
    const actorHighest = await getHighestRolePosition(userId, serverId);
    const targetHighest = await getHighestRolePosition(targetId, serverId);
    if (actorHighest !== Infinity && targetHighest >= actorHighest) {
      socket.emit('voice:error', { message: 'Cannot mute a member with an equal or higher role.' });
      return;
    }

    const targetMedia = voiceChannelUsers.get(channelId)?.get(targetId);
    if (!targetMedia) return;

    targetMedia.serverMuted = muted;
    setServerMutePersist(serverId, targetId, muted);

    if (muted) {
      pauseUserAudio(targetMedia);
    } else {
      resumeUserAudioIfAllowed(targetMedia);
    }

    mirrorVoiceStateUpdate(channelId, targetId, targetMedia.selfMute, targetMedia.selfDeaf, targetMedia.serverMuted, targetMedia.serverDeafened);
    emitStateUpdate(channelId, targetId, targetMedia);
  });

  // ── voice:server_deafen (force-deafen another user) ────────────────────
  socket.on('voice:server_deafen', async (data: unknown) => {
    if (!socketRateLimit(socket, 'voice:server_deafen', 20)) return;
    if (!data || typeof data !== 'object') return;
    const { userId: targetId, deafened } = data as { userId: string; deafened: boolean };
    if (typeof targetId !== 'string' || typeof deafened !== 'boolean') return;

    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;
    const serverId = channelServerMap.get(channelId);
    if (!serverId) return;

    // Permission check: DEAFEN_MEMBERS
    const canDeafen = await hasChannelPermission(userId, channelId, serverId, Permissions.DEAFEN_MEMBERS);
    if (!canDeafen) {
      socket.emit('voice:error', { message: 'You do not have permission to deafen members.' });
      return;
    }

    const actorHighest = await getHighestRolePosition(userId, serverId);
    const targetHighest = await getHighestRolePosition(targetId, serverId);
    if (actorHighest !== Infinity && targetHighest >= actorHighest) {
      socket.emit('voice:error', { message: 'Cannot deafen a member with an equal or higher role.' });
      return;
    }

    const targetMedia = voiceChannelUsers.get(channelId)?.get(targetId);
    if (!targetMedia) return;

    targetMedia.serverDeafened = deafened;
    setServerDeafenPersist(serverId, targetId, deafened);

    // Deafen implies mute — if deafening, also server-mute
    if (deafened && !targetMedia.serverMuted) {
      targetMedia.serverMuted = true;
      setServerMutePersist(serverId, targetId, true);
      pauseUserAudio(targetMedia);
    }

    mirrorVoiceStateUpdate(channelId, targetId, targetMedia.selfMute, targetMedia.selfDeaf, targetMedia.serverMuted, targetMedia.serverDeafened);
    emitStateUpdate(channelId, targetId, targetMedia);
  });

  // ── voice:force_move (move another user to a different voice channel) ──
  // Supports cross-channel: actor does NOT need to be in the same channel as target.
  socket.on('voice:force_move', async (data: unknown) => {
    if (!socketRateLimit(socket, 'voice:force_move', 10)) return;
    if (!data || typeof data !== 'object') return;
    const { userId: targetId, targetChannelId } = data as { userId: string; targetChannelId: string };
    if (typeof targetId !== 'string' || typeof targetChannelId !== 'string') return;

    // Find which channel the target is in (search all voice channels)
    let sourceChannelId: string | null = null;
    let targetMedia: UserMediaState | undefined;
    for (const [chId, users] of voiceChannelUsers) {
      const media = users.get(targetId);
      if (media) {
        sourceChannelId = chId;
        targetMedia = media;
        break;
      }
    }
    if (!sourceChannelId || !targetMedia) {
      socket.emit('voice:error', { message: 'User is not in a voice channel.' });
      return;
    }

    const serverId = channelServerMap.get(sourceChannelId);
    if (!serverId) return;

    // Permission check: MOVE_MEMBERS (check against server-level permission)
    const canMove = await hasServerPermission(userId, serverId, Permissions.MOVE_MEMBERS);
    if (!canMove) {
      socket.emit('voice:error', { message: 'You do not have permission to move members.' });
      return;
    }

    const actorHighest = await getHighestRolePosition(userId, serverId);
    const targetHighest = await getHighestRolePosition(targetId, serverId);
    if (actorHighest !== Infinity && targetHighest >= actorHighest) {
      socket.emit('voice:error', { message: 'Cannot move a member with an equal or higher role.' });
      return;
    }

    // Validate target channel exists, is voice, is in the same server
    const targetChannel = await prisma.channel.findUnique({
      where: { id: targetChannelId },
      select: { serverId: true, type: true },
    });
    const VOICE_CAPABLE_TYPES = ['voice', 'canvas', 'code'];
    if (!targetChannel || !VOICE_CAPABLE_TYPES.includes(targetChannel.type) || targetChannel.serverId !== serverId) {
      socket.emit('voice:error', { message: 'Invalid target voice channel.' });
      return;
    }

    // Check that the target user has CONNECT permission on the destination channel.
    // Without this check, force_move could be abused to place users in channels they
    // are not allowed to join (effectively a voice-kick disguised as a move).
    const targetCanConnect = await hasChannelPermission(targetId, targetChannelId, serverId, Permissions.CONNECT);
    if (!targetCanConnect) {
      socket.emit('voice:error', { message: 'Target user does not have permission to join that channel.' });
      return;
    }

    // Check capacity of target channel
    const targetChanUsers = voiceChannelUsers.get(targetChannelId);
    const limits = await getEffectiveLimits(serverId);
    if (targetChanUsers && targetChanUsers.size >= limits.maxVoiceUsersPerChannel) {
      socket.emit('voice:error', { message: 'Target voice channel is full.' });
      return;
    }
    const targetSocketId = targetMedia.socketId;

    // Use io.to() instead of local socket lookup — works cross-node with Redis adapter
    io.to(targetSocketId).emit('voice:force_moved', { channelId: sourceChannelId, userId: targetId, targetChannelId });

    // The actual channel switch is handled client-side:
    // the target client receives voice:force_moved, calls leaveChannel() then joinChannel(targetChannelId)
  });

  // ── voice:signal (kept as no-op for backward compat) ──────────────────
  // No-op: kept for backward compat (SFU replaced P2P). Rate-limited to prevent spam.
  socket.on('voice:signal', () => {
    if (!socketRateLimit(socket, 'voice:signal', 10)) return;
  });

  // ── Screen sharing ────────────────────────────────────────────────────
  socket.on('voice:screen_share:start', () => {
    if (!socketRateLimit(socket, 'voice:screen_share', 10)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    // Only one sharer per channel
    if (screenSharers.has(channelId)) return;

    screenSharers.set(channelId, userId);
    mirrorScreenShare(channelId, userId);
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
    mirrorScreenShare(channelId, null);
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
// NOTE (multi-node): Uses io.sockets.sockets.get() intentionally — mediasoup
// Consumers/Transports are node-local objects.  With ip_hash sticky sessions,
// all voice users for a given channel are on the same node as the Router.

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
    mirrorScreenShare(channelId, null);
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

  let channelEmpty = false;
  if (channelUsers) {
    channelUsers.delete(userId);
    if (channelUsers.size === 0) {
      channelEmpty = true;
      voiceChannelUsers.delete(channelId);
      channelServerMap.delete(channelId);
      screenSharers.delete(channelId);
      // Release the Router when the last user leaves
      releaseRouter(channelId);
    }
  }

  // Mirror leave to Redis
  mirrorVoiceLeave(channelId, userId, channelEmpty);

  socket.leave(`voice:${channelId}`);
  socket.data.voiceChannelId = undefined;

  // Broadcast to the entire server so everyone sees the user leave
  if (serverId) {
    io.to(`server:${serverId}`).emit('voice:user_left', { channelId, userId });
  }
}

/**
 * Silently clean up all voice state for a server being deleted.
 *
 * NOTE (multi-node): This only cleans up voice channels whose mediasoup
 * Router lives on THIS node.  `io.sockets.sockets.get()` is intentionally
 * local-only here because mediasoup objects (Routers, Transports, Producers,
 * Consumers) are inherently node-local and cannot be proxied across nodes.
 * In a multi-node deployment, server deletion should ideally be broadcast
 * to every node so each can clean up its own voice state.
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
      for (const [uid, userMedia] of users.entries()) {
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

        // Clean up Redis mirror for this user
        getRedis().del(`voice:user:${uid}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
      }
      voiceChannelUsers.delete(channelId);
    }
    screenSharers.delete(channelId);
    channelServerMap.delete(channelId);
    // Clean up Redis mirror for the entire channel
    const redis = getRedis();
    redis.del(`voice:channel:users:${channelId}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
    redis.del(`voice:channel:server:${channelId}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
    redis.del(`voice:channel:node:${channelId}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
    redis.sRem('voice:active', channelId).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
    redis.del(`voice:screen:${channelId}`).catch((err) => console.warn('[Redis] Voice mirror failed:', err));
  }

  // Release mediasoup Routers for these channels
  releaseServerRouters(channelIds);
}

/** Get screen share state — reads from Redis for cross-node visibility */
export async function getScreenShareState(channelId: string): Promise<string | null> {
  return await getRedis().get(`voice:screen:${channelId}`) ?? null;
}

export function getVoiceChannelUsers(channelId: string): string[] {
  const users = voiceChannelUsers.get(channelId);
  return users ? Array.from(users.keys()) : [];
}

/** Returns count of active voice channels across all nodes (via Redis) */
export async function getActiveVoiceChannelCount(): Promise<number> {
  return await getRedis().sCard('voice:active');
}

/** Returns total number of users in all voice channels across all nodes (via Redis) */
export async function getTotalVoiceUsers(): Promise<number> {
  const redis = getRedis();
  const activeChannels = await redis.sMembers('voice:active');
  if (activeChannels.length === 0) return 0;
  const pipeline = redis.multi();
  for (const channelId of activeChannels) {
    pipeline.hLen(`voice:channel:users:${channelId}`);
  }
  const results = await pipeline.exec();
  let count = 0;
  for (const val of results) {
    if (typeof val === 'number') count += val;
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

/** Returns detailed diagnostic info for all active voice channels (for testing/admin). */
export function getVoiceDiagnostics(): {
  channelId: string;
  userCount: number;
  users: {
    userId: string;
    selfMute: boolean;
    selfDeaf: boolean;
    producers: { id: string; kind: string; paused: boolean; type: string }[];
    consumerCount: number;
  }[];
}[] {
  const result = [];
  for (const [channelId, users] of voiceChannelUsers) {
    const userStates = [];
    for (const [uid, state] of users) {
      const producers = [];
      for (const [producerId, producer] of state.producers) {
        producers.push({
          id: producerId,
          kind: producer.kind,
          paused: producer.paused,
          type: ((producer.appData as Record<string, unknown>)?.type as string) ?? 'unknown',
        });
      }
      userStates.push({
        userId: uid,
        selfMute: state.selfMute,
        selfDeaf: state.selfDeaf,
        producers,
        consumerCount: state.consumers.size,
      });
    }
    result.push({ channelId, userCount: users.size, users: userStates });
  }
  return result;
}

/** Returns all channelIds that belong to a given server and have active voice users (cross-node via Redis) */
export async function getVoiceStateForServer(serverId: string): Promise<{ channelId: string; userIds: string[]; userStates: Map<string, { selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean }> }[]> {
  const redis = getRedis();
  const activeChannels = await redis.sMembers('voice:active');
  if (activeChannels.length === 0) return [];

  // Pipeline: fetch server ID for all active channels in one round-trip
  const serverPipeline = redis.multi();
  for (const channelId of activeChannels) {
    serverPipeline.get(`voice:channel:server:${channelId}`);
  }
  const serverIdsRaw = await serverPipeline.exec();

  // Filter to channels belonging to this server, then fetch user data
  const matchingChannels = activeChannels.filter((_, i) => String(serverIdsRaw[i]) === serverId);
  if (matchingChannels.length === 0) return [];

  const usersPipeline = redis.multi();
  for (const channelId of matchingChannels) {
    usersPipeline.hGetAll(`voice:channel:users:${channelId}`);
  }
  const usersResultsRaw = await usersPipeline.exec();

  const result: { channelId: string; userIds: string[]; userStates: Map<string, { selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean }> }[] = [];
  for (let i = 0; i < matchingChannels.length; i++) {
    const usersData = usersResultsRaw[i] as unknown as Record<string, string>;
    if (!usersData || typeof usersData !== 'object') continue;
    const userIds = Object.keys(usersData);
    if (userIds.length === 0) continue;

    const userStates = new Map<string, { selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean }>();
    for (const [uid, json] of Object.entries(usersData)) {
      const { selfMute, selfDeaf, serverMuted, serverDeafened } = JSON.parse(json);
      userStates.set(uid, { selfMute, selfDeaf, serverMuted: serverMuted ?? false, serverDeafened: serverDeafened ?? false });
    }
    result.push({ channelId: matchingChannels[i], userIds, userStates });
  }
  return result;
}
