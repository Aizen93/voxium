import { create } from 'zustand';
import { Device } from 'mediasoup-client';
import type { Transport, Producer, Consumer, RtpCapabilities, IceParameters, IceCandidate, DtlsParameters, RtpParameters } from 'mediasoup-client/types';
import { getSocket, onSocketReconnect } from '../services/socket';
import { startSpeakingDetection, stopSpeakingDetection, setNoiseGateThreshold, getGatedStream, setNoiseSuppression, onSpeakingChange, applyNoiseSuppression, getSuppressedStream, stopNoiseSuppression, setSpeakingDetectionPaused } from '../services/audioAnalyser';
import { useSettingsStore, VOICE_QUALITY_BITRATE } from './settingsStore';
import { toast } from './toastStore';
import { teardownComposite } from '../services/screenComposite';
import { sourceKeyFromSettings } from '../utils/maskLayouts';
import { optimizeOpusSDP } from '../services/sdpUtils';
import i18n from '../i18n';
import type { VoiceUser, TransportOptions, E2ECallSignal } from '@voxium/shared';
import type { CallPeerDevice } from '../services/e2e/callCrypto';

/** Debug log — stripped in production builds by Vite tree-shaking */
const debugLog = import.meta.env.DEV
  ? (...args: unknown[]) => console.log(...args)
  : () => {};

const VOICE_PREFS_KEY = 'voxium_voice_prefs';

interface VoicePrefs {
  selfMute: boolean;
  selfDeaf: boolean;
}

function loadPersistedVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(VOICE_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        selfMute: typeof parsed.selfMute === 'boolean' ? parsed.selfMute : false,
        selfDeaf: typeof parsed.selfDeaf === 'boolean' ? parsed.selfDeaf : false,
      };
    }
  } catch (err) {
    console.warn('[Voice] Failed to parse persisted voice prefs, using defaults:', err);
  }
  return { selfMute: false, selfDeaf: false };
}

function persistVoicePrefs(prefs: VoicePrefs) {
  try {
    localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify({
      selfMute: prefs.selfMute,
      selfDeaf: prefs.selfDeaf,
    }));
  } catch (err) {
    console.warn('[Voice] Failed to persist voice prefs:', err);
  }
}

const initialVoicePrefs = loadPersistedVoicePrefs();

// ─── DM P2P WebRTC configuration ─────────────────────────────────────────────

// Self-hosted STUN server (coturn in STUN-only mode) for NAT traversal.
// STUN is a stateless UDP request/response (~100 bytes each way) that tells
// each peer their own public IP:port — no media flows through it. Privacy-first.
// Derives hostname from VITE_WS_URL so it points to the same Voxium server.
const STUN_HOST = (() => {
  try { return new URL(import.meta.env.VITE_WS_URL || 'http://localhost:3001').hostname; }
  catch (err) { console.warn('[Voice] Failed to parse VITE_WS_URL for STUN host:', err); return 'localhost'; }
})();
const ICE_SERVERS: RTCIceServer[] = [
  { urls: `stun:${STUN_HOST}:3478` },
];

const ICE_RESTART_DELAY_MS = 3000;
const MAX_TRANSPORT_REJOIN_ATTEMPTS = 3;

/** Wait until the E2E store reports ready (or errored / timed out). */
async function waitForE2EReady(timeoutMs: number): Promise<void> {
  const { useE2EStore } = await import('./e2eStore');
  if (useE2EStore.getState().ready) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve();
    }, timeoutMs);
    const unsub = useE2EStore.subscribe((s) => {
      if (s.ready || s.error) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

/**
 * The E2E device id this client would call from — announced on dm:voice:join
 * so the peer seals call signals to exactly this device (spec §20). Dynamic
 * imports per the resetStores eval-cycle rule.
 *
 * A call started right after app launch can race E2E initialization (WASM +
 * vault open + first-run registration): reading `deviceId` before init lands
 * throws, the join would go out without a device id, and the PEER would abort
 * with a misleading "peer must update". Kick init (the store guards reentry)
 * and wait briefly for readiness instead.
 */
async function resolveOwnCallDeviceId(): Promise<string | undefined> {
  try {
    const { getE2EService } = await import('../services/e2e/e2eService');
    const { useAuthStore } = await import('./authStore');
    const { useE2EStore } = await import('./e2eStore');
    const me = useAuthStore.getState().user;
    if (!me) return undefined;
    if (!useE2EStore.getState().ready) {
      useE2EStore.getState().initialize(me.id).catch((err) => {
        console.warn('[DMVoice] E2E init kick failed (store records the error):', err);
      });
      await waitForE2EReady(10_000);
    }
    return getE2EService(me.id).deviceId || undefined;
  } catch (err) {
    console.warn('[DMVoice] Could not resolve E2E device id:', err);
    return undefined;
  }
}

// Screen-share video target bitrate. High enough for readable 1080p desktop
// content; the server raises the viewer-side recv cap while a video consumer
// is active (SCREEN_SHARE_RECV_MAX_BITRATE).
const SCREEN_SHARE_MAX_BITRATE = 2_500_000;

interface PeerConnection {
  pc: RTCPeerConnection;
  makingOffer: boolean;
  /** ICE candidates that arrived before the remote description was set —
   *  applied once it lands instead of being dropped (dropped candidates mean
   *  slower or outright failed ICE on unlucky signaling order). */
  pendingCandidates: RTCIceCandidateInit[];
}

/**
 * True only for the MICROPHONE producer. Every mute/deafen/PTT path must use
 * this filter — pausing by `kind === 'audio'` alone also pauses screen-share
 * system audio, which must keep flowing for muted/PTT sharers.
 */
export function isMicProducer(producer: Producer): boolean {
  return producer.kind === 'audio'
    && (producer.appData as Record<string, unknown>)?.type === 'audio';
}

// ─── State Interface ─────────────────────────────────────────────────────────

interface VoiceState {
  // ─── Shared State ──────────────────────────────────────────────────
  localUserId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  /** True while the push-to-talk key is held (overrides selfMute for speaking indicator). */
  pttActive: boolean;
  localStream: MediaStream | null;
  latency: number | null;

  // DM P2P peers (not used for server voice anymore)
  peers: Map<string, PeerConnection>;
  remoteAudios: Map<string, HTMLAudioElement>;

  // ─── Server Voice State (SFU) ──────────────────────────────────────
  activeChannelId: string | null;
  activeVoiceServerId: string | null;
  channelUsers: Map<string, VoiceUser[]>;
  /** channelId → serverId, learned from presence events. channelUsers spans
   *  ALL servers (sockets sit in every visible channel room), so this map is
   *  what lets the spaces strip say "server X has a live room". */
  channelServers: Map<string, string>;

  // mediasoup SFU state
  msDevice: Device | null;
  msSendTransport: Transport | null;
  msRecvTransport: Transport | null;
  msProducers: Map<string, Producer>;
  // appType is the server-derived producer type ('audio' | 'screen-audio' | 'screen-video')
  // — used to route cleanup precisely when a producer closes
  msConsumers: Map<string, { consumer: Consumer; producerUserId: string; appType: string }>;

  // ─── Screen Share State ──────────────────────────────────────────
  screenStream: MediaStream | null;
  isScreenSharing: boolean;
  screenSharingUserId: string | null;
  remoteScreenStream: MediaStream | null;
  screenShareViewMode: 'inline' | 'floating';
  /** True while outgoing screen RTP is gated by the mask compositor (setup in
   *  flight, or setup failed and the share is held frozen fail-closed). The
   *  sharer's own preview keeps playing the raw capture, so without this flag
   *  they would never know viewers see a frozen frame. */
  screenShareFrozen: boolean;
  /** The current share's source identity (`displaySurface:WxH` from the
   *  capture track's settings) — the key remembered mask layouts live under.
   *  Null while not sharing or when the settings gave no size. */
  screenShareSourceKey: string | null;
  /** The annotation wire version the server advertised on our share claim
   *  (1 when absent — an older server, or the annotations_v2 flag off). The
   *  toolbar hides v2 tools below 2 so nothing we draw gets rejected after
   *  the local echo painted it. Only meaningful while isScreenSharing. */
  screenShareAnnotationsVersion: number;

  // ─── DM Call State ─────────────────────────────────────────────────
  dmCallConversationId: string | null;
  dmCallUsers: VoiceUser[];
  incomingCall: { conversationId: string; from: VoiceUser } | null;
  /** The peer's E2E call device — every dm:voice:signal seals to exactly it. */
  dmCallPeerDevice: CallPeerDevice | null;

  // ─── Secure Voice State (spec §21) ─────────────────────────────────
  /** Participants of the active secure voice channel we could not key
   *  (failed vetting / identity change / un-updated client) — UI badge. */
  secureVoicePeerIssues: Record<string, string>;
  markSecureVoicePeerExcluded: (channelId: string, userId: string, kind: string) => void;
  clearSecureVoicePeerIssue: (channelId: string, userId: string) => void;
  /** True while the ACTIVE voice channel is a secure (E2E) one. Derived from
   *  the live session, never from the viewed server's channel list — voice
   *  outlives navigation, and the UI must keep showing the lock. */
  secureVoiceActive: boolean;

  // ─── Shared Actions ────────────────────────────────────────────────
  setLocalUserId: (userId: string) => void;
  toggleMute: () => void;
  toggleDeaf: () => void;
  startLatencyMeasurement: () => void;
  stopLatencyMeasurement: () => void;
  destroyPeer: (userId: string) => void;
  destroyAllPeers: () => void;

  // ─── Server Voice Actions (SFU) ────────────────────────────────────
  joinChannel: (channelId: string, serverId?: string, opts?: { secure?: boolean; keepRetryCount?: boolean }) => Promise<void>;
  leaveChannel: () => void;
  setChannelUsers: (channelId: string, users: VoiceUser[], serverId?: string) => void;
  addUserToChannel: (channelId: string, user: VoiceUser, serverId?: string) => void;
  removeUserFromChannel: (channelId: string, userId: string) => void;
  updateUserState: (channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean, serverMuted: boolean, serverDeafened: boolean) => void;
  handleForceMove: (targetChannelId: string) => void;
  serverMuteUser: (targetUserId: string, muted: boolean) => void;
  serverDeafenUser: (targetUserId: string, deafened: boolean) => void;
  forceMoveUser: (targetUserId: string, targetChannelId: string) => void;
  setUserSpeaking: (channelId: string, userId: string, speaking: boolean) => void;
  handleSignal: (from: string, signal: unknown) => void;
  createPeer: (targetUserId: string, initiator: boolean) => void;

  // mediasoup SFU actions
  handleTransportCreated: (data: {
    routerRtpCapabilities: unknown;
    sendTransport: TransportOptions;
    recvTransport: TransportOptions;
  }) => Promise<void>;
  handleNewConsumer: (data: {
    id: string;
    producerId: string;
    kind: 'audio' | 'video';
    rtpParameters: unknown;
    producerUserId: string;
    appData?: Record<string, unknown>;
  }) => Promise<void>;
  handleProducerClosed: (data: { consumerId: string; producerUserId: string }) => void;
  cleanupSFU: () => void;

  // ─── Screen Share Actions ────────────────────────────────────────
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  setScreenSharingUser: (channelId: string, userId: string | null) => void;
  setScreenShareViewMode: (mode: 'inline' | 'floating') => void;
  /** Swap the live screen-video producer's track (privacy-mask compositor —
   *  no renegotiation; encodings preserved). Throws if no producer is live. */
  replaceScreenVideoTrack: (track: MediaStreamTrack) => Promise<void>;
  /** Fail-closed gate for the mask compositor: pause stops outgoing RTP on the
   *  screen-video producer (mic/screen-audio untouched) while masks are being
   *  set up, so no raw frame can ship under a mask. No-op without a producer. */
  setScreenVideoProducerPaused: (paused: boolean) => void;

  // ─── DM Call Actions ───────────────────────────────────────────────
  joinDMCall: (conversationId: string) => Promise<void>;
  leaveDMCall: () => void;
  /** Full local teardown WITHOUT notifying the server — for server-initiated
   *  ends (dm:voice:ended), where echoing dm:voice:leave would be wrong. */
  handleDMCallEnded: () => void;
  /** Leave the call because of an E2E security condition, telling the user why. */
  abortDMCall: (reason: DMCallAbortReason) => void;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  setIncomingCall: (data: { conversationId: string; from: VoiceUser } | null) => void;
  addDMCallUser: (user: VoiceUser & { deviceId?: string }) => void;
  removeDMCallUser: (userId: string) => void;
  updateDMCallUserState: (userId: string, selfMute: boolean, selfDeaf: boolean) => void;
  setDMCallUserSpeaking: (userId: string, speaking: boolean) => void;
  handleDMSignal: (from: string, signal: unknown) => void;
  createDMPeer: (targetUserId: string, initiator: boolean) => void;
}

let latencyInterval: ReturnType<typeof setInterval> | null = null;
let pongHandler: ((timestamp: number) => void) | null = null;
let transportRejoinAttempts = 0;

// ─── Secure voice (spec §21) module state ───────────────────────────────────
// The frame-crypto session handle lives OUTSIDE zustand (crypto bookkeeping
// must survive store snapshots/resets — the callCrypto rule). Non-null only
// while the active channel is a secure voice channel.
let secureVoiceFrames: import('../services/e2e/voiceFrameTransform').FrameCryptoSession | null = null;
let secureVoiceChannelId: string | null = null;

function activeSecureVoiceSession(channelId: string | null): import('../services/e2e/voiceFrameTransform').FrameCryptoSession | null {
  return channelId && secureVoiceChannelId === channelId ? secureVoiceFrames : null;
}

/**
 * End the secure-voice session (if any) — leave/cleanup/reconnect paths.
 * Exported because teardowns that deliberately skip leaveChannel (the server
 * already ejected us, so emitting voice:leave would be wrong) must still kill
 * the crypto worker, zero the media key, and stop the membership poll.
 */
export function teardownSecureVoice(): void {
  if (!secureVoiceChannelId) return;
  const channelId = secureVoiceChannelId;
  secureVoiceChannelId = null;
  secureVoiceFrames = null;
  void import('../services/e2e/secureVoiceKeys')
    .then((m) => m.endSecureVoiceSession(channelId))
    .catch((err) => console.warn('[SecureVoice] Session teardown failed:', err));
}

// Incremented on every join/leave (server voice AND DM calls). Guards the async
// mic acquisition inside joins: a join superseded mid-getUserMedia must stop the
// stream it acquired instead of leaking it (OS mic indicator stuck on forever).
let voiceSessionGeneration = 0;

// Track ICE restart timers per DM peer
const iceRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Audio element helpers ──────────────────────────────────────────────────

function getAudioContainer(): HTMLElement {
  let container = document.getElementById('vox-audio-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'vox-audio-container';
    container.style.display = 'none';
    document.body.appendChild(container);
  }
  return container;
}

function applyOutputDevice(audio: HTMLAudioElement, deviceId: string) {
  // setSinkId is part of the Audio Output Devices API (not in all TS lib typings)
  const audioWithSink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (deviceId && typeof audioWithSink.setSinkId === 'function') {
    audioWithSink.setSinkId(deviceId).catch((err: Error) => {
      console.warn('[Voice] Failed to set output device:', err);
    });
  }
}

type SignalEvent = 'voice:signal' | 'dm:voice:signal';

export type DMCallAbortReason = 'identity-changed' | 'peer-must-update' | 'peer-not-e2e' | 'signaling-failed';

/** Emit a signaling event on the socket with proper typing per event name. */
function emitSignal(
  socket: ReturnType<typeof getSocket>,
  event: SignalEvent,
  data: { to: string; signal: unknown },
) {
  if (event === 'dm:voice:signal') {
    // E2E cutover (spec §20): DM signals NEVER leave in plaintext. Sealed on
    // the send chain to the pinned peer device; socket resolved at emit time.
    sendDMSignalEncrypted(data.to, data.signal as E2ECallSignal);
    return;
  }
  if (!socket) return;
  socket.emit('voice:signal', data);
}

// ─── E2E-authenticated DM call signaling (docs/e2e-dm-spec.md §20) ──────────
// Every dm:voice:signal payload travels as a pairwise-Olm envelope sealed to
// the ONE pinned peer device. The chains serialize the async crypto: wire
// order must match signal generation order (sends) and socket arrival order
// (receives — the strictly-increasing seq check depends on it).

let dmSendChain: Promise<void> = Promise.resolve();
let dmRecvChain: Promise<void> = Promise.resolve();
// Inbound signals that arrive before dm:voice:joined pins the peer device (an
// offer can beat the joined event across the relay) — buffered, flushed in
// arrival order once the pin lands. Dropping them would deadlock the polite
// side of glare.
let prePinSignalQueue: Array<{ from: string; signal: unknown }> = [];
// While true the pin is set but its begin/flush hasn't run yet — inbound
// signals keep buffering so a live signal can't jump ahead of buffered ones.
let dmPinFlushPending = false;
const PRE_PIN_QUEUE_CAP = 32;

function resetDMSignalChains() {
  dmSendChain = Promise.resolve();
  dmRecvChain = Promise.resolve();
  prePinSignalQueue = [];
  dmPinFlushPending = false;
}

function classifyCallCryptoError(
  crypto: typeof import('../services/e2e/callCrypto'),
  err: unknown,
): DMCallAbortReason {
  if (err instanceof crypto.E2EIdentityChangedError) return 'identity-changed';
  if (err instanceof crypto.CallSecurityError) {
    return err.kind === 'peer-not-e2e' ? 'peer-not-e2e' : 'peer-must-update';
  }
  return 'signaling-failed';
}

/** Seal one outbound DM call signal and emit it, preserving generation order. */
function sendDMSignalEncrypted(to: string, signal: E2ECallSignal) {
  dmSendChain = dmSendChain.then(async () => {
    const state = useVoiceStore.getState();
    const conversationId = state.dmCallConversationId;
    const peer = state.dmCallPeerDevice;
    if (!conversationId || !peer || peer.userId !== to) return; // call ended or stale target
    const crypto = await import('../services/e2e/callCrypto');
    let envelope: string;
    try {
      try {
        envelope = await crypto.encryptCallSignal(conversationId, peer, signal);
      } catch (err) {
        // Security conditions abort immediately; transient failures (bundle
        // claim hiccup, network) get exactly one retry
        if (err instanceof crypto.CallSecurityError || err instanceof crypto.E2EIdentityChangedError) throw err;
        debugLog('[DMVoice] Signal encrypt failed, retrying once:', err);
        envelope = await crypto.encryptCallSignal(conversationId, peer, signal);
      }
    } catch (err) {
      console.error('[DMVoice] Could not encrypt call signal — aborting call:', err);
      useVoiceStore.getState().abortDMCall(classifyCallCryptoError(crypto, err));
      return;
    }
    const now = useVoiceStore.getState();
    // Re-pin swaps the peer object — stale sends for the old device are dropped
    if (now.dmCallConversationId !== conversationId || now.dmCallPeerDevice !== peer) return;
    getSocket()?.emit('dm:voice:signal', { to, signal: envelope });
  }).catch((err) => {
    console.error('[DMVoice] Call signal send chain error:', err);
  });
}

/** Open one inbound envelope and drive the normal WebRTC signal handling. */
function receiveDMSignalEncrypted(from: string, payload: unknown) {
  dmRecvChain = dmRecvChain.then(async () => {
    const state = useVoiceStore.getState();
    const conversationId = state.dmCallConversationId;
    const peer = state.dmCallPeerDevice;
    if (!conversationId || !peer || peer.userId !== from) return;
    const crypto = await import('../services/e2e/callCrypto');
    let plain: E2ECallSignal | null;
    try {
      plain = await crypto.decryptCallSignal(conversationId, peer, payload);
    } catch (err) {
      console.error('[DMVoice] Inbound call signal failed security checks — aborting call:', err);
      useVoiceStore.getState().abortDMCall(classifyCallCryptoError(crypto, err));
      return;
    }
    if (plain === null) return; // droppable: replay, stale epoch, binding mismatch
    const now = useVoiceStore.getState();
    if (now.dmCallConversationId !== conversationId || now.dmCallPeerDevice !== peer) return;
    handleSignalInternal('dm:voice:signal', '[DMVoice]', now.createDMPeer, from, plain, {
      get: () => useVoiceStore.getState(),
    });
  }).catch((err) => {
    console.error('[DMVoice] Call signal receive chain error:', err);
  });
}

/**
 * Pin the peer's call device and start a signaling session for it. The begin
 * runs on the send chain (so it cannot race the first encrypt's auto-begin),
 * then the pre-pin buffer flushes in arrival order.
 */
function pinDMCallPeer(conversationId: string, peer: CallPeerDevice) {
  useVoiceStore.setState({ dmCallPeerDevice: peer });
  dmPinFlushPending = true;
  dmSendChain = dmSendChain.then(async () => {
    const { beginCallSignaling, getCallPeerDevice } = await import('../services/e2e/callCrypto');
    const current = getCallPeerDevice(conversationId);
    // encryptCallSignal auto-begins on pin mismatch — don't reset an epoch a
    // queued encrypt already started for this exact device
    if (!current || current.userId !== peer.userId || current.deviceId !== peer.deviceId) {
      beginCallSignaling(conversationId, peer);
    }
  }).catch((err) => {
    console.error('[DMVoice] Failed to pin call peer device:', err);
  }).finally(() => {
    dmPinFlushPending = false;
    const buffered = prePinSignalQueue.splice(0);
    for (const b of buffered) {
      if (b.from === peer.userId) receiveDMSignalEncrypted(b.from, b.signal);
      else debugLog('[DMVoice] Discarding buffered signal from non-call-peer', b.from);
    }
  });
}

/** Acquire a mic audio stream using the user's preferred input device. */
async function acquireAudioStream(): Promise<MediaStream | null> {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[Voice] getUserMedia not available (insecure context?), joining in listen-only mode');
      return null;
    }
    const settings = useSettingsStore.getState();
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      // Invert: when our RNNoise ML suppression is enabled, disable the browser's
      // built-in noiseSuppression to avoid double-processing (two noise gates in
      // series degrade voice quality). When RNNoise is off, enable the browser's
      // built-in as a fallback.
      noiseSuppression: !settings.enableNoiseSuppression,
      autoGainControl: true,
    };
    if (settings.audioInputDeviceId) {
      audioConstraints.deviceId = { exact: settings.audioInputDeviceId };
    }
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch (err) {
    console.warn('[Voice] Microphone access denied, joining in listen-only mode:', err);
    toast.warning('Microphone access denied — joining in listen-only mode');
    return null;
  }
}

// ─── DM P2P Peer helpers (unchanged) ────────────────────────────────────────

// Track RTCRtpSenders for screen share tracks (DM only — not used in SFU)
const currentScreenSenders = new Map<string, RTCRtpSender[]>();

/**
 * Shared RTCPeerConnection factory for DM voice only.
 */
function createPeerInternal(
  signalEvent: SignalEvent,
  logPrefix: string,
  targetUserId: string,
  initiator: boolean,
  stateAccessors: { get: () => VoiceState; set: (partial: Partial<VoiceState>) => void },
) {
  const { get: getState, set: setState } = stateAccessors;
  const { localStream, peers } = getState();

  if (peers.has(targetUserId)) {
    getState().destroyPeer(targetUserId);
  }

  const socket = getSocket();
  if (!socket) return;

  debugLog(`${logPrefix} Creating RTCPeerConnection to ${targetUserId} (initiator: ${initiator})`);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peerConn: PeerConnection = { pc, makingOffer: false, pendingCandidates: [] };

  // Use the best available processed stream:
  // - DM P2P: suppressed stream (clean RNNoise pipeline: source → worklet → dest)
  // - SFU: gated stream (suppressed + gain gate for producer pause/resume)
  // Falls back to raw mic if neither is ready.
  const audioStream = getSuppressedStream() || getGatedStream() || localStream;
  if (audioStream) {
    audioStream.getAudioTracks().forEach((track) => {
      pc.addTrack(track, audioStream);
    });
  }

  let initialSetupDone = false;
  pc.onnegotiationneeded = async () => {
    if (!initialSetupDone) return;
    if (pc.signalingState !== 'stable') return;
    try {
      peerConn.makingOffer = true;
      const offer = await pc.createOffer();
      if (offer.sdp) offer.sdp = optimizeOpusSDP(offer.sdp);
      await pc.setLocalDescription(offer);
      if (pc.localDescription) {
        const s = getSocket();
        if (s) {
          emitSignal(s, signalEvent, {
            to: targetUserId,
            signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      }
    } catch (err) {
      console.error(`${logPrefix} onnegotiationneeded error for ${targetUserId}:`, err);
    } finally {
      peerConn.makingOffer = false;
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      emitSignal(socket, signalEvent, {
        to: targetUserId,
        signal: { type: 'ice-candidate', candidate: event.candidate.toJSON() },
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    debugLog(`${logPrefix} ICE state with ${targetUserId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.warn(`${logPrefix} ICE failed with ${targetUserId}, attempting ICE restart`);
      const existingTimer = iceRestartTimers.get(targetUserId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        iceRestartTimers.delete(targetUserId);
        const currentPeer = getState().peers.get(targetUserId);
        if (!currentPeer || currentPeer.pc !== pc) return;

        pc.createOffer({ iceRestart: true })
          .then((offer) => {
            if (offer.sdp) offer.sdp = optimizeOpusSDP(offer.sdp);
            return pc.setLocalDescription(offer);
          })
          .then(() => {
            const s = getSocket();
            if (s && pc.localDescription) {
              emitSignal(s, signalEvent, {
                to: targetUserId,
                signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
              });
            }
          })
          .catch((err) => console.error(`${logPrefix} ICE restart failed for ${targetUserId}:`, err));
      }, ICE_RESTART_DELAY_MS);
      iceRestartTimers.set(targetUserId, timer);
    }
    if (pc.iceConnectionState === 'disconnected') {
      console.warn(`${logPrefix} ICE disconnected with ${targetUserId} — waiting for recovery`);
    }
  };

  pc.onconnectionstatechange = () => {
    debugLog(`${logPrefix} Connection state with ${targetUserId}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      console.error(`${logPrefix} Connection failed permanently with ${targetUserId}`);
      getState().destroyPeer(targetUserId);
    }
  };

  pc.ontrack = (event) => {
    debugLog(`${logPrefix} Got remote track from ${targetUserId}:`, event.track.kind);
    const remoteStream = event.streams[0] || new MediaStream([event.track]);

    const currentDeaf = getState().selfDeaf;
    const currentOutputDevice = useSettingsStore.getState().audioOutputDeviceId;

    if (event.track.kind === 'video') {
      debugLog(`${logPrefix} Got screen share video track from ${targetUserId}`);
      setState({ remoteScreenStream: remoteStream });

      event.track.onended = () => {
        debugLog(`${logPrefix} Screen share video track ended from ${targetUserId}`);
        setState({ remoteScreenStream: null });
      };

      const screenAudioTracks = remoteStream.getAudioTracks();
      if (screenAudioTracks.length > 0) {
        const container = getAudioContainer();
        const screenAudioKey = `${targetUserId}-screen`;
        const { remoteAudios } = getState();
        const oldScreenAudio = remoteAudios.get(screenAudioKey);
        if (oldScreenAudio) {
          oldScreenAudio.pause();
          oldScreenAudio.srcObject = null;
          oldScreenAudio.remove();
        }

        const screenAudio = document.createElement('audio');
        screenAudio.id = `vox-audio-${screenAudioKey}`;
        screenAudio.autoplay = true;
        screenAudio.muted = currentDeaf;
        screenAudio.srcObject = remoteStream;
        container.appendChild(screenAudio);
        applyOutputDevice(screenAudio, currentOutputDevice);

        const newAudios = new Map(getState().remoteAudios);
        newAudios.set(screenAudioKey, screenAudio);
        setState({ remoteAudios: newAudios });

        screenAudio.play().catch((err) =>
          console.warn(`${logPrefix} Screen audio autoplay blocked for ${targetUserId}:`, err)
        );
      }
      return;
    }

    // Audio track = microphone stream
    const container = getAudioContainer();
    const { remoteAudios } = getState();
    const oldAudio = remoteAudios.get(targetUserId);
    if (oldAudio) {
      oldAudio.pause();
      oldAudio.srcObject = null;
      oldAudio.remove();
    }

    const audio = document.createElement('audio');
    audio.id = `vox-audio-${targetUserId}`;
    audio.autoplay = true;
    audio.muted = currentDeaf;
    audio.srcObject = remoteStream;
    container.appendChild(audio);

    applyOutputDevice(audio, currentOutputDevice);

    const newAudios = new Map(remoteAudios);
    newAudios.set(targetUserId, audio);
    setState({ remoteAudios: newAudios });

    audio.play()
      .then(() => debugLog(`${logPrefix} Audio playing for ${targetUserId}`))
      .catch((err) => console.warn(`${logPrefix} Audio autoplay blocked for ${targetUserId}:`, err));
  };

  const newPeers = new Map(peers);
  newPeers.set(targetUserId, peerConn);
  setState({ peers: newPeers });

  if (initiator) {
    peerConn.makingOffer = true;
    pc.createOffer()
      .then((offer) => {
        if (offer.sdp) offer.sdp = optimizeOpusSDP(offer.sdp);
        return pc.setLocalDescription(offer);
      })
      .then(() => {
        if (pc.localDescription) {
          debugLog(`${logPrefix} Sending offer to ${targetUserId}`);
          emitSignal(socket, signalEvent, {
            to: targetUserId,
            signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      })
      .catch((err) => console.error(`${logPrefix} Error creating offer for ${targetUserId}:`, err))
      .finally(() => { peerConn.makingOffer = false; initialSetupDone = true; });
  } else {
    initialSetupDone = true;
  }
}

/**
 * Shared signal handler for DM voice P2P.
 */
function handleSignalInternal(
  signalEvent: SignalEvent,
  logPrefix: string,
  createPeerFn: (targetUserId: string, initiator: boolean) => void,
  from: string,
  signal: unknown,
  stateAccessors: { get: () => VoiceState },
) {
  const { get: getState } = stateAccessors;
  const data = signal as { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
  debugLog(`${logPrefix} handleSignal from ${from}:`, data.type || 'ice-candidate');

  const { peers, localUserId } = getState();
  let peerConn = peers.get(from);

  if (!peerConn && data.type === 'offer') {
    debugLog(`${logPrefix} No peer for ${from}, creating responder peer`);
    createPeerFn(from, false);
    peerConn = getState().peers.get(from);
  }

  if (!peerConn) {
    if (data.type === 'ice-candidate') {
      debugLog(`${logPrefix} ICE candidate from ${from} but no peer yet, creating responder`);
      createPeerFn(from, false);
      peerConn = getState().peers.get(from);
    }
    if (!peerConn) return;
  }

  const { pc } = peerConn;

  // Apply ICE candidates queued while the remote description was still unset
  const flushPendingCandidates = () => {
    if (peerConn!.pendingCandidates.length === 0) return;
    const queued = peerConn!.pendingCandidates.splice(0);
    debugLog(`${logPrefix} Flushing ${queued.length} queued ICE candidate(s) from ${from}`);
    for (const candidate of queued) {
      pc.addIceCandidate(new RTCIceCandidate(candidate))
        .catch((err) => console.error(`${logPrefix} Error adding queued ICE candidate from ${from}:`, err));
    }
  };

  if (data.type === 'offer') {
    const offerCollision = peerConn.makingOffer || pc.signalingState !== 'stable';
    const isPolite = (localUserId ?? '') < from;

    if (offerCollision && !isPolite) {
      debugLog(`${logPrefix} Ignoring colliding offer from ${from} (we are impolite)`);
      return;
    }

    const acceptOffer = offerCollision
      ? pc.setLocalDescription({ type: 'rollback' })
          .then(() => pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp })))
      : pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));

    acceptOffer
      .then(() => {
        flushPendingCandidates();
        return pc.createAnswer();
      })
      .then((answer) => {
        if (answer.sdp) answer.sdp = optimizeOpusSDP(answer.sdp);
        return pc.setLocalDescription(answer);
      })
      .then(() => {
        const socket = getSocket();
        if (socket && pc.localDescription) {
          debugLog(`${logPrefix} Sending answer to ${from}`);
          emitSignal(socket, signalEvent, {
            to: from,
            signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      })
      .catch((err) => console.error(`${logPrefix} Error handling offer from ${from}:`, err));
  } else if (data.type === 'answer') {
    if (pc.signalingState !== 'have-local-offer') {
      debugLog(`${logPrefix} Ignoring stale answer from ${from} (state: ${pc.signalingState})`);
      return;
    }
    pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }))
      .then(flushPendingCandidates)
      .catch((err) => console.error(`${logPrefix} Error handling answer from ${from}:`, err));
  } else if (data.type === 'ice-candidate' && data.candidate) {
    // Candidates racing ahead of the offer/answer used to be dropped silently
    // (the 'remote description' error was swallowed) — queue them instead
    if (!pc.remoteDescription) {
      peerConn.pendingCandidates.push(data.candidate);
      return;
    }
    pc.addIceCandidate(new RTCIceCandidate(data.candidate))
      .catch((err) => {
        if (!String(err).includes('remote description')) {
          console.error(`${logPrefix} Error adding ICE candidate from ${from}:`, err);
        }
      });
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useVoiceStore = create<VoiceState>((set, get) => ({
  localUserId: null,
  activeChannelId: null,
  activeVoiceServerId: null,
  selfMute: initialVoicePrefs.selfMute,
  selfDeaf: initialVoicePrefs.selfDeaf,
  pttActive: false,
  localStream: null,
  latency: null,
  channelUsers: new Map(),
  channelServers: new Map(),
  peers: new Map(),
  remoteAudios: new Map(),

  // mediasoup SFU state
  msDevice: null,
  msSendTransport: null,
  msRecvTransport: null,
  msProducers: new Map(),
  msConsumers: new Map(),

  // Screen share state
  screenStream: null,
  isScreenSharing: false,
  screenSharingUserId: null,
  remoteScreenStream: null,
  screenShareViewMode: 'inline',
  screenShareFrozen: false,
  screenShareSourceKey: null,
  screenShareAnnotationsVersion: 1,

  // DM call state
  dmCallConversationId: null,
  dmCallUsers: [],
  dmCallPeerDevice: null,
  incomingCall: null,

  // Secure voice state
  secureVoicePeerIssues: {},
  secureVoiceActive: false,

  setLocalUserId: (userId: string) => set({ localUserId: userId }),

  markSecureVoicePeerExcluded: (channelId: string, userId: string, kind: string) => {
    if (get().activeChannelId !== channelId) return;
    set((state) => ({ secureVoicePeerIssues: { ...state.secureVoicePeerIssues, [userId]: kind } }));
  },

  clearSecureVoicePeerIssue: (channelId: string, userId: string) => {
    if (get().activeChannelId !== channelId) return;
    set((state) => {
      if (!(userId in state.secureVoicePeerIssues)) return state;
      const next = { ...state.secureVoicePeerIssues };
      delete next[userId];
      return { secureVoicePeerIssues: next };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SERVER VOICE (SFU)
  // ═══════════════════════════════════════════════════════════════════════════

  joinChannel: async (channelId: string, serverId?: string, opts?: { secure?: boolean; keepRetryCount?: boolean }) => {
    const socket = getSocket();
    if (!socket) return;

    // Leave DM call if active (cross-cleanup)
    if (get().dmCallConversationId) {
      get().leaveDMCall();
    }

    if (get().activeChannelId) {
      get().leaveChannel();
    }

    // Captured BEFORE any await — every await below re-checks it so a
    // concurrent leave/join supersedes this one (MED-9)
    const generation = ++voiceSessionGeneration;
    // Reset the retry counter on an EXPLICIT join only. The secure
    // transport-failure path rejoins through here, and resetting would make
    // MAX_TRANSPORT_REJOIN_ATTEMPTS unreachable — a permanently failing
    // transport would loop forever, dragging every remaining participant
    // through a rotation and a re-seal on each cycle.
    if (!opts?.keepRetryCount) transportRejoinAttempts = 0;

    // Resolve the channel record — the SECURE flag decides the whole join
    // shape. Fail closed if it cannot be resolved: joining a secure channel
    // as-if-plaintext would leak unencrypted frames (spec §21).
    //
    // Callers that ALREADY know the flag pass it: serverStore.channels holds
    // only the VIEWED server's channels, and voice deliberately survives
    // browsing elsewhere, so reconnect/transport-restart/force-move must never
    // depend on it — the lookup would fail and strand a live call.
    let secure: boolean;
    if (typeof opts?.secure === 'boolean') {
      secure = opts.secure;
    } else {
      try {
        const { useServerStore } = await import('./serverStore');
        const record = useServerStore.getState().channels.find((c) => c.id === channelId);
        if (!record) {
          console.error(`[Voice] Channel ${channelId} not in the store — refusing to join`);
          toast.error('Could not join the voice channel — try again');
          return;
        }
        secure = record.secure === true;
      } catch (err) {
        console.error('[Voice] Channel resolution failed — refusing to join:', err);
        toast.error('Could not join the voice channel — try again');
        return;
      }
      if (generation !== voiceSessionGeneration) return;
    }

    if (secure) {
      const { isSecureVoiceSupported } = await import('../services/e2e/secureVoiceKeys');
      if (!isSecureVoiceSupported()) {
        toast.error(i18n.t('secureVoice.unsupported'));
        return;
      }
      if (generation !== voiceSessionGeneration) return;
    }

    const settings = useSettingsStore.getState();
    setNoiseGateThreshold(settings.noiseGateThreshold);
    setNoiseSuppression(settings.enableNoiseSuppression);

    const stream = await acquireAudioStream();

    // Superseded while acquiring the mic (rapid channel switch / leave) —
    // release the just-acquired stream or the OS records forever
    if (generation !== voiceSessionGeneration) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }

    const { selfMute, selfDeaf } = get();
    const isPTT = settings.voiceMode === 'push_to_talk';

    if (stream) {
      // Apply RNNoise noise suppression (clean isolated pipeline)
      await applyNoiseSuppression(stream);
      // Speaking detection uses the suppressed stream (falls back to raw if suppression unavailable)
      startSpeakingDetection(getSuppressedStream() || stream);

      // Pause/resume audio producer based on noise gate speaking detection
      onSpeakingChange((speaking) => {
        const state = get();
        if (state.selfMute) return; // stay paused if muted
        for (const producer of state.msProducers.values()) {
          if (producer.kind === 'audio' && (producer.appData as Record<string, unknown>)?.type === 'audio') {
            if (speaking) { producer.resume(); } else { producer.pause(); }
          }
        }
      });

      if (isPTT) {
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      } else {
        if (selfMute) {
          stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        }
      }
    }

    const effectiveMute = stream ? selfMute : true;
    const serverMute = isPTT ? true : effectiveMute;

    // Secure channels: the E2E media session MUST exist before voice:join —
    // key 0 is minted, the frame worker is live, and our deviceId is
    // announced with the join. Any failure aborts (no plaintext fallback).
    let joinDeviceId: string | undefined;
    let joinEpoch: string | undefined;
    if (secure) {
      try {
        // First-join-after-launch can race E2E init (the DM-call precedent)
        const { useE2EStore } = await import('./e2eStore');
        const { useAuthStore } = await import('./authStore');
        const me = useAuthStore.getState().user;
        if (me && !useE2EStore.getState().ready) {
          useE2EStore.getState().initialize(me.id).catch((err) => {
            console.warn('[SecureVoice] E2E init kick failed (store records the error):', err);
          });
          await waitForE2EReady(10_000);
        }
        const { beginSecureVoiceSession, endSecureVoiceSessionFor } = await import('../services/e2e/secureVoiceKeys');
        const { frames, deviceId, epoch } = await beginSecureVoiceSession(channelId, {
          isCurrent: () => generation === voiceSessionGeneration,
        });
        if (generation !== voiceSessionGeneration) {
          // End the SESSION, not just the worker: begin() registered it with a
          // live media key, and only the session teardown zeroes that key and
          // stops the timers. Identity-scoped so a superseded join can never
          // tear down a newer session registered under the same channel.
          endSecureVoiceSessionFor(channelId, frames);
          stream?.getTracks().forEach((track) => track.stop());
          return;
        }
        secureVoiceFrames = frames;
        secureVoiceChannelId = channelId;
        frames.onFatal(() => {
          // Only the LIVE session may tear down the call: a worker error
          // queued before teardown must not kick the user out of whatever
          // channel they joined next.
          if (secureVoiceFrames !== frames) return;
          console.error('[SecureVoice] Frame-crypto failure — leaving voice (fail closed)');
          toast.error(i18n.t('secureVoice.sessionFailed'));
          get().leaveChannel();
        });
        joinDeviceId = deviceId;
        joinEpoch = epoch;
      } catch (err) {
        // Only this join's own stream is safe to touch before the supersession
        // check. The audio pipelines are module-level SINGLETONS shared by
        // whatever call is now live: tearing them down here would close the
        // WINNER's speaking-detection context — the very stream its producer
        // was created from — leaving a connected-looking call transmitting
        // silence with no detector left to resume it.
        stream?.getTracks().forEach((track) => track.stop());
        // Superseded by a newer join/leave — not a failure, and the winner owns
        // the UI (and the audio pipelines) from here.
        if (generation !== voiceSessionGeneration) return;
        stopSpeakingDetection();
        stopNoiseSuppression();
        console.error('[SecureVoice] Could not start the E2E media session — join aborted:', err);
        toast.error(i18n.t('secureVoice.cantJoin'));
        return;
      }
    }

    set({ activeChannelId: channelId, activeVoiceServerId: serverId ?? null, localStream: stream, selfMute: effectiveMute, secureVoicePeerIssues: {}, secureVoiceActive: secure });

    // Emit voice:join — server will respond with voice:transport_created
    socket.emit('voice:join', channelId, { selfMute: serverMute, selfDeaf, ...(joinDeviceId && { deviceId: joinDeviceId }), ...(joinEpoch && { epoch: joinEpoch }) });

    get().startLatencyMeasurement();
  },

  leaveChannel: () => {
    voiceSessionGeneration++; // cancel any in-flight join's mic acquisition
    const socket = getSocket();
    const { localStream, activeChannelId, localUserId } = get();

    // Stop screen sharing before leaving
    if (get().isScreenSharing) {
      get().stopScreenShare();
    }

    get().stopLatencyMeasurement();
    onSpeakingChange(null);
    stopSpeakingDetection();
    stopNoiseSuppression();

    // Immediately remove local user from channelUsers
    if (activeChannelId && localUserId) {
      get().removeUserFromChannel(activeChannelId, localUserId);
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }

    // Clean up SFU resources
    get().cleanupSFU();

    // Secure voice: the media keys die with the session (fresh key + epoch on
    // any rejoin — the IV-reuse firewall, spec §21)
    teardownSecureVoice();

    if (socket) {
      socket.emit('voice:leave');
    }

    set({
      activeChannelId: null,
      activeVoiceServerId: null,
      localStream: null,
      latency: null,
      pttActive: false,
      screenStream: null,
      isScreenSharing: false,
      screenSharingUserId: null,
      remoteScreenStream: null,
      secureVoicePeerIssues: {},
      secureVoiceActive: false,
    });
  },

  // ── mediasoup SFU handlers ─────────────────────────────────────────────

  handleTransportCreated: async (data) => {
    const { localStream, activeChannelId, selfMute } = get();
    if (!activeChannelId) return;

    const socket = getSocket();
    if (!socket) return;

    try {
      // 1. Create and load Device
      const device = new Device();
      await device.load({ routerRtpCapabilities: data.routerRtpCapabilities as RtpCapabilities });

      // Bail if user left during async load
      if (!get().activeChannelId) { return; }

      // Secure voice: the legacy Chromium transform path (createEncodedStreams)
      // requires encodedInsertableStreams on the RTCPeerConnection. Harmless
      // where the RTCRtpScriptTransform path is used instead.
      const secureExtras = activeSecureVoiceSession(get().activeChannelId)
        ? { additionalSettings: { encodedInsertableStreams: true } as RTCConfiguration }
        : {};

      // 2. Create send transport
      const sendTransport = device.createSendTransport({
        id: data.sendTransport.id,
        iceParameters: data.sendTransport.iceParameters as IceParameters,
        iceCandidates: data.sendTransport.iceCandidates as IceCandidate[],
        dtlsParameters: data.sendTransport.dtlsParameters as DtlsParameters,
        ...secureExtras,
      });

      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        const s = getSocket();
        if (s) {
          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              console.error('[Voice SFU] Send transport connect ACK timed out');
              toast.error('Voice connection timed out — try rejoining');
              errback(new Error('Transport connect timeout'));
            }
          }, 10000);
          s.emit('voice:transport:connect', { transportId: sendTransport.id, dtlsParameters }, (response: { error?: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (response.error) {
              console.error('[Voice SFU] Send transport DTLS connect failed:', response.error);
              toast.error('Voice connection failed — try rejoining');
              errback(new Error(response.error));
            } else {
              callback();
            }
          });
        } else {
          errback(new Error('Socket not available'));
        }
      });

      sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        const s = getSocket();
        if (!s) {
          errback(new Error('Socket not available'));
          return;
        }
        // The server ACKs every voice:produce path (success or error). The timeout
        // is a second line of defense — without it, a lost ACK would hang produce()
        // forever and wedge the whole send transport.
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          console.error('[Voice SFU] voice:produce ACK timed out');
          errback(new Error('voice:produce ACK timeout'));
        }, 10000);
        s.emit('voice:produce', { kind, rtpParameters, appData }, (response: { producerId?: string; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (!response?.producerId) {
            console.error('[Voice SFU] voice:produce rejected:', response?.error);
            errback(new Error(response?.error || 'Producer creation failed'));
          } else {
            callback({ id: response.producerId });
          }
        });
      });

      // 3. Create recv transport
      const recvTransport = device.createRecvTransport({
        id: data.recvTransport.id,
        iceParameters: data.recvTransport.iceParameters as IceParameters,
        iceCandidates: data.recvTransport.iceCandidates as IceCandidate[],
        dtlsParameters: data.recvTransport.dtlsParameters as DtlsParameters,
        ...secureExtras,
      });

      recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        const s = getSocket();
        if (s) {
          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              console.error('[Voice SFU] Recv transport connect ACK timed out');
              errback(new Error('Transport connect timeout'));
            }
          }, 10000);
          s.emit('voice:transport:connect', { transportId: recvTransport.id, dtlsParameters }, (response: { error?: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (response.error) {
              console.error('[Voice SFU] Recv transport DTLS connect failed:', response.error);
              errback(new Error(response.error));
            } else {
              callback();
            }
          });
        } else {
          errback(new Error('Socket not available'));
        }
      });

      // Monitor transport connection states for failure detection + auto-rejoin.
      // Guard: both send+recv transports share this handler — if both fire 'failed'
      // simultaneously, the flag prevents a double-rejoin race.
      let transportFailureHandled = false;
      const addTransportStateMonitoring = (transport: Transport, label: string) => {
        transport.on('connectionstatechange', (state: string) => {
          debugLog(`[Voice SFU] ${label} transport state: ${state}`);
          if (state === 'failed') {
            console.error(`[Voice SFU] ${label} transport DTLS connection failed`);
            if (transportFailureHandled) return;
            transportFailureHandled = true;

            // Auto-rejoin with retry limit to prevent infinite loops
            const currentChannelId = get().activeChannelId;
            const currentServerId = get().activeVoiceServerId;
            if (currentChannelId && transportRejoinAttempts < MAX_TRANSPORT_REJOIN_ATTEMPTS) {
              transportRejoinAttempts++;
              toast.error(`Voice connection lost — reconnecting (attempt ${transportRejoinAttempts}/${MAX_TRANSPORT_REJOIN_ATTEMPTS})...`);
              // Screen share cannot survive the rejoin — release the capture stream
              // and clear state so the share button doesn't stay stuck "on"
              const { screenStream: staleScreenStream } = get();
              if (staleScreenStream) {
                staleScreenStream.getTracks().forEach((t) => t.stop());
              }
              set({ screenStream: null, isScreenSharing: false, screenSharingUserId: null });
              get().cleanupSFU();
              // Secure voice: a transport restart is a SESSION restart — the
              // full join path re-begins with a fresh key + epoch (IV-reuse
              // firewall). Plaintext channels keep the light re-emit.
              if (activeSecureVoiceSession(currentChannelId)) {
                void get().joinChannel(currentChannelId, currentServerId ?? undefined, { secure: true, keepRetryCount: true });
                return;
              }
              const s = getSocket();
              if (s) {
                const { selfMute: m, selfDeaf: d } = get();
                const isPTT = useSettingsStore.getState().voiceMode === 'push_to_talk';
                s.emit('voice:join', currentChannelId, { selfMute: isPTT ? true : m, selfDeaf: d });
                set({ activeChannelId: currentChannelId, activeVoiceServerId: currentServerId });
              }
            } else if (currentChannelId) {
              toast.error('Voice connection failed — please rejoin manually');
              get().leaveChannel();
            }
          } else if (state === 'connected') {
            // Reset retry counter on successful connection
            transportRejoinAttempts = 0;
          } else if (state === 'disconnected') {
            console.warn(`[Voice SFU] ${label} transport disconnected — may self-recover via ICE`);
          }
        });
      };

      addTransportStateMonitoring(sendTransport, 'Send');
      addTransportStateMonitoring(recvTransport, 'Recv');

      set({
        msDevice: device,
        msSendTransport: sendTransport,
        msRecvTransport: recvTransport,
      });

      // 4. Tell the server our RTP capabilities so it can create consumers
      socket.emit('voice:rtp_capabilities', { rtpCapabilities: device.rtpCapabilities });

      // 5. Produce audio if we have a mic stream
      // Re-check: user may have left during transport setup
      if (!get().activeChannelId) { return; }
      const audioTrack = (getGatedStream() || localStream)?.getAudioTracks()[0];
      if (audioTrack && device.canProduce('audio')) {
        const voiceQuality = useSettingsStore.getState().voiceQuality;
        const maxBitrate = VOICE_QUALITY_BITRATE[voiceQuality];
        // Secure voice: install the encrypt transform on the RTCRtpSender the
        // moment it exists (before negotiation). If the attach fails, NOTHING
        // may be produced — fail the whole join closed (spec §21).
        const secureSession = activeSecureVoiceSession(get().activeChannelId);
        let attachError: unknown = null;
        let attachInvoked = false;
        const producer = await sendTransport.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: false,
            opusDtx: true,
            opusFec: true,
            opusMaxPlaybackRate: 48000,
          },
          encodings: [{ maxBitrate }],
          appData: { type: 'audio' },
          ...(secureSession && {
            onRtpSender: (rtpSender: RTCRtpSender) => {
              attachInvoked = true;
              try {
                secureSession.attachSender(rtpSender);
              } catch (err) {
                attachError = err;
              }
            },
          }),
        });

        if (secureSession && (attachError !== null || !attachInvoked)) {
          console.error('[SecureVoice] Encrypt transform attach failed — leaving voice:', attachError ?? 'onRtpSender never fired');
          producer.close();
          toast.error(i18n.t('secureVoice.sessionFailed'));
          get().leaveChannel();
          return;
        }

        const newProducers = new Map(get().msProducers);
        newProducers.set(producer.id, producer);
        set({ msProducers: newProducers });

        // If muted, pause the producer client-side too
        if (selfMute) {
          producer.pause();
        }

        debugLog('[Voice SFU] Audio producer created:', producer.id);
      }
    } catch (err) {
      console.error('[Voice SFU] Failed to set up mediasoup:', err);
      toast.error('Failed to establish voice connection');
    }
  },

  handleNewConsumer: async (data) => {
    const { msRecvTransport, selfDeaf, activeChannelId } = get();
    if (!msRecvTransport || !activeChannelId) return;

    // Secure voice is audio-only (spec §21) and every consumer MUST decrypt
    // through the frame worker — a consumer without the transform would play
    // ciphertext as audio. Defense in depth on top of the server rejection.
    const secureSession = activeSecureVoiceSession(activeChannelId);
    if (secureSession) {
      const claimedType = (data.appData?.type as string) ?? 'audio';
      if (data.kind !== 'audio' || claimedType !== 'audio') {
        console.warn('[SecureVoice] Refusing non-audio consumer in a secure channel:', claimedType);
        return;
      }
    }

    try {
      let attachError: unknown = null;
      let attachInvoked = false;
      const consumer = await msRecvTransport.consume({
        id: data.id,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters as RtpParameters,
        ...(secureSession && {
          onRtpReceiver: (rtpReceiver: RTCRtpReceiver) => {
            attachInvoked = true;
            try {
              secureSession.attachReceiver(rtpReceiver, data.producerUserId);
            } catch (err) {
              attachError = err;
            }
          },
        }),
      });

      if (secureSession && (attachError !== null || !attachInvoked)) {
        console.error('[SecureVoice] Decrypt transform attach failed — dropping consumer:', attachError ?? 'onRtpReceiver never fired');
        consumer.close();
        return;
      }

      // Route by the server-derived appData.type, NOT by kind: screen audio
      // arrives as kind 'audio' — treating it as mic audio would clobber the
      // sharer's mic <audio> element and survive deafen incorrectly.
      const appType = (data.appData?.type as string)
        ?? (data.kind === 'video' ? 'screen-video' : 'audio');

      const newConsumers = new Map(get().msConsumers);
      newConsumers.set(consumer.id, { consumer, producerUserId: data.producerUserId, appType });
      set({ msConsumers: newConsumers });

      const outputDeviceId = useSettingsStore.getState().audioOutputDeviceId;

      if (appType === 'screen-video') {
        // Screen share video track
        const stream = new MediaStream([consumer.track]);
        set({ remoteScreenStream: stream });

        consumer.track.onended = () => {
          set({ remoteScreenStream: null, screenSharingUserId: null });
        };
      } else {
        // Mic audio or screen audio — separate element keys so they never collide
        const audioKey = appType === 'screen-audio'
          ? `${data.producerUserId}-screen`
          : data.producerUserId;
        const container = getAudioContainer();
        const oldAudio = get().remoteAudios.get(audioKey);
        if (oldAudio) {
          oldAudio.pause();
          oldAudio.srcObject = null;
          oldAudio.remove();
        }
        const audio = document.createElement('audio');
        audio.id = `vox-sfu-audio-${audioKey}`;
        audio.autoplay = true;
        audio.muted = selfDeaf;
        audio.srcObject = new MediaStream([consumer.track]);
        container.appendChild(audio);
        applyOutputDevice(audio, outputDeviceId);

        const newAudios = new Map(get().remoteAudios);
        newAudios.set(audioKey, audio);
        set({ remoteAudios: newAudios });

        audio.play().catch((err) =>
          console.warn('[Voice SFU] Audio autoplay blocked for', audioKey, err)
        );
      }

      // Resume the consumer on the server
      const socket = getSocket();
      if (socket) {
        socket.emit('voice:consumer:resume', { consumerId: consumer.id });

        // Retry resume after 2s if consumer is still paused (handles lost events)
        if (data.kind === 'audio') {
          const consumerId = consumer.id;
          setTimeout(() => {
            const entry = get().msConsumers.get(consumerId);
            if (entry && entry.consumer.paused) {
              debugLog('[Voice SFU] Consumer still paused after 2s, retrying resume:', consumerId);
              const s = getSocket();
              if (s) s.emit('voice:consumer:resume', { consumerId });
            }
          }, 2000);
        }
      }

      debugLog('[Voice SFU] Consumer created:', consumer.id, data.kind, 'from', data.producerUserId);
    } catch (err) {
      console.error('[Voice SFU] Failed to consume:', err);
    }
  },

  handleProducerClosed: (data) => {
    const { msConsumers } = get();
    const entry = msConsumers.get(data.consumerId);
    if (!entry) return;

    entry.consumer.close();

    const newConsumers = new Map(msConsumers);
    newConsumers.delete(data.consumerId);
    set({ msConsumers: newConsumers });

    // Clean up ONLY the resource this specific consumer fed. Screen producers
    // close on every share-stop — indiscriminately removing everything keyed by
    // producerUserId would delete the sharer's MIC element and mute them for
    // the rest of the call.
    if (entry.appType === 'screen-video') {
      set({ remoteScreenStream: null });
    } else {
      const audioKey = entry.appType === 'screen-audio'
        ? `${data.producerUserId}-screen`
        : data.producerUserId;
      const audio = get().remoteAudios.get(audioKey);
      if (audio) {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
        const newAudios = new Map(get().remoteAudios);
        newAudios.delete(audioKey);
        set({ remoteAudios: newAudios });
      }
    }

    debugLog('[Voice SFU] Producer closed, consumer removed:', data.consumerId, entry.appType);
  },

  cleanupSFU: () => {
    const { msProducers, msConsumers, msSendTransport, msRecvTransport, remoteAudios } = get();

    // Close all producers
    for (const producer of msProducers.values()) {
      if (!producer.closed) producer.close();
    }

    // Close all consumers
    for (const { consumer } of msConsumers.values()) {
      if (!consumer.closed) consumer.close();
    }

    // Close transports
    if (msSendTransport && !msSendTransport.closed) msSendTransport.close();
    if (msRecvTransport && !msRecvTransport.closed) msRecvTransport.close();

    // Clean up audio elements
    remoteAudios.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    });
    const container = document.getElementById('vox-audio-container');
    if (container) container.innerHTML = '';

    set({
      msDevice: null,
      msSendTransport: null,
      msRecvTransport: null,
      msProducers: new Map(),
      msConsumers: new Map(),
      remoteAudios: new Map(),
      remoteScreenStream: null,
    });
  },

  // ── Channel user state (unchanged) ─────────────────────────────────────

  setChannelUsers: (channelId: string, users: VoiceUser[], serverId?: string) => {
    debugLog('[Voice] setChannelUsers:', channelId, users.length, 'users');
    set((state) => {
      const newMap = new Map(state.channelUsers);
      newMap.set(channelId, users);
      const serverFix = serverId && state.channelServers.get(channelId) !== serverId
        ? { channelServers: new Map(state.channelServers).set(channelId, serverId) }
        : {};
      // If the screen sharer is no longer in the channel, clear the stale reference
      const sharerGone = state.screenSharingUserId
        && channelId === state.activeChannelId
        && !users.some((u) => u.id === state.screenSharingUserId);
      const screenFix = sharerGone
        ? { screenSharingUserId: null, remoteScreenStream: null } as const
        : {};
      return { channelUsers: newMap, ...serverFix, ...screenFix };
    });
    // No peer creation needed — SFU handles media routing via consumers

    // Secure voice: the initial replay lists the occupants present at OUR
    // join — vet each and seal our CURRENT key (no ratchet; spec §21).
    if (activeSecureVoiceSession(channelId)) {
      const selfId = get().localUserId;
      void import('../services/e2e/secureVoiceKeys').then((m) => {
        for (const u of users) {
          if (u.id !== selfId) m.onParticipantJoined(channelId, u, { initialReplay: true });
        }
      }).catch((err) => console.error('[SecureVoice] Initial participant keying failed:', err));
    }
  },

  addUserToChannel: (channelId: string, user: VoiceUser, serverId?: string) => {
    debugLog('[Voice] addUserToChannel:', channelId, user.displayName);

    const existing = get().channelUsers.get(channelId) || [];
    const listed = existing.find((u) => u.id === user.id);
    // A duplicate announcement is only a duplicate if it announces the SAME
    // E2E session. A peer that reconnected announces a new deviceId/epoch, and
    // dropping that here would strand the secure session: their re-pin never
    // runs, so every key they seal from now on fails the epoch binding and the
    // pair goes permanently silent. (Ghost list entries survive a missed
    // voice:user_left and an owner-node takeover, so this is reachable.)
    if (listed && listed.deviceId === user.deviceId && listed.epoch === user.epoch) return;

    set((state) => {
      const newMap = new Map(state.channelUsers);
      const current = newMap.get(channelId) || [];
      const idx = current.findIndex((u) => u.id === user.id);
      if (idx !== -1) {
        const next = [...current];
        next[idx] = user; // refresh the stale announcement
        newMap.set(channelId, next);
      } else {
        newMap.set(channelId, [...current, user]);
      }
      const serverFix = serverId && state.channelServers.get(channelId) !== serverId
        ? { channelServers: new Map(state.channelServers).set(channelId, serverId) }
        : {};
      return { channelUsers: newMap, ...serverFix };
    });
    // No peer creation needed — SFU creates consumers server-side

    // Secure voice: a genuine ARRIVAL ratchets our key forward so the joiner
    // never decrypts past audio (spec §21). Self echo is skipped.
    if (user.id !== get().localUserId && activeSecureVoiceSession(channelId)) {
      void import('../services/e2e/secureVoiceKeys')
        .then((m) => m.onParticipantJoined(channelId, user, { initialReplay: false }))
        .catch((err) => console.error('[SecureVoice] Arrival keying failed:', err));
    }
  },

  removeUserFromChannel: (channelId: string, userId: string) => {
    debugLog('[Voice] removeUserFromChannel:', channelId, userId);

    set((state) => {
      const newMap = new Map(state.channelUsers);
      const existing = newMap.get(channelId) || [];
      const filtered = existing.filter((u) => u.id !== userId);
      if (filtered.length === 0) {
        newMap.delete(channelId);
      } else {
        newMap.set(channelId, filtered);
      }
      // If the departing user was screen sharing, clear the stale reference
      const screenFix = state.screenSharingUserId === userId
        ? { screenSharingUserId: null, remoteScreenStream: null } as const
        : {};
      return { channelUsers: newMap, ...screenFix };
    });

    // Secure voice: a departure means a FRESH key for everyone remaining —
    // the leaver must not decrypt future audio (spec §21).
    if (userId !== get().localUserId && activeSecureVoiceSession(channelId)) {
      void import('../services/e2e/secureVoiceKeys')
        .then((m) => m.onParticipantLeft(channelId, userId))
        .catch((err) => console.error('[SecureVoice] Departure rotation failed:', err));
    }
  },

  updateUserState: (channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean, serverMuted: boolean, serverDeafened: boolean) => {
    const { localUserId } = get();

    // Capture the previous entry BEFORE updating the map — the un-deafen path
    // below must distinguish a lifted server-deafen from a plain self-deafen.
    const prevSelf = userId === localUserId
      ? (get().channelUsers.get(channelId) || []).find((u) => u.id === userId)
      : undefined;

    set((state) => {
      const newMap = new Map(state.channelUsers);
      const existing = newMap.get(channelId) || [];
      newMap.set(channelId, existing.map((u) =>
        u.id === userId ? { ...u, selfMute, selfDeaf, serverMuted, serverDeafened } : u
      ));
      return { channelUsers: newMap };
    });

    // If WE were server-muted/deafened, update local state + mute audio
    if (userId === localUserId) {
      if (serverMuted && !get().selfMute) {
        // Force our local mute state on — pause the mic producer
        for (const producer of get().msProducers.values()) {
          if (isMicProducer(producer)) producer.pause();
        }
        set({ selfMute: true });
      }
      if (serverDeafened && !get().selfDeaf) {
        // Force our local deaf state on — mute all remote audio elements.
        // Iterate the store's remoteAudios map (same as toggleDeaf); the old
        // `audio[data-voice-remote]` selector matched nothing, so server-deafen
        // was never enforced client-side.
        get().remoteAudios.forEach((audio) => { audio.muted = true; });
        set({ selfDeaf: true });
      }
      if (!serverDeafened && prevSelf?.serverDeafened && get().selfDeaf) {
        // The moderator lifted our server-deafen — restore hearing. The forced
        // deafen muted every remote element and set selfDeaf, and toggleDeaf is
        // blocked while serverDeafened, so without this symmetric release the
        // user would stay silenced after being un-deafened.
        get().remoteAudios.forEach((audio) => { audio.muted = false; });
        set({ selfDeaf: false });
      }
    }
  },

  handleForceMove: (targetChannelId: string) => {
    const { activeChannelId, activeVoiceServerId } = get();
    if (!activeChannelId || !activeVoiceServerId) return;
    // Leave current channel and join the target one
    get().leaveChannel();
    // Small delay to let cleanup complete before rejoining. The target is
    // always plaintext — the server refuses force-move into (or out of) a
    // secure channel — so state this rather than looking it up: the moved user
    // may be browsing another server, whose channel list would not contain it.
    setTimeout(() => {
      get().joinChannel(targetChannelId, activeVoiceServerId, { secure: false });
    }, 300);
  },

  serverMuteUser: (targetUserId: string, muted: boolean) => {
    const socket = getSocket();
    if (socket) socket.emit('voice:server_mute', { userId: targetUserId, muted });
  },

  serverDeafenUser: (targetUserId: string, deafened: boolean) => {
    const socket = getSocket();
    if (socket) socket.emit('voice:server_deafen', { userId: targetUserId, deafened });
  },

  forceMoveUser: (targetUserId: string, targetChannelId: string) => {
    const socket = getSocket();
    if (socket) socket.emit('voice:force_move', { userId: targetUserId, targetChannelId });
  },

  setUserSpeaking: (channelId: string, userId: string, speaking: boolean) => {
    set((state) => {
      const newMap = new Map(state.channelUsers);
      const existing = newMap.get(channelId) || [];
      newMap.set(channelId, existing.map((u) =>
        u.id === userId ? { ...u, speaking } : u
      ));
      return { channelUsers: newMap };
    });
  },

  // These are kept for backward compat but are no-ops for server voice now
  handleSignal: () => {},
  createPeer: () => {},

  toggleMute: () => {
    const socket = getSocket();
    const { selfMute, localStream, msProducers, activeChannelId, dmCallConversationId, localUserId, channelUsers } = get();
    const newMute = !selfMute;

    // If trying to unmute but server-muted, block it
    if (!newMute && activeChannelId && localUserId) {
      const users = channelUsers.get(activeChannelId) || [];
      const me = users.find((u) => u.id === localUserId);
      if (me?.serverMuted) {
        toast.warning('You have been muted by a moderator');
        return;
      }
    }
    const isPTT = useSettingsStore.getState().voiceMode === 'push_to_talk';

    if (localStream) {
      if (isPTT) {
        if (newMute) {
          localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
        }
      } else {
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = !newMute;
        });
      }
    }

    // Pause/resume the mediasoup MIC producer (server voice) — screen-share
    // system audio is independent of mute
    if (activeChannelId) {
      for (const producer of msProducers.values()) {
        if (isMicProducer(producer)) {
          if (newMute) { producer.pause(); } else { producer.resume(); }
        }
      }
    }

    if (socket) {
      if (activeChannelId) {
        socket.emit('voice:mute', newMute);
      } else if (dmCallConversationId) {
        socket.emit('dm:voice:mute', newMute);
      }
    }

    set({ selfMute: newMute });
    persistVoicePrefs({ selfMute: newMute, selfDeaf: get().selfDeaf });

    // Pause speaking detection processing when muted to save CPU
    setSpeakingDetectionPaused(newMute);
  },

  toggleDeaf: () => {
    const socket = getSocket();
    const { selfDeaf, remoteAudios, activeChannelId, localUserId, channelUsers } = get();
    const newDeaf = !selfDeaf;

    // If trying to undeafen but server-deafened, block it
    if (!newDeaf && activeChannelId && localUserId) {
      const users = channelUsers.get(activeChannelId) || [];
      const me = users.find((u) => u.id === localUserId);
      if (me?.serverDeafened) {
        toast.warning('You have been deafened by a moderator');
        return;
      }
    }

    remoteAudios.forEach((audio) => {
      audio.muted = newDeaf;
    });

    // Deafen implies mute — if deafening and not already muted, also mute
    const { selfMute, msProducers, localStream } = get();
    if (newDeaf && !selfMute) {
      // Pause the mic producer (screen audio unaffected)
      if (get().activeChannelId) {
        for (const producer of msProducers.values()) {
          if (isMicProducer(producer)) producer.pause();
        }
      }
      if (localStream) {
        localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
      }
      set({ selfMute: true });
      // Same as toggleMute: stop speaking detection so the indicator can't stick
      setSpeakingDetectionPaused(true);
    }

    if (socket) {
      if (get().activeChannelId) {
        socket.emit('voice:deaf', newDeaf);
      } else if (get().dmCallConversationId) {
        socket.emit('dm:voice:deaf', newDeaf);
      }
    }

    set({ selfDeaf: newDeaf });
    persistVoicePrefs({ selfMute: get().selfMute, selfDeaf: newDeaf });
  },

  startLatencyMeasurement: () => {
    get().stopLatencyMeasurement();

    const socket = getSocket();
    if (!socket) return;

    pongHandler = (timestamp: number) => {
      const rtt = Date.now() - timestamp;
      set({ latency: rtt });
    };
    socket.on('pong:latency', pongHandler);

    socket.emit('ping:latency', Date.now());

    latencyInterval = setInterval(() => {
      const s = getSocket();
      if (s?.connected) s.emit('ping:latency', Date.now());
    }, 5000);
  },

  stopLatencyMeasurement: () => {
    if (latencyInterval !== null) {
      clearInterval(latencyInterval);
      latencyInterval = null;
    }
    if (pongHandler) {
      const socket = getSocket();
      if (socket) socket.off('pong:latency', pongHandler);
      pongHandler = null;
    }
    set({ latency: null });
  },

  destroyPeer: (userId: string) => {
    const { peers, remoteAudios } = get();

    const restartTimer = iceRestartTimers.get(userId);
    if (restartTimer) {
      clearTimeout(restartTimer);
      iceRestartTimers.delete(userId);
    }

    const peerConn = peers.get(userId);
    if (peerConn) {
      peerConn.pc.onicecandidate = null;
      peerConn.pc.oniceconnectionstatechange = null;
      peerConn.pc.onconnectionstatechange = null;
      peerConn.pc.ontrack = null;
      peerConn.pc.close();
      const newPeers = new Map(peers);
      newPeers.delete(userId);
      set({ peers: newPeers });
    }

    const newAudios = new Map(remoteAudios);
    const audio = remoteAudios.get(userId);
    if (audio) {
      // Stop tracks to release OS-level audio resources
      if (audio.srcObject && typeof (audio.srcObject as MediaStream).getTracks === 'function') {
        (audio.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
      }
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      newAudios.delete(userId);
    }
    const screenAudio = remoteAudios.get(`${userId}-screen`);
    if (screenAudio) {
      if (screenAudio.srcObject && typeof (screenAudio.srcObject as MediaStream).getTracks === 'function') {
        (screenAudio.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
      }
      screenAudio.pause();
      screenAudio.srcObject = null;
      screenAudio.remove();
      newAudios.delete(`${userId}-screen`);
    }
    set({ remoteAudios: newAudios });

    currentScreenSenders.delete(userId);

    if (get().screenSharingUserId === userId) {
      set({ remoteScreenStream: null });
    }
  },

  destroyAllPeers: () => {
    const { peers, remoteAudios } = get();

    iceRestartTimers.forEach((timer) => clearTimeout(timer));
    iceRestartTimers.clear();

    peers.forEach((peerConn) => {
      peerConn.pc.onicecandidate = null;
      peerConn.pc.oniceconnectionstatechange = null;
      peerConn.pc.onconnectionstatechange = null;
      peerConn.pc.ontrack = null;
      peerConn.pc.close();
    });
    remoteAudios.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    });
    const container = document.getElementById('vox-audio-container');
    if (container) container.innerHTML = '';
    currentScreenSenders.clear();
    set({ peers: new Map(), remoteAudios: new Map(), remoteScreenStream: null });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SCREEN SHARE (via SFU)
  // ═══════════════════════════════════════════════════════════════════════════

  startScreenShare: async () => {
    const socket = getSocket();
    const { activeChannelId, msSendTransport, msDevice, isScreenSharing, screenStream } = get();
    if (!socket || !activeChannelId || !msSendTransport || !msDevice) return;

    // If stale state says we're sharing but the stream is dead, clean up before proceeding
    if (isScreenSharing) {
      const alive = screenStream?.getVideoTracks().some((t) => t.readyState === 'live');
      if (!alive) {
        // Tell server to clear stale screen share entry before we start a new one
        get().stopScreenShare();
      } else {
        return; // genuinely still sharing
      }
    }

    let stream: MediaStream | null = null;
    const createdProducers: Producer[] = [];
    let claimedSlot = false;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });

      // Claim the sharer slot BEFORE producing — the server authorizes
      // screen-video/screen-audio producers only for the active sharer.
      const startResponse = await new Promise<{ ok: boolean; error?: string; annotationsVersion?: number }>((resolve) => {
        const timeout = setTimeout(
          () => resolve({ ok: false, error: 'Server did not respond' }),
          5000,
        );
        socket.emit('voice:screen_share:start', (response: { ok: boolean; error?: string; annotationsVersion?: number }) => {
          clearTimeout(timeout);
          resolve(response ?? { ok: false, error: 'No response from server' });
        });
      });
      if (!startResponse.ok) {
        throw new Error(startResponse.error || 'Screen share rejected by server');
      }
      claimedSlot = true;

      // Bail if we left voice while awaiting the slot claim
      if (!get().activeChannelId) {
        throw new Error('Left voice channel during screen share setup');
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || !msDevice.canProduce('video')) {
        throw new Error('Cannot produce screen video');
      }

      // 'detail' prioritizes resolution/sharpness over frame rate — right for
      // desktop content. Without encodings the producer gets a default bitrate
      // far too low for 1080p, leaving viewers in permanent blur.
      videoTrack.contentHint = 'detail';
      // stopTracks:false — mediasoup must NOT own the capture track's lifecycle:
      // its default replaceTrack() behavior STOPS the old track, which would
      // kill the raw capture the mask compositor reads from (stopScreenShare
      // stops screenStream tracks explicitly). disableTrackOnPause:false +
      // zeroRtpOnPause:true — the compositor's fail-closed pause must suppress
      // RTP at the sender WITHOUT disabling the shared raw track (a disabled
      // track delivers black frames to the compositor's source video).
      const videoProducer = await msSendTransport.produce({
        track: videoTrack,
        encodings: [{ maxBitrate: SCREEN_SHARE_MAX_BITRATE }],
        codecOptions: { videoGoogleStartBitrate: 1000 },
        stopTracks: false,
        disableTrackOnPause: false,
        zeroRtpOnPause: true,
        appData: { type: 'screen-video' },
      });
      createdProducers.push(videoProducer);
      {
        const newProducers = new Map(get().msProducers);
        newProducers.set(videoProducer.id, videoProducer);
        set({ msProducers: newProducers });
      }
      videoTrack.onended = () => {
        get().stopScreenShare();
      };

      // Produce system audio if available (never mute/silence-paused — it is
      // independent of the mic; muted and PTT sharers still transmit game audio)
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const audioProducer = await msSendTransport.produce({
          track: audioTrack,
          appData: { type: 'screen-audio' },
        });
        createdProducers.push(audioProducer);
        const newProducers = new Map(get().msProducers);
        newProducers.set(audioProducer.id, audioProducer);
        set({ msProducers: newProducers });
      }

      set({
        screenStream: stream,
        isScreenSharing: true,
        // The source identity for remembered mask layouts (displaySurface is
        // not yet in TS's MediaTrackSettings everywhere)
        screenShareSourceKey: sourceKeyFromSettings(videoTrack.getSettings() as { displaySurface?: string; width?: number; height?: number }),
        screenShareAnnotationsVersion: typeof startResponse.annotationsVersion === 'number' ? startResponse.annotationsVersion : 1,
      });
    } catch (err) {
      console.warn('[Voice] Screen share cancelled or failed:', err);
      // Roll back everything: close half-created producers on BOTH sides,
      // release the capture stream (clears the OS capture indicator), and
      // free the sharer slot on the server.
      const s = getSocket();
      teardownComposite(); // defensive — masks can't exist pre-produce, but a stray loop must die
      const producers = new Map(get().msProducers);
      for (const producer of createdProducers) {
        if (s) s.emit('voice:producer:close', { producerId: producer.id });
        if (!producer.closed) producer.close();
        producers.delete(producer.id);
      }
      set({ msProducers: producers });
      stream?.getTracks().forEach((track) => track.stop());
      if (claimedSlot && s) s.emit('voice:screen_share:stop');
      set({ screenStream: null, isScreenSharing: false });
      // A getDisplayMedia permission cancel is a deliberate user action — no toast
      const isUserCancel = err instanceof DOMException && err.name === 'NotAllowedError';
      if (!isUserCancel) {
        toast.error('Screen share failed — please try again');
      }
    }
  },

  replaceScreenVideoTrack: async (track: MediaStreamTrack) => {
    const producer = [...get().msProducers.values()].find(
      (p) => (p.appData as Record<string, unknown>)?.type === 'screen-video' && !p.closed,
    );
    if (!producer) throw new Error('No live screen-video producer to swap');
    await producer.replaceTrack({ track });
  },

  setScreenVideoProducerPaused: (paused: boolean) => {
    const producer = [...get().msProducers.values()].find(
      (p) => (p.appData as Record<string, unknown>)?.type === 'screen-video' && !p.closed,
    );
    if (!producer) return;
    if (paused && !producer.paused) producer.pause();
    else if (!paused && producer.paused) producer.resume();
    set({ screenShareFrozen: paused });
  },

  stopScreenShare: () => {
    const socket = getSocket();
    const { screenStream, msProducers } = get();

    // Stop the mask compositor's draw loop FIRST — canvas capture tracks
    // never end on their own, and a stopped share must not keep burning CPU.
    teardownComposite();

    // Close screen producers on BOTH sides. The server-side close
    // (voice:producer:close) frees the producer immediately and notifies every
    // viewer via producer_closed — without it, stopped-share producers leaked
    // until leaving voice and the second share of a session hung the client.
    const newProducers = new Map(msProducers);
    for (const [id, producer] of msProducers.entries()) {
      const appType = (producer.appData as Record<string, unknown>)?.type;
      if (appType === 'screen-video' || appType === 'screen-audio') {
        if (socket) socket.emit('voice:producer:close', { producerId: id });
        if (!producer.closed) producer.close();
        newProducers.delete(id);
      }
    }
    set({ msProducers: newProducers });

    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
    }

    if (socket) {
      socket.emit('voice:screen_share:stop');
    }

    set({
      screenStream: null,
      isScreenSharing: false,
      screenSharingUserId: null,
      screenShareFrozen: false,
      screenShareSourceKey: null,
      screenShareAnnotationsVersion: 1,
    });
  },

  setScreenSharingUser: (channelId: string, userId: string | null) => {
    const { activeChannelId } = get();
    if (channelId !== activeChannelId) return;
    set({
      screenSharingUserId: userId,
      ...(userId === null ? { remoteScreenStream: null } : {}),
    });
  },

  setScreenShareViewMode: (mode: 'inline' | 'floating') => {
    set({ screenShareViewMode: mode });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DM CALLS (P2P — unchanged)
  // ═══════════════════════════════════════════════════════════════════════════

  setIncomingCall: (data) => set({ incomingCall: data }),

  joinDMCall: async (conversationId: string) => {
    const socket = getSocket();
    if (!socket) return;

    // Leave server voice channel if active (cross-cleanup)
    if (get().activeChannelId) {
      get().leaveChannel();
    }

    // Leave existing DM call if any
    if (get().dmCallConversationId) {
      get().leaveDMCall();
    }

    const generation = ++voiceSessionGeneration;
    resetDMSignalChains();

    const settings = useSettingsStore.getState();
    setNoiseGateThreshold(settings.noiseGateThreshold);
    setNoiseSuppression(settings.enableNoiseSuppression);

    const stream = await acquireAudioStream();

    // Superseded while acquiring the mic — release it (see joinChannel)
    if (generation !== voiceSessionGeneration) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }

    const { selfMute, selfDeaf } = get();
    const isPTT = settings.voiceMode === 'push_to_talk';

    if (stream) {
      // Apply RNNoise noise suppression (clean isolated pipeline)
      const suppressedStream = await applyNoiseSuppression(stream);
      // Speaking detection taps into the suppressed stream (read-only side-chain)
      startSpeakingDetection(suppressedStream, 'dm');

      if (isPTT) {
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      } else {
        if (selfMute) {
          stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        }
      }
    }

    const effectiveMute = stream ? selfMute : true;
    const serverMute = isPTT ? true : effectiveMute;

    set({
      dmCallConversationId: conversationId,
      dmCallUsers: [],
      dmCallPeerDevice: null,
      localStream: stream,
      selfMute: effectiveMute,
      incomingCall: null,
    });

    // Announce which E2E device this call runs on, so the peer seals signals
    // to exactly it (spec §20), and pre-warm the peer's device list so the
    // first signal's vetting/bundle claim don't stack onto offer glare.
    const deviceId = await resolveOwnCallDeviceId();
    if (generation !== voiceSessionGeneration) return; // superseded during the readiness wait

    if (!deviceId) {
      // Calls are E2E-only (hard cutover): joining without a device id would
      // just make the PEER abort with "peer must update". Fail fast on OUR
      // side, with an honest message.
      console.warn('[DMVoice] E2E device unavailable — refusing to start an unprotectable call');
      get().handleDMCallEnded();
      toast.error(i18n.t('e2e.callNotReady'));
      return;
    }

    try {
      const { getE2EService } = await import('../services/e2e/e2eService');
      const { useAuthStore } = await import('./authStore');
      const { useDMStore } = await import('./dmStore');
      const me = useAuthStore.getState().user;
      const conversation = useDMStore.getState().conversations.find((c) => c.id === conversationId);
      if (me && conversation) {
        void getE2EService(me.id).fetchDeviceList(conversation.participant.id, true).catch((err) => {
          console.warn('[DMVoice] Device-list pre-warm failed (will retry at first signal):', err);
        });
      }
    } catch (err) {
      console.warn('[DMVoice] Device-list pre-warm setup failed:', err);
    }

    if (generation !== voiceSessionGeneration) return; // superseded during the async imports

    socket.emit('dm:voice:join', conversationId, { selfMute: serverMute, selfDeaf, deviceId });
    get().startLatencyMeasurement();
  },

  leaveDMCall: () => {
    const socket = getSocket();
    const { dmCallConversationId } = get();
    if (socket && dmCallConversationId) {
      socket.emit('dm:voice:leave', dmCallConversationId);
    }
    get().handleDMCallEnded();
  },

  handleDMCallEnded: () => {
    voiceSessionGeneration++; // cancel any in-flight join's mic acquisition
    const { localStream, dmCallConversationId } = get();

    get().stopLatencyMeasurement();
    onSpeakingChange(null);
    stopSpeakingDetection();
    stopNoiseSuppression();

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }

    get().destroyAllPeers();

    set({
      dmCallConversationId: null,
      dmCallUsers: [],
      dmCallPeerDevice: null,
      localStream: null,
      latency: null,
      pttActive: false,
    });

    resetDMSignalChains();
    if (dmCallConversationId) {
      void import('../services/e2e/callCrypto')
        .then(({ endCallSignaling }) => {
          // Immediate re-dial of the SAME conversation: the new call's pin
          // owns the signaling state now — don't end it from underneath.
          if (useVoiceStore.getState().dmCallConversationId === dmCallConversationId) return;
          endCallSignaling(dmCallConversationId);
        })
        .catch((err) => console.warn('[DMVoice] Failed to clear call signaling state:', err));
    }
  },

  abortDMCall: (reason: DMCallAbortReason) => {
    const conversationId = get().dmCallConversationId;
    if (!conversationId) return;
    console.warn('[DMVoice] Call aborted:', reason);
    get().leaveDMCall();
    void (async () => {
      let name: string | null = null;
      try {
        const { useDMStore } = await import('./dmStore');
        name = useDMStore.getState().conversations.find((c) => c.id === conversationId)?.participant.displayName ?? null;
      } catch (err) {
        console.warn('[DMVoice] Could not resolve peer name for abort toast:', err);
      }
      const key: Record<DMCallAbortReason, string> = {
        'identity-changed': 'e2e.callAbortIdentityChanged',
        'peer-must-update': 'e2e.callAbortPeerMustUpdate',
        'peer-not-e2e': 'e2e.callAbortPeerNotE2E',
        'signaling-failed': 'e2e.callAbortSignalingFailed',
      };
      toast.error(i18n.t(key[reason], { name: name ?? i18n.t('e2e.peerNotReadyFallbackName') }));
    })();
  },

  acceptCall: async () => {
    const { incomingCall } = get();
    if (!incomingCall) return;
    await get().joinDMCall(incomingCall.conversationId);
  },

  declineCall: () => {
    const { incomingCall } = get();
    if (incomingCall) {
      const socket = getSocket();
      socket?.emit('dm:voice:decline', incomingCall.conversationId);
    }
    set({ incomingCall: null });
  },

  addDMCallUser: (user: VoiceUser & { deviceId?: string }) => {
    const { dmCallUsers, dmCallConversationId, localUserId } = get();

    // Pin (or re-pin) the peer's E2E call device BEFORE any peer creation can
    // emit a signal — every signal seals to exactly this device (spec §20).
    // Runs even for already-listed users: a rejoin replay may carry a NEW
    // device (peer reinstalled / switched devices mid-call).
    if (dmCallConversationId && user.id !== localUserId) {
      if (!user.deviceId) {
        console.warn('[DMVoice] Peer joined without an E2E call device — aborting call');
        get().abortDMCall('peer-must-update');
        return;
      }
      const pinned = get().dmCallPeerDevice;
      if (!pinned || pinned.userId !== user.id || pinned.deviceId !== user.deviceId) {
        if (pinned) {
          // Device changed mid-call: tear down the old peer and let the
          // rejoiner's fresh offer re-glare against the new pin
          debugLog('[DMVoice] Call peer device changed — re-pinning');
          get().destroyPeer(user.id);
        }
        pinDMCallPeer(dmCallConversationId, { userId: user.id, deviceId: user.deviceId });
      }
    }

    if (dmCallUsers.some((u) => u.id === user.id)) return;

    set({ dmCallUsers: [...dmCallUsers, user] });

    setTimeout(() => {
      const state = get();
      if (state.dmCallConversationId && state.localStream && user.id !== state.localUserId && !state.peers.has(user.id)) {
        debugLog('[DMVoice] Creating initiator peer to', user.id);
        get().createDMPeer(user.id, true);
      }
    }, 0);
  },

  removeDMCallUser: (userId: string) => {
    const restartTimer = iceRestartTimers.get(userId);
    if (restartTimer) {
      clearTimeout(restartTimer);
      iceRestartTimers.delete(userId);
    }

    get().destroyPeer(userId);

    set((state) => ({
      dmCallUsers: state.dmCallUsers.filter((u) => u.id !== userId),
    }));
  },

  updateDMCallUserState: (userId: string, selfMute: boolean, selfDeaf: boolean) => {
    set((state) => ({
      dmCallUsers: state.dmCallUsers.map((u) =>
        u.id === userId ? { ...u, selfMute, selfDeaf } : u
      ),
    }));
  },

  setDMCallUserSpeaking: (userId: string, speaking: boolean) => {
    set((state) => ({
      dmCallUsers: state.dmCallUsers.map((u) =>
        u.id === userId ? { ...u, speaking } : u
      ),
    }));
  },

  createDMPeer: (targetUserId: string, initiator: boolean) => {
    createPeerInternal('dm:voice:signal', '[DMVoice]', targetUserId, initiator, { get, set });
  },

  handleDMSignal: (from: string, signal: unknown) => {
    const { dmCallConversationId, dmCallPeerDevice } = get();
    if (!dmCallConversationId) return;
    if (!dmCallPeerDevice || dmPinFlushPending) {
      // Peer device not pinned yet (their signal beat the joined event) —
      // buffer; pinDMCallPeer flushes in arrival order
      if (prePinSignalQueue.length < PRE_PIN_QUEUE_CAP) {
        prePinSignalQueue.push({ from, signal });
      } else {
        console.warn('[DMVoice] Pre-pin signal buffer full — dropping signal from', from);
      }
      return;
    }
    if (from !== dmCallPeerDevice.userId) {
      debugLog('[DMVoice] Dropping DM signal from non-call-peer', from);
      return;
    }
    receiveDMSignalEncrypted(from, signal);
  },
}));

// ─── Subscriptions ──────────────────────────────────────────────────────────

// Subscribe to output device changes and update all existing remote audio elements
useSettingsStore.subscribe((state, prevState) => {
  if (state.audioOutputDeviceId !== prevState.audioOutputDeviceId) {
    const { remoteAudios } = useVoiceStore.getState();
    remoteAudios.forEach((audio) => {
      applyOutputDevice(audio, state.audioOutputDeviceId);
    });
  }
});

// Subscribe to input device changes — hot-swap mic while in a call
useSettingsStore.subscribe((state, prevState) => {
  if (state.audioInputDeviceId === prevState.audioInputDeviceId) return;

  const voiceState = useVoiceStore.getState();
  if (!voiceState.activeChannelId && !voiceState.dmCallConversationId) return;

  // Re-acquire mic with the new device
  (async () => {
    const newStream = await acquireAudioStream();

    // Re-check: user may have left the call during async mic acquisition
    const currentState = useVoiceStore.getState();
    if (!currentState.activeChannelId && !currentState.dmCallConversationId) {
      newStream?.getTracks().forEach((t) => t.stop());
      return;
    }

    // Stop old mic tracks
    if (currentState.localStream) {
      currentState.localStream.getTracks().forEach((t) => t.stop());
    }

    if (!newStream) {
      useVoiceStore.setState({ localStream: null });
      return;
    }

    // Apply mute state to new stream
    const isPTT = useSettingsStore.getState().voiceMode === 'push_to_talk';
    const shouldDisable = isPTT || currentState.selfMute;
    newStream.getAudioTracks().forEach((track) => { track.enabled = !shouldDisable; });

    // Rebuild audio pipeline with new stream
    const mode = currentState.dmCallConversationId ? 'dm' : 'server';
    onSpeakingChange(null);
    stopSpeakingDetection();
    stopNoiseSuppression();
    setNoiseGateThreshold(useSettingsStore.getState().noiseGateThreshold);
    setNoiseSuppression(useSettingsStore.getState().enableNoiseSuppression);

    // Apply RNNoise noise suppression (clean isolated pipeline)
    const suppressedStream = await applyNoiseSuppression(newStream);
    // Speaking detection uses the suppressed stream
    startSpeakingDetection(suppressedStream, mode);

    useVoiceStore.setState({ localStream: newStream });

    // Re-check again after pipeline setup
    const postState = useVoiceStore.getState();

    // Replace track on mediasoup producer (SFU server voice)
    if (postState.activeChannelId) {
      const newTrack = (getGatedStream() || newStream)?.getAudioTracks()[0];
      if (newTrack && newTrack.readyState === 'live') {
        for (const producer of postState.msProducers.values()) {
          if (producer.kind === 'audio' && !producer.closed && (producer.appData as Record<string, unknown>)?.type === 'audio') {
            try {
              await producer.replaceTrack({ track: newTrack });
              debugLog('[Voice SFU] Replaced audio track on producer after input device change');
            } catch (err) {
              console.error('[Voice SFU] Failed to replace track on producer:', err);
              toast.error('Microphone issue detected — try rejoining voice');
            }
          }
        }
      }

      // Re-register speaking change callback for the new pipeline
      onSpeakingChange((speaking) => {
        const s = useVoiceStore.getState();
        if (s.selfMute) return;
        for (const p of s.msProducers.values()) {
          if (p.kind === 'audio' && !p.closed && (p.appData as Record<string, unknown>)?.type === 'audio') {
            if (speaking) { p.resume(); } else { p.pause(); }
          }
        }
      });
    }

    // Replace track on DM P2P peers — use RNNoise-suppressed stream
    if (postState.dmCallConversationId) {
      const newTrack = (getSuppressedStream() || newStream)?.getAudioTracks()[0];
      if (newTrack && newTrack.readyState === 'live') {
        for (const [peerId, peerConn] of postState.peers.entries()) {
          const senders = peerConn.pc.getSenders();
          const audioSender = senders.find((s) => s.track?.kind === 'audio');
          if (audioSender) {
            try {
              await audioSender.replaceTrack(newTrack);
              debugLog(`[DMVoice] Replaced audio track for peer ${peerId} after input device change`);
            } catch (err) {
              console.error(`[DMVoice] Failed to replace track for peer ${peerId}:`, err);
            }
          }
        }
      }
    }
  })();
});

// Handle live noise suppression toggle while in a call
/** Generation counter — prevents stale async overlaps on rapid toggles. */
let nsToggleGeneration = 0;

useSettingsStore.subscribe((state, prevState) => {
  if (state.enableNoiseSuppression === prevState.enableNoiseSuppression) return;

  const voiceState = useVoiceStore.getState();
  if (!voiceState.activeChannelId && !voiceState.dmCallConversationId) return;
  if (!voiceState.localStream) return;

  const localStream = voiceState.localStream;
  const gen = ++nsToggleGeneration;

  (async () => {
    // Rebuild the suppression pipeline with new setting
    stopNoiseSuppression();
    setNoiseSuppression(state.enableNoiseSuppression);
    const suppressedStream = await applyNoiseSuppression(localStream);

    // Abort if a newer toggle happened during the await
    if (gen !== nsToggleGeneration) return;

    // Re-check: user may have left during async work
    const current = useVoiceStore.getState();
    if (!current.activeChannelId && !current.dmCallConversationId) return;

    // Rebuild speaking detection on the (now suppressed or raw) stream
    const mode = current.dmCallConversationId ? 'dm' : 'server';
    onSpeakingChange(null);
    stopSpeakingDetection();
    startSpeakingDetection(suppressedStream, mode);

    // Re-register SFU producer pause/resume callback
    if (current.activeChannelId) {
      onSpeakingChange((speaking) => {
        const s = useVoiceStore.getState();
        if (s.selfMute) return;
        for (const p of s.msProducers.values()) {
          if (p.kind === 'audio' && !p.closed && (p.appData as Record<string, unknown>)?.type === 'audio') {
            if (speaking) { p.resume(); } else { p.pause(); }
          }
        }
      });

      // Replace SFU producer track with new processed stream
      const newTrack = (getGatedStream() || suppressedStream)?.getAudioTracks()[0];
      if (newTrack && newTrack.readyState === 'live') {
        for (const producer of current.msProducers.values()) {
          if (producer.kind === 'audio' && !producer.closed && (producer.appData as Record<string, unknown>)?.type === 'audio') {
            try {
              await producer.replaceTrack({ track: newTrack });
            } catch (err) {
              console.error('[Voice SFU] Failed to replace track after noise suppression toggle:', err);
            }
            if (gen !== nsToggleGeneration) return;
          }
        }
      }
    }

    // Replace DM P2P peer tracks with new processed stream
    if (current.dmCallConversationId) {
      const newTrack = (getSuppressedStream() || localStream)?.getAudioTracks()[0];
      if (newTrack && newTrack.readyState === 'live') {
        for (const [, peerConn] of current.peers.entries()) {
          const sender = peerConn.pc.getSenders().find((s) => s.track?.kind === 'audio');
          if (sender) {
            try {
              await sender.replaceTrack(newTrack);
            } catch (err) {
              console.error('[DMVoice] Failed to replace track after noise suppression toggle:', err);
            }
            if (gen !== nsToggleGeneration) return;
          }
        }
      }
    }
  })();
});

// Handle live voice mode switching while in a voice channel or DM call
useSettingsStore.subscribe((state, prevState) => {
  if (state.voiceMode === prevState.voiceMode) return;

  const { activeChannelId, dmCallConversationId, localStream, selfMute, msProducers } = useVoiceStore.getState();
  if ((!activeChannelId && !dmCallConversationId) || !localStream) return;

  const socket = getSocket();

  if (state.voiceMode === 'push_to_talk') {
    localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
    if (socket) {
      if (activeChannelId) socket.emit('voice:mute', true);
      else socket.emit('dm:voice:mute', true);
    }
    // Pause the SFU mic producer (screen audio unaffected)
    if (activeChannelId) {
      for (const producer of msProducers.values()) {
        if (isMicProducer(producer)) producer.pause();
      }
    }
  } else {
    if (!selfMute) {
      localStream.getAudioTracks().forEach((track) => { track.enabled = true; });
      if (socket) {
        if (activeChannelId) socket.emit('voice:mute', false);
        else socket.emit('dm:voice:mute', false);
      }
      // Resume the SFU mic producer
      if (activeChannelId) {
        for (const producer of msProducers.values()) {
          if (isMicProducer(producer)) producer.resume();
        }
      }
    }
  }
});

// On socket reconnect while in a voice channel: re-join and re-establish
onSocketReconnect(async () => {
  const { activeChannelId, dmCallConversationId } = useVoiceStore.getState();

  const socket = getSocket();
  if (!socket) return;

  if (!activeChannelId && !dmCallConversationId) return;

  // Reset transport rejoin counter — socket reconnect is a fresh connection
  transportRejoinAttempts = 0;

  // Clean up SFU resources on reconnect (server voice)
  if (activeChannelId) {
    useVoiceStore.getState().cleanupSFU();
  }

  // Clear ALL screen share state on reconnect (both local and remote are stale)
  const { isScreenSharing, screenStream } = useVoiceStore.getState();
  if (isScreenSharing && screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
  }
  useVoiceStore.setState({
    screenStream: null,
    isScreenSharing: false,
    screenSharingUserId: null,
    remoteScreenStream: null,
  });

  // For DM calls, destroy stale P2P peers
  if (dmCallConversationId) {
    useVoiceStore.getState().destroyAllPeers();
  }

  // Re-acquire microphone if the old stream's tracks ended during disconnect
  let { localStream } = useVoiceStore.getState();
  const tracksAlive = localStream?.getAudioTracks().some((t) => t.readyState === 'live');
  if (!localStream || !tracksAlive) {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    const newStream = await acquireAudioStream();
    localStream = newStream;
    useVoiceStore.setState({ localStream: newStream });
  }

  const { selfMute, selfDeaf } = useVoiceStore.getState();
  const settings = useSettingsStore.getState();
  const isPTT = settings.voiceMode === 'push_to_talk';

  // Apply mute state to the (possibly new) stream
  if (localStream) {
    const shouldDisable = isPTT || selfMute;
    localStream.getAudioTracks().forEach((track) => { track.enabled = !shouldDisable; });
  }

  // Restart audio pipelines BEFORE emitting voice:join
  if (localStream) {
    try {
      setNoiseGateThreshold(settings.noiseGateThreshold);
      setNoiseSuppression(settings.enableNoiseSuppression);
      const suppressedStream = await applyNoiseSuppression(localStream);
      startSpeakingDetection(suppressedStream, dmCallConversationId ? 'dm' : 'server');
    } catch (err) {
      console.error('[Voice] Audio pipeline rebuild failed on reconnect:', err);
      // Fallback: use raw stream for speaking detection
      startSpeakingDetection(localStream, dmCallConversationId ? 'dm' : 'server');
    }

    // Re-register producer pause/resume callback for silence detection (server voice only)
    if (activeChannelId) {
      onSpeakingChange((speaking) => {
        const state = useVoiceStore.getState();
        if (state.selfMute) return;
        for (const producer of state.msProducers.values()) {
          if (producer.kind === 'audio' && (producer.appData as Record<string, unknown>)?.type === 'audio') {
            if (speaking) { producer.resume(); } else { producer.pause(); }
          }
        }
      });
    }
  }

  if (activeChannelId) {
    debugLog('[Voice SFU] Socket reconnected — re-joining voice channel', activeChannelId);
    if (secureVoiceChannelId === activeChannelId) {
      // Secure voice: a socket reconnect is a SESSION restart — the full join
      // re-begins with a fresh key + epoch (IV-reuse firewall, spec §21)
      const serverId = useVoiceStore.getState().activeVoiceServerId;
      void useVoiceStore.getState().joinChannel(activeChannelId, serverId ?? undefined, { secure: true });
    } else {
      // Re-emit voice:join — server will send voice:transport_created to re-establish SFU
      socket.emit('voice:join', activeChannelId, { selfMute: isPTT ? true : selfMute, selfDeaf });
    }
  } else if (dmCallConversationId) {
    debugLog('[DMVoice] Socket reconnected — re-joining DM call', dmCallConversationId);
    // deviceId must survive the rebind or the peer loses its sealing target
    const deviceId = await resolveOwnCallDeviceId();
    socket.emit('dm:voice:join', dmCallConversationId, { selfMute: isPTT ? true : selfMute, selfDeaf, deviceId });
  }

  // Re-start latency measurement with new socket
  useVoiceStore.getState().startLatencyMeasurement();
});
