import type { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@voxium/shared';
import { getRedis, getRedisPubSub, getRedisConfigSub, NODE_ID, isNodeAlive } from '../utils/redis';
import { reapVoiceChannelMirror } from '../utils/voiceMirror';
import type { VoiceSocket } from './voiceHandler';

type IO = SocketServer<ClientToServerEvents, ServerToClientEvents>;

// ─── HIGH-15: channel-affinity voice signaling relay ────────────────────────
//
// mediasoup media (UDP RTP) never touches nginx — clients connect straight to
// the Router-owning node's MEDIASOUP_ANNOUNCED_IP:port. Only the Socket.IO
// signaling connection is pinned to the user's "home" node by ip_hash. So a
// voice channel works cross-node by executing ALL of its signaling on the one
// node that owns its Router:
//
//   client ──ws── home node ──redis pub/sub──▶ owner node ──mediasoup──▶ UDP
//                                             (transports/producers/consumers)
//
// The home node routes each voice event: local channel → run in place;
// remote-owned channel → publish to `voice:relay:{ownerNodeId}`. On the owner,
// the participant is represented by a SHIM exposing the socket surface the
// handlers use (`id`, `data`, `emit`, `join`, `leave`) implemented with
// adapter-wide primitives, so the existing handler logic runs unchanged.

const RELAY_CHANNEL_PREFIX = 'voice:relay:';
const ACK_TIMEOUT_MS = 8_000;
const OWNERSHIP_CLAIM_TTL_S = 90; // temporary — mirrorVoiceJoin persists it without TTL

interface RemoteSession {
  userId: string;
  channelId: string;
  ownerNodeId: string;
}

interface RelayRequest {
  kind: 'req';
  id?: string; // present only when the event carries a client ACK callback
  fromNode: string;
  socketId: string;
  userId: string;
  event: string;
  args: unknown[];
}

interface RelayReply {
  kind: 'rep';
  id: string;
  response: unknown;
}

export type VoiceDispatcher = (
  shim: VoiceSocket,
  event: string,
  args: unknown[],
  ack?: (response: unknown) => void,
) => void | Promise<void>;

// Home-node view: which of MY sockets have a voice session on another node
const remoteSessions = new Map<string, RemoteSession>();
// Owner-node view: shim per remote participant socketId (stable identity —
// socket.data persistence and per-socket rate-limit buckets depend on it)
const remoteShims = new Map<string, VoiceSocket>();

const pendingAcks = new Map<string, { resolve: (response: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
let requestSeq = 0;

let ioRef: IO | null = null;
let dispatcher: VoiceDispatcher | null = null;

// ─── Remote session bookkeeping (home node) ─────────────────────────────────

export function getRemoteSession(socketId: string): RemoteSession | undefined {
  return remoteSessions.get(socketId);
}

export function setRemoteSession(socketId: string, session: RemoteSession): void {
  remoteSessions.set(socketId, session);
}

export function clearRemoteSession(socketId: string): void {
  remoteSessions.delete(socketId);
}

// ─── Shims (owner node) ──────────────────────────────────────────────────────

export function getOrCreateShim(io: IO, socketId: string, userId: string): VoiceSocket {
  let shim = remoteShims.get(socketId);
  if (!shim) {
    shim = {
      id: socketId,
      data: { userId },
      // io.to / socketsJoin / socketsLeave are adapter-wide — they reach the
      // participant's real socket on its home node.
      emit: ((event: string, ...args: unknown[]) => {
        (io.to(socketId) as { emit: (event: string, ...a: unknown[]) => void }).emit(event, ...args);
        return true;
      }) as VoiceSocket['emit'],
      join: (room: string | string[]) => {
        io.in(socketId).socketsJoin(room);
      },
      leave: (room: string) => {
        io.in(socketId).socketsLeave(room);
      },
    } as VoiceSocket;
    remoteShims.set(socketId, shim);
  }
  return shim;
}

export function dropShim(socketId: string): void {
  remoteShims.delete(socketId);
}

// ─── Channel ownership ───────────────────────────────────────────────────────

/**
 * Resolve which node owns a channel's mediasoup Router, claiming ownership for
 * THIS node when the channel is unowned — or taking over when the recorded
 * owner has no live heartbeat (crashed peer; its mirror is reaped first).
 */
export async function resolveOrClaimChannelOwner(channelId: string): Promise<string> {
  const redis = getRedis();
  const key = `voice:channel:node:${channelId}`;

  const existing = await redis.get(key);
  if (existing === NODE_ID()) return existing;
  if (existing) {
    if (await isNodeAlive(existing)) return existing;
    // Dead owner — reap its stale mirror and take over.
    console.warn(`[VoiceRelay] Taking over channel ${channelId} from dead node ${existing}`);
    await reapVoiceChannelMirror(channelId);
    await redis.set(key, NODE_ID(), { EX: OWNERSHIP_CLAIM_TTL_S });
    return NODE_ID();
  }

  // Unowned — atomic claim; the TTL covers the window until the first
  // successful join persists the key via mirrorVoiceJoin (or the join fails
  // validation and the claim just expires).
  const claimed = await redis.set(key, NODE_ID(), { NX: true, EX: OWNERSHIP_CLAIM_TTL_S });
  if (claimed === 'OK') return NODE_ID();
  // Lost the race — someone else claimed between GET and SET NX.
  return (await redis.get(key)) ?? NODE_ID();
}

// ─── Relay transport ─────────────────────────────────────────────────────────

/** Error-shaped ACK response per event, for timeouts / relay failures. */
function ackFailureResponse(event: string, message: string): unknown {
  if (event === 'voice:screen_share:start') return { ok: false, error: message };
  return { error: message };
}

/**
 * Forward a voice event to the channel-owning node. If `ack` is provided the
 * owner's response is forwarded back to the client callback, with a timeout so
 * a dead owner can never hang the client (the client has its own 10s guard on
 * produce as a second line of defense).
 */
export async function relayVoiceEvent(
  ownerNodeId: string,
  event: string,
  socket: Pick<VoiceSocket, 'id' | 'data'>,
  args: unknown[],
  ack?: (response: unknown) => void,
): Promise<void> {
  const payload: RelayRequest = {
    kind: 'req',
    fromNode: NODE_ID(),
    socketId: socket.id,
    userId: socket.data.userId as string,
    event,
    args,
  };

  if (ack) {
    const id = `${NODE_ID()}:${++requestSeq}`;
    payload.id = id;
    const timer = setTimeout(() => {
      pendingAcks.delete(id);
      ack(ackFailureResponse(event, 'Voice node timeout'));
    }, ACK_TIMEOUT_MS);
    timer.unref?.();
    pendingAcks.set(id, { resolve: ack, timer });
  }

  try {
    const { pub } = getRedisPubSub();
    await pub.publish(`${RELAY_CHANNEL_PREFIX}${ownerNodeId}`, JSON.stringify(payload));
  } catch (err) {
    console.error(`[VoiceRelay] Failed to relay ${event} to node ${ownerNodeId}:`, err);
    if (payload.id) {
      const pending = pendingAcks.get(payload.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAcks.delete(payload.id);
        pending.resolve(ackFailureResponse(event, 'Voice relay unavailable'));
      }
    }
  }
}

/**
 * Handle one message on this node's relay channel. Exported for tests.
 * - 'req': a peer forwards a participant's voice event — dispatch it against a
 *   shim; if the event carries an ACK, publish the response back to the peer.
 * - 'rep': a response for an ACK we are awaiting — settle the client callback.
 */
export async function handleRelayMessage(raw: string): Promise<void> {
  let msg: RelayRequest | RelayReply;
  try {
    msg = JSON.parse(raw) as RelayRequest | RelayReply;
  } catch {
    console.warn('[VoiceRelay] Malformed relay message (not JSON)');
    return;
  }

  if (msg.kind === 'rep') {
    if (typeof msg.id !== 'string') return;
    const pending = pendingAcks.get(msg.id);
    if (!pending) return; // already timed out
    clearTimeout(pending.timer);
    pendingAcks.delete(msg.id);
    pending.resolve(msg.response);
    return;
  }

  if (msg.kind !== 'req') return;
  if (!ioRef || !dispatcher) return;
  const { fromNode, socketId, userId, event, args, id } = msg;
  if (typeof fromNode !== 'string' || typeof socketId !== 'string' || typeof userId !== 'string'
    || typeof event !== 'string' || !Array.isArray(args)) {
    console.warn('[VoiceRelay] Malformed relay request envelope');
    return;
  }

  const shim = getOrCreateShim(ioRef, socketId, userId);
  const ack = id
    ? (response: unknown) => {
        try {
          const { pub } = getRedisPubSub();
          pub.publish(`${RELAY_CHANNEL_PREFIX}${fromNode}`, JSON.stringify({ kind: 'rep', id, response } satisfies RelayReply))
            .catch((err) => console.warn('[VoiceRelay] Failed to publish relay reply:', err));
        } catch (err) {
          console.warn('[VoiceRelay] Failed to publish relay reply:', err);
        }
      }
    : undefined;

  try {
    await dispatcher(shim, event, args, ack);
  } catch (err) {
    console.error(`[VoiceRelay] Dispatch of relayed ${event} failed:`, err);
    ack?.(ackFailureResponse(event, 'Voice node error'));
  }

  // A completed leave/disconnect ends the remote participant — drop the shim
  if (event === 'voice:leave' || event === 'disconnecting') {
    dropShim(socketId);
  }
}

/** Subscribe this node's relay channel. Call once at startup, after Socket.IO init. */
export async function initVoiceRelay(io: IO, d: VoiceDispatcher): Promise<void> {
  ioRef = io;
  dispatcher = d;
  const sub = getRedisConfigSub();
  await sub.subscribe(`${RELAY_CHANNEL_PREFIX}${NODE_ID()}`, (message) => {
    handleRelayMessage(message).catch((err) =>
      console.error('[VoiceRelay] Relay message handling failed:', err));
  });
}

/** Test-only: reset module state between test cases. */
export function _resetVoiceRelayForTests(): void {
  remoteSessions.clear();
  remoteShims.clear();
  for (const { timer } of pendingAcks.values()) clearTimeout(timer);
  pendingAcks.clear();
  ioRef = null;
  dispatcher = null;
}
