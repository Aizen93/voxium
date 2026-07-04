import type { Server as SocketServer, Socket } from 'socket.io';
import { type ServerToClientEvents, type ClientToServerEvents } from '@voxium/shared';
import type { WebRtcTransport, Producer, Consumer, DtlsParameters, RtpParameters, RtpCapabilities } from 'mediasoup/node/lib/types';
import { prisma } from '../utils/prisma';
import { leaveCurrentDMVoiceChannel } from './dmVoiceHandler';
import { socketRateLimit } from '../middleware/rateLimiter';
import { isFeatureEnabled } from '../utils/featureFlags';
import { getOrCreateRouter, createWebRtcTransport, releaseRouter, releaseServerRouters, getRouter } from '../mediasoup/mediasoupManager';
import { RECV_TRANSPORT_MAX_BITRATE, SCREEN_SHARE_RECV_MAX_BITRATE } from '../mediasoup/mediasoupConfig';
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

/** Locate the voice channel a user currently occupies in the in-memory state. */
function findUserVoiceChannel(userId: string): string | undefined {
  for (const [channelId, users] of voiceChannelUsers) {
    if (users.has(userId)) return channelId;
  }
  return undefined;
}

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

/**
 * Clear the server-voice Redis mirror on startup. mediasoup objects are node-local,
 * so on a fresh boot any voice metadata in Redis is stale (a crash/redeploy left it
 * behind with users who are no longer connected). Without this, ghost occupants stay
 * visible to every connecting client and skew stats forever.
 *
 * Persistent moderation keys (voice:server_muted:*, voice:server_deafened:*) are
 * intentionally preserved — they must survive reconnects.
 *
 * NOTE (multi-node): this clears ALL mirror state, which is correct for a single-node
 * deployment. A multi-node setup must instead scope cleanup to this node's NODE_ID
 * (via voice:channel:node) plus a heartbeat/TTL so a crashed peer's state is reaped.
 */
export async function clearVoiceState(): Promise<void> {
  const redis = getRedis();
  // SCAN every voice:* key directly (rather than deriving from voice:active) so orphaned
  // reverse-lookup keys not reachable from the active set are also reaped. Persistent
  // moderation keys (voice:server_muted:*, voice:server_deafened:*) MUST survive.
  const keys: string[] = [];
  for await (const batch of redis.scanIterator({ MATCH: 'voice:*', COUNT: 200 })) {
    for (const k of batch) {
      if (k.startsWith('voice:server_muted:') || k.startsWith('voice:server_deafened:')) continue;
      keys.push(k);
    }
  }
  if (keys.length > 0) {
    await redis.del(keys);
    console.log(`[Voice] Cleared ${keys.length} stale voice mirror key(s)`);
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

    if (!channel || channel.type !== 'voice') {
      console.log(`[Voice] Channel ${channelId} not found or not voice type`);
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

    // Leave any current DM voice call first (cross-cleanup). Force: this socket is
    // (re)joining voice, so evict any prior session for this user regardless of which
    // socket owns it — otherwise a reconnected socket would orphan the old transports.
    await leaveCurrentDMVoiceChannel(io, socket, userId, { force: true });
    // Leave any current voice channel first
    leaveCurrentVoiceChannel(io, socket, userId, { force: true });

    // Join the voice channel room and set voiceChannelId early so that
    // concurrent voice:leave / disconnecting can clean up properly.
    // Also join the channel's visibility room: voice presence events broadcast to
    // `channel:{id}` (VIEW_CHANNEL-scoped), and a participant must always receive
    // its own channel's events even if their VIEW permission is unusual.
    socket.join(`voice:${channelId}`);
    socket.join(`channel:${channelId}`);
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

    // Defensive: the channel Map was created before the awaits above; re-ensure it exists
    // in case a concurrent leave/disconnect drained it mid-join, so this never throws or
    // silently drops the user (belt-and-suspenders alongside the force-evict socket clear).
    let channelUsersMap = voiceChannelUsers.get(channelId);
    if (!channelUsersMap) {
      channelUsersMap = new Map();
      voiceChannelUsers.set(channelId, channelUsersMap);
      channelServerMap.set(channelId, channel.serverId);
    }
    channelUsersMap.set(userId, userMedia);

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

      // Broadcast to the channel's visibility room — every member whose socket
      // can VIEW this channel is subscribed to it (see socketServer connect +
      // syncChannelVisibilityRooms). Broadcasting server-wide leaked private
      // voice channel occupancy to members without VIEW_CHANNEL (HIGH-8).
      const voiceUser = { ...user, selfMute: userMedia.selfMute, selfDeaf: userMedia.selfDeaf, serverMuted: userMedia.serverMuted, serverDeafened: userMedia.serverDeafened, speaking: false };
      io.to(`channel:${channelId}`).emit('voice:user_joined', {
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
    // Every exit path MUST ack — the client's produce() awaits this callback.
    // A silent return would hang the client's send transport forever.
    let acked = false;
    const ack = (response: { producerId?: string; error?: string }) => {
      if (acked) return;
      acked = true;
      if (typeof callback === 'function') callback(response);
    };

    if (!socketRateLimit(socket, 'voice:produce', 20)) { ack({ error: 'Rate limited' }); return; }
    if (!data || typeof data !== 'object' || (data.kind !== 'audio' && data.kind !== 'video') || !data.rtpParameters || typeof data.rtpParameters !== 'object') {
      ack({ error: 'Invalid parameters' });
      return;
    }
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) { ack({ error: 'Not in a voice channel' }); return; }

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (!userMedia?.sendTransport) { ack({ error: 'Voice session not found' }); return; }

    // Derive the producer type SERVER-SIDE. appData is client-controlled — trusting
    // its `type` would let a SPEAK-denied member transmit mic audio by labelling it
    // 'screen-audio' (which is exempt from both the SPEAK check and silence pausing).
    // Screen types are only granted to the channel's active screen sharer.
    const isSharer = screenSharers.get(channelId) === userId;
    let producerType: 'audio' | 'screen-audio' | 'screen-video';
    if (data.kind === 'video') {
      if (!isSharer) { ack({ error: 'Not the active screen sharer' }); return; }
      producerType = 'screen-video';
    } else {
      producerType = isSharer && data.appData?.type === 'screen-audio' ? 'screen-audio' : 'audio';
    }

    if (producerType === 'audio') {
      const serverId = channelServerMap.get(channelId);
      if (serverId) {
        const canSpeak = await hasChannelPermission(userId, channelId, serverId, Permissions.SPEAK);
        if (!canSpeak) { ack({ error: 'You do not have permission to speak in this channel' }); return; }
      }
    }

    // One producer per type — a re-produce replaces the stale one (self-healing after
    // client-side restarts). This also caps producers at 3 per user (mic, screen
    // video, screen audio), replacing the old size>=4 cap that silently dropped the
    // second screen share of a session.
    for (const [existingId, existing] of userMedia.producers) {
      if ((existing.appData as Record<string, unknown>)?.type === producerType) {
        existing.close();
        userMedia.producers.delete(existingId);
      }
    }

    try {
      const producer = await userMedia.sendTransport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters as RtpParameters,
        // Server-derived appData only — never persist client-controlled fields
        appData: { type: producerType, userId },
      });

      userMedia.producers.set(producer.id, producer);

      // If muted (self or server) at join, pause the MIC producer immediately.
      // Screen audio is intentionally exempt — mute means "mute my microphone",
      // system audio keeps flowing for muted/PTT sharers.
      if (producerType === 'audio' && (userMedia.selfMute || userMedia.serverMuted)) {
        producer.pause();
      }

      producer.on('transportclose', () => {
        userMedia.producers.delete(producer.id);
      });

      // ACK the client with the server-side producerId
      ack({ producerId: producer.id });

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
      ack({ error: 'Failed to create producer' });
    }
  });

  // ── voice:producer:close ──────────────────────────────────────────────
  // Client closes a specific producer (screen-share stop, error rollback).
  // Closing fires 'producerclose' on every remote Consumer, which notifies
  // each viewer via voice:producer_closed. Without this event, stopped-share
  // producers leaked server-side until the user left the channel.
  socket.on('voice:producer:close', (data: { producerId: string }) => {
    if (!socketRateLimit(socket, 'voice:producer:close', 30)) return;
    if (!data || typeof data !== 'object' || !isString(data.producerId)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    // Ownership guard: only the socket that owns the live session may close producers
    if (!userMedia || userMedia.socketId !== socket.id) return;

    const producer = userMedia.producers.get(data.producerId);
    if (!producer) return;

    producer.close();
    userMedia.producers.delete(data.producerId);
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
      // Server-deafen enforcement: a deafened user's audio consumers stay paused
      // server-side so a modified client cannot keep listening. Video (screen
      // share) is deliberately not blocked — deafen only silences audio.
      if (userMedia.serverDeafened && consumer.kind === 'audio') return;
      try {
        await consumer.resume();
      } catch (err) {
        console.error(`[Voice] consumer.resume failed for ${userId}:`, err);
      }
    }
  });

  /** Helper: emit full voice:state_update for a user.
   *  Broadcast to the channel's visibility room (VIEW_CHANNEL-scoped), not the
   *  whole server — private voice channels must not leak state to non-viewers. */
  function emitStateUpdate(channelId: string, uid: string, media: UserMediaState) {
    io.to(`channel:${channelId}`).emit('voice:state_update', {
      channelId,
      userId: uid,
      selfMute: media.selfMute,
      selfDeaf: media.selfDeaf,
      serverMuted: media.serverMuted,
      serverDeafened: media.serverDeafened,
    });
  }

  /** Helper: pause the MIC producer for a user.
   *  Filters by appData.type — mute means "mute my microphone"; screen-share
   *  system audio must keep flowing for muted/PTT sharers. */
  function pauseUserAudio(media: UserMediaState) {
    for (const producer of media.producers.values()) {
      if (producer.kind === 'audio' && (producer.appData as Record<string, unknown>)?.type === 'audio') {
        producer.pause();
      }
    }
  }

  /** Helper: resume the MIC producer (only if neither selfMute nor serverMuted) */
  function resumeUserAudioIfAllowed(media: UserMediaState) {
    if (media.selfMute || media.serverMuted) return;
    for (const producer of media.producers.values()) {
      if (producer.kind === 'audio' && (producer.appData as Record<string, unknown>)?.type === 'audio') {
        producer.resume();
      }
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

    // Channel visibility room — private voice channels must not leak activity server-wide
    io.to(`channel:${channelId}`).emit('voice:speaking', { channelId, userId, speaking });
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

    // Enforce server-side: pause/resume the target's AUDIO consumers so a modified
    // client cannot keep listening while server-deafened. Video (screen share)
    // stays — deafen only silences audio. voice:consumer:resume is also guarded.
    for (const consumer of targetMedia.consumers.values()) {
      if (consumer.kind !== 'audio') continue;
      const op = deafened ? consumer.pause() : consumer.resume();
      op.catch((err) => console.warn(`[Voice] Failed to ${deafened ? 'pause' : 'resume'} consumer on server-deafen:`, err));
    }

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
    if (!targetChannel || targetChannel.type !== 'voice' || targetChannel.serverId !== serverId) {
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
  // The client claims the sharer slot BEFORE producing (the server derives
  // screen producer authorization from the active sharer), so start must ACK —
  // the client needs to know whether it may proceed.
  socket.on('voice:screen_share:start', (callback?: (response: { ok: boolean; error?: string }) => void) => {
    const ack = (response: { ok: boolean; error?: string }) => {
      if (typeof callback === 'function') callback(response);
    };
    if (!socketRateLimit(socket, 'voice:screen_share', 10)) { ack({ ok: false, error: 'Rate limited' }); return; }
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) { ack({ ok: false, error: 'Not in a voice channel' }); return; }

    // Only one sharer per channel (re-claim by the same user is idempotent —
    // covers a retry after a failed produce that never reached stop)
    const currentSharer = screenSharers.get(channelId);
    if (currentSharer && currentSharer !== userId) {
      ack({ ok: false, error: 'Someone else is already sharing in this channel' });
      return;
    }

    screenSharers.set(channelId, userId);
    mirrorScreenShare(channelId, userId);
    io.to(`channel:${channelId}`).emit('voice:screen_share:start', { channelId, userId });
    ack({ ok: true });
  });

  socket.on('voice:screen_share:stop', () => {
    if (!socketRateLimit(socket, 'voice:screen_share', 10)) return;
    const channelId = socket.data.voiceChannelId as string;
    if (!channelId) return;

    // Only the current sharer can stop
    if (screenSharers.get(channelId) !== userId) return;

    screenSharers.delete(channelId);
    mirrorScreenShare(channelId, null);

    // Close this user's screen producers server-side (defense in depth — the
    // client also sends voice:producer:close per producer). Closing notifies
    // every viewer's Consumer via 'producerclose'. Without this, stopped-share
    // producers leaked until the user left voice, and the SECOND share of a
    // session hit the producer cap and hung the client (the core HIGH-1 bug).
    const userMedia = voiceChannelUsers.get(channelId)?.get(userId);
    if (userMedia) {
      for (const [producerId, producer] of userMedia.producers) {
        const producerType = (producer.appData as Record<string, unknown>)?.type;
        if (producerType === 'screen-video' || producerType === 'screen-audio') {
          producer.close();
          userMedia.producers.delete(producerId);
        }
      }
    }

    io.to(`channel:${channelId}`).emit('voice:screen_share:stop', { channelId, userId });
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

/** Restore the default recv bitrate cap once no open video consumers remain. */
function restoreRecvBitrateIfNoVideo(media: UserMediaState): void {
  if (!media.recvTransport || media.recvTransport.closed) return;
  for (const c of media.consumers.values()) {
    if (c.kind === 'video' && !c.closed) return;
  }
  media.recvTransport.setMaxOutgoingBitrate(RECV_TRANSPORT_MAX_BITRATE)
    .catch((err) => console.warn('[Voice] Failed to restore recv bitrate cap:', err));
}

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

    // Screen-share video needs far more downstream bandwidth than the audio-era
    // 1.5 Mbps cap allows. Raise this viewer's recv cap while a video consumer
    // exists; restored when the last one closes.
    if (consumer.kind === 'video') {
      consumerMedia.recvTransport.setMaxOutgoingBitrate(SCREEN_SHARE_RECV_MAX_BITRATE)
        .catch((err) => console.warn(`[Voice] Failed to raise recv bitrate cap for ${consumerUserId}:`, err));
    }

    consumer.on('transportclose', () => {
      consumerMedia.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      consumerMedia.consumers.delete(consumer.id);
      if (consumer.kind === 'video') {
        restoreRecvBitrateIfNoVideo(consumerMedia);
      }
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
  userId: string,
  opts?: { force?: boolean }
) {
  const force = opts?.force ?? false;

  // Resolve the channel this user occupies. Prefer this socket's own record;
  // when forcing (a fresh socket taking over the session after a reconnect),
  // fall back to a userId lookup since the new socket hasn't set voiceChannelId yet.
  let channelId = socket.data.voiceChannelId as string | undefined;
  if (!channelId && force) channelId = findUserVoiceChannel(userId);
  if (!channelId) return;

  const channelUsersForOwnership = voiceChannelUsers.get(channelId);
  const ownerMedia = channelUsersForOwnership?.get(userId);

  // Socket-ownership guard: a non-forced leave (disconnect / explicit leave) must
  // NOT tear down a session a newer socket has taken over. Without this, when the
  // old socket times out (~10-35s after a network blip) it would kill the freshly
  // re-joined session and leak its transports. A stale socket only clears its own
  // room membership and leaves the live session intact.
  if (!force && ownerMedia && ownerMedia.socketId !== socket.id) {
    socket.leave(`voice:${channelId}`);
    if (socket.data.voiceChannelId === channelId) socket.data.voiceChannelId = undefined;
    return;
  }

  // When force-evicting a session owned by a DIFFERENT socket (a reconnect where this
  // socket takes over), synchronously neutralise the OLD socket's voice state so its
  // delayed disconnect becomes a no-op. This eviction runs before any await in voice:join,
  // so clearing it now closes the window where the old socket's ping-timeout disconnect
  // could otherwise tear down the channel map out from under the in-progress rejoin
  // (crash on the map write + orphaned transports + duplicate voice:user_left). The old
  // socket is local on a single node, so io.sockets.sockets.get is intentional here.
  if (force && ownerMedia && ownerMedia.socketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(ownerMedia.socketId);
    if (oldSocket) {
      oldSocket.leave(`voice:${channelId}`);
      oldSocket.data.voiceChannelId = undefined;
    }
  }

  console.log(`[Voice] Removing user ${userId} from channel ${channelId}`);

  // Captured before the empty-channel cleanup deletes the mapping — needed for
  // the VIEW re-check below.
  const serverId = channelServerMap.get(channelId);

  // Clean up screen share if this user was sharing
  if (screenSharers.get(channelId) === userId) {
    screenSharers.delete(channelId);
    mirrorScreenShare(channelId, null);
    io.to(`channel:${channelId}`).emit('voice:screen_share:stop', { channelId, userId });
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

  // voice:join force-joins the participant's socket to the channel's visibility
  // room (so it always receives its own channel's events, even with unusual
  // permissions). Members who can VIEW keep that subscription after leaving —
  // normal room semantics — but a CONNECT-without-VIEW participant must not
  // keep receiving presence events. Fire-and-forget: a failed check just leaves
  // the socket subscribed until disconnect, same as before this guard existed.
  if (serverId) {
    hasChannelPermission(userId, channelId, serverId, Permissions.VIEW_CHANNEL)
      .then((canView) => {
        if (!canView) socket.leave(`channel:${channelId}`);
      })
      .catch((err) => console.warn(`[Voice] VIEW re-check on leave failed for ${userId}:`, err));
  }

  // Broadcast to the channel's visibility room (VIEW_CHANNEL-scoped)
  io.to(`channel:${channelId}`).emit('voice:user_left', { channelId, userId });
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
