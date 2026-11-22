import { create } from 'zustand';
import { Device } from 'mediasoup-client';
import type { Transport, Producer, Consumer, RtpCapabilities, IceParameters, IceCandidate, DtlsParameters, RtpParameters } from 'mediasoup-client/types';
import { getSocket, onSocketReconnect } from '../services/socket';
import { startSpeakingDetection, stopSpeakingDetection, setNoiseGateThreshold, getGatedStream, setNoiseSuppression, onSpeakingChange, applyNoiseSuppression, getSuppressedStream, stopNoiseSuppression, setSpeakingDetectionPaused, onNoiseSuppressionFailure, getSpeakingDetectionMode } from '../services/audioAnalyser';
import { useSettingsStore, VOICE_QUALITY_BITRATE } from './settingsStore';
import { toast } from './toastStore';
import { teardownComposite, prepareComposite, attachCompositeProducerHandles } from '../services/screenComposite';
import { sourceKeyFromSettings } from '../utils/maskLayouts';
import { createWhiteboardStream, WHITEBOARD_WIDTH, WHITEBOARD_HEIGHT } from '../utils/whiteboard';
import { loadAnnotationPrefs } from '../utils/annotationPrefs';

// ─── Mask hooks (registered by annotationStore — a direct import would be a
// module cycle: annotationStore already imports this store at eval time) ─────

export interface ShareMaskHooks {
  /** Are any privacy masks placed right now? */
  hasMasks: () => boolean;
  /** The compositor callbacks (getMasks, onFatal, onSourceHold, …) the
   *  pre-produce path should run with. */
  preflightCompositeHandles: (rawTrack: MediaStreamTrack) => Parameters<typeof prepareComposite>[0];
  /** A cancelled pre-flight leaves no masks behind. */
  clearPreflightMasks: () => void;
}

let shareMaskHooks: ShareMaskHooks | null = null;
/** True from claim to produce-settled: the share button stays enabled while
 *  isScreenSharing is still false, so a second pre-flight could otherwise
 *  confirm concurrently and its failure rollback would clobber the first. */
let shareActivationInFlight = false;
/** annotationStore's lifecycle guard reads this: sharer-id transitions during
 *  the claim/produce window (another sharer's STOP broadcast landing while
 *  our claim ack is in flight) must not wipe the pre-flight masks — that is
 *  the third ordering of the same race that produced the raw track. */
export function isShareActivationInFlight(): boolean {
  return shareActivationInFlight;
}
export function registerShareMaskHooks(hooks: ShareMaskHooks): void {
  shareMaskHooks = hooks;
}
import { optimizeOpusSDP } from '../services/sdpUtils';
import i18n from '../i18n';
import { translateServerError } from '../utils/serverErrors';
import { VOICE_SPEAK_REFUSED_MESSAGE } from '@voxium/shared';
import type { VoiceUser, TransportOptions, E2ECallSignal } from '@voxium/shared';
import type { CallPeerDevice } from '../services/e2e/callCrypto';
import { isE2ESessionEnded } from '../services/e2e/session';
import { resolveStunUrl } from '../utils/stunUrl';
import { isHeldReadOnly } from '../utils/dmParticipant';

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
// Derived from VITE_WS_URL (by default the STUN server of the deployment is the
// host the socket connects to), or VITE_STUN_URL when coturn has its own
// machine — see utils/stunUrl.ts.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: resolveStunUrl(import.meta.env) },
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
  /** A captured stream waiting in the pre-flight: masks are being placed on
   *  a local preview and NOTHING has been claimed or produced — viewers do
   *  not know a share is coming, and cancelling costs nothing. */
  pendingShare: { stream: MediaStream; sourceKey: string | null; displaySurface: string } | null;
  /** The current share's source identity (`displaySurface:WxH` from the
   *  capture track's settings) — the key remembered mask layouts live under.
   *  Null while not sharing or when the settings gave no size. */
  screenShareSourceKey: string | null;
  /** What the local share is showing — the toolbar hides the mask tool on a
   *  whiteboard (there is nothing to cover). */
  shareKind: 'screen' | 'whiteboard';
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
  /** The voice channel is gone on the server (its space was deleted): the
   *  same local teardown as leaveChannel, without voice:leave (the server
   *  already removed the session and its room). */
  handleVoiceChannelGone: () => void;
  /** `source: 'connect'` is a snapshot replay (socket connect, server join): ignored for the channel this client is in. */
  setChannelUsers: (channelId: string, users: VoiceUser[], serverId?: string, source?: 'connect') => void;
  addUserToChannel: (channelId: string, user: VoiceUser, serverId?: string) => void;
  /**
   * `voice:error` from the server. Scoped by `channelId` when the server sent
   * one: acted on only while that channel is the active one. Returns whether
   * it acted (the caller toasts the message only then).
   */
  handleVoiceError: (data: { message: string; channelId?: string }) => boolean;
  /** Removes a participant's row; false when the departure was ignored (it named another E2E session than the listed one). */
  removeUserFromChannel: (channelId: string, userId: string, epoch?: string) => boolean;
  updateUserState: (channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean, serverMuted: boolean, serverDeafened: boolean) => void;
  handleForceMove: (targetChannelId: string) => void;
  serverMuteUser: (targetUserId: string, muted: boolean) => void;
  serverDeafenUser: (targetUserId: string, deafened: boolean) => void;
  forceMoveUser: (targetUserId: string, targetChannelId: string) => void;
  setUserSpeaking: (channelId: string, userId: string, speaking: boolean) => void;

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
  /** Whiteboard v1: a canvas IS a screen — the injected-track start path. */
  startWhiteboardShare: () => Promise<void>;
  /** Go live from the pre-flight. */
  confirmPendingShare: () => Promise<void>;
  /** Abandon the pre-flight: stop the capture, drop its masks. */
  cancelPendingShare: () => void;
  /** Claim + produce (internal to the share flow; exposed for the pre-flight). */
  activateScreenShare: (stream: MediaStream, kind?: 'screen' | 'whiteboard') => Promise<void>;
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
  /** The server's `dm:voice:ended`: ends the call and drops the ring of that
   *  conversation. An answer marked `rejoin` (to this device's re-join after
   *  a reconnect) is acted on only by the re-join that asked. */
  handleDMVoiceEnded: (data: { conversationId: string; rejoin?: boolean }) => void;
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
 * End the secure-voice session (if any): kill the crypto worker, zero the
 * media key, and stop the membership poll. Part of the one teardown of a
 * space voice session (endVoiceChannelSession), which a channel gone on the
 * server goes through too (handleVoiceChannelGone): an end of a call outside
 * the store goes through those actions, not through this alone.
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

/** The voice session generation under which the last DM call re-join went
 *  out (null: none yet). The server's answer to it carries no more than the
 *  conversation, so it is acted on only while this is still the generation:
 *  a call hung up and placed again with the same person meanwhile is another
 *  session, which that answer must not end. */
let dmRejoinSentUnder: number | null = null;

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

/** The one peer-to-peer signaling event left: DM calls (voice channels use the SFU). */
type SignalEvent = 'dm:voice:signal';

export type DMCallAbortReason = 'identity-changed' | 'peer-must-update' | 'peer-not-e2e' | 'signaling-failed';

/** Send one WebRTC signal of a DM call. */
function emitSignal(
  _event: SignalEvent,
  data: { to: string; signal: unknown },
) {
  // E2E cutover (spec §20): DM signals NEVER leave in plaintext. Sealed on
  // the send chain to the pinned peer device; socket resolved at emit time.
  sendDMSignalEncrypted(data.to, data.signal as E2ECallSignal);
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
      if (isE2ESessionEnded(err)) {
        // logout disposed the E2E service and already left the call
        debugLog('[DMVoice] Call signal not sealed: the session ended');
        return;
      }
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
      if (isE2ESessionEnded(err)) {
        // logout disposed the E2E service and already left the call
        debugLog('[DMVoice] Inbound call signal not opened: the session ended');
        return;
      }
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

/** The input-device setting the live stream stands for: where the picker goes
 *  back to after a failed switch. The saved device, or, when a join fell back
 *  to the system default, the device actually opened. */
let liveInputDeviceId = '';

/** An error about the microphone being refused, not about the device chosen. */
function isPermissionRefusal(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

/**
 * The constraints every microphone is opened with. The browser's own noise
 * suppression is the inverse of RNNoise: off when RNNoise will run (two noise
 * gates in series degrade the voice), on when RNNoise is off or unavailable
 * this session. It takes effect only at getUserMedia: asked for on a live
 * track, Chromium accepts the change and keeps processing as it was opened.
 */
function micConstraints(noiseSuppression: boolean): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression, autoGainControl: true };
}

/** A microphone acquireAudioStream opened. `onSystemDefault`: the saved
 *  device could not be opened and the system default was, in its place. */
interface AcquiredMic {
  stream: MediaStream;
  onSystemDefault: boolean;
}

/**
 * Acquire a mic audio stream using the user's preferred input device. A
 * failure resolves null; `quiet` leaves telling the user to the caller (a
 * device switch mid-call keeps its microphone: the join's "listen-only"
 * wording would be wrong there). A join (not `quiet`) whose saved device
 * cannot be opened (unplugged, busy) tries the system default once before
 * going listen-only, and says so through `onSystemDefault` (the caller tells
 * the user once it keeps the stream); a switch never does, it asked for that
 * one device.
 */
async function acquireAudioStream(options: { quiet?: boolean } = {}): Promise<AcquiredMic | null> {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[Voice] getUserMedia not available (insecure context?), joining in listen-only mode');
      return null;
    }
    const settings = useSettingsStore.getState();
    const audioConstraints = micConstraints(!rnnoiseWanted());
    if (!settings.audioInputDeviceId) {
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: audioConstraints }), onSystemDefault: false };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audioConstraints, deviceId: { exact: settings.audioInputDeviceId } } });
      return { stream, onSystemDefault: false };
    } catch (err) {
      if (options.quiet || isPermissionRefusal(err)) throw err;
      console.warn('[Voice] The saved microphone could not be opened, trying the system default:', err);
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: audioConstraints }), onSystemDefault: true };
    }
  } catch (err) {
    if (options.quiet) {
      console.warn('[Voice] Could not open the selected microphone:', err);
      return null;
    }
    console.warn('[Voice] Microphone access denied, joining in listen-only mode:', err);
    toast.warning(i18n.t('voice.toasts.micDenied'));
    return null;
  }
}

/**
 * The input-device setting a join's (or a reconnect's) microphone stands for,
 * kept in liveInputDeviceId: the saved one, or after a fall-back to the system
 * default the device actually opened ('' when the browser does not say which:
 * the system default itself). A saved "system default" stays '': a concrete id
 * there would pin the picker to one device after a failed switch.
 */
function inputDeviceOf(mic: AcquiredMic | null, requested: string): string {
  if (!mic?.onSystemDefault) return requested;
  return mic.stream.getAudioTracks()[0]?.getSettings?.().deviceId || '';
}

/** The one line telling the user the saved microphone could not be opened and
 *  the system default is in use (the saved choice is kept for next time). */
function noticeSystemDefaultMic() {
  toast.warning(i18n.t('voice.toasts.micDefaultInUse'));
}

// ─── The microphone pipeline ────────────────────────────────────────────────
// Noise suppression and speaking detection are module-level singletons in
// audioAnalyser. A join, the noise-suppression toggle, an input-device change,
// a noise-suppression failure and a socket reconnect all rebuild them: one
// generation orders those rebuilds, so the latest wins and an older one stops
// touching the singletons after its next await.
let micPipelineGeneration = 0;

/** `superseded`: a newer rebuild or another voice session took over. */
type MicPipelineResult = 'ok' | 'superseded' | 'swap-failed';

/** RNNoise is to run: the user wants it and it has not failed in this app session. */
function rnnoiseWanted(): boolean {
  const settings = useSettingsStore.getState();
  return settings.enableNoiseSuppression && !settings.noiseSuppressionUnavailable;
}

/**
 * Ask the browser for its own noise suppression on the raw mic exactly when
 * RNNoise does not run on it (off, failed this session, or a start that fell
 * back): two suppressors in series degrade the voice, none lets the noise
 * through. Best effort, asked only of a track that reports the setting and
 * can take the value: Chromium accepts the change on a live track but keeps
 * its processing until the mic is opened again (which asks for it at
 * getUserMedia); a track with no such processing is left alone.
 */
function matchBrowserNoiseSuppression(stream: MediaStream, rnnoiseRuns: boolean) {
  const want = !rnnoiseRuns;
  for (const track of stream.getAudioTracks()) {
    if (typeof track.applyConstraints !== 'function') continue;
    const current = track.getSettings?.().noiseSuppression;
    if (typeof current !== 'boolean' || current === want) continue;
    const possible = track.getCapabilities?.().noiseSuppression;
    if (Array.isArray(possible) && !possible.includes(want)) continue;
    track.applyConstraints({ ...track.getConstraints?.(), noiseSuppression: want }).catch((err) => {
      console.warn('[Voice] The browser refused to change its own noise suppression:', err);
    });
  }
}

/**
 * Give a just-made mic producer the pipeline's CURRENT outgoing track (the
 * gated stream, or the raw one) when it carries another: a rebuild that ran
 * while produce() was in flight swapped only the producers already registered,
 * and the track it ended sends nothing. replaceTrack keeps the RTCRtpSender,
 * and with it a secure channel's frame transform.
 */
async function adoptCurrentMicTrack(producer: Producer): Promise<void> {
  if (producer.closed) return;
  const track = (getGatedStream() || useVoiceStore.getState().localStream)?.getAudioTracks()[0];
  if (!track || track === producer.track || track.readyState !== 'live') return;
  try {
    await producer.replaceTrack({ track });
    debugLog('[Voice SFU] Gave the new mic producer the current track');
  } catch (err) {
    console.error('[Voice SFU] Failed to give the new mic producer the current track:', err);
  }
}

/**
 * Make the mic producer (server voice) on `sendTransport` from the pipeline's
 * current outgoing track: at transport creation, and when a call joined
 * listen-only gets a working microphone. Nothing without a live track.
 *
 * Secure voice: the encrypt transform is installed on the RTCRtpSender the
 * moment it exists, before negotiation. If the attach fails or never happens,
 * NOTHING may be produced: the producer is closed and the channel left,
 * fail closed (spec §21).
 */
async function produceMic(sendTransport: Transport, device: Device): Promise<Producer | null> {
  // The server already said this member may not speak here: nothing to try again
  if (micRefusedOn === sendTransport) return null;
  // One at a time per transport: a second one would be a second producer the
  // server replaces while this client keeps sending on it. The one in flight
  // adopts the current track when it lands (adoptCurrentMicTrack)
  if (micProduceInFlight === sendTransport) return null;
  micProduceInFlight = sendTransport;
  try {
    return await produceMicOn(sendTransport, device);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== VOICE_SPEAK_REFUSED_MESSAGE) throw err;
    // Listening only, by the space's own rule: not a failure of the
    // connection. Said once, in the user's language, and remembered for this
    // transport, so that a later rebuild (a device change, the noise
    // suppression switch) does not ask the server again and repeat it.
    micRefusedOn = sendTransport;
    toast.info(translateServerError(VOICE_SPEAK_REFUSED_MESSAGE, i18n.t.bind(i18n)));
    return null;
  } finally {
    if (micProduceInFlight === sendTransport) micProduceInFlight = null;
  }
}

/** The send transport a mic producer is being made on, or null. */
let micProduceInFlight: Transport | null = null;

/**
 * The send transport on which the server refused the microphone because the
 * member may not speak in the channel (VOICE_SPEAK_REFUSED_MESSAGE), or null. A new join has a new transport, so it asks again.
 */
let micRefusedOn: Transport | null = null;

async function produceMicOn(sendTransport: Transport, device: Device): Promise<Producer | null> {
  const state = useVoiceStore.getState;
  const gated = getGatedStream();
  const audioTrack = (gated || state().localStream)?.getAudioTracks()[0];
  if (!audioTrack || audioTrack.readyState !== 'live' || !device.canProduce('audio')) return null;
  // The gated track outlives the producers made from it (a transport restart
  // makes a new one from the same pipeline). Only a producer's pause disables
  // it, and a producer starts paused on a disabled track: handed over enabled,
  // as a new one is, this producer's pause state is its own. The raw track is
  // never touched here: its `enabled` is the mute and push-to-talk.
  if (gated) audioTrack.enabled = true;
  const maxBitrate = VOICE_QUALITY_BITRATE[useSettingsStore.getState().voiceQuality];
  const secureSession = activeSecureVoiceSession(state().activeChannelId);
  let attachError: unknown = null;
  let attachInvoked = false;
  const producer = await sendTransport.produce({
    track: audioTrack,
    // The pipeline owns the track's life, not the producer. Unless told not
    // to, mediasoup stops the track of a produce that fails or is refused, of
    // a producer or transport that closes, and either track of a replace,
    // while the pipeline still uses it (the listen-only state after a
    // refusal, a transport restart, the next rebuild). The pipeline stops its
    // tracks where it ends: stopSpeakingDetection, stopNoiseSuppression and
    // the localStream's own stops. The pause defaults stay (the noise gate,
    // mute and push-to-talk pause by disabling the track).
    stopTracks: false,
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
    state().leaveChannel();
    return null;
  }

  const newProducers = new Map(state().msProducers);
  newProducers.set(producer.id, producer);
  useVoiceStore.setState({ msProducers: newProducers });

  // If muted (now: the mute may have moved while produce() ran), pause the
  // producer client-side too
  if (state().selfMute) {
    producer.pause();
  }

  // A pipeline rebuild that landed while produce() was in flight swapped
  // only the producers it could see: this one may still carry a track that
  // rebuild ended
  await adoptCurrentMicTrack(producer);

  debugLog('[Voice SFU] Audio producer created:', producer.id);
  return producer;
}

/** Server voice: the mic producer follows the noise gate (paused in silence,
 *  resumed on speech), never while muted. The one speaking callback. */
function followSpeakingWithMicProducer(speaking: boolean) {
  const state = useVoiceStore.getState();
  if (state.selfMute) return; // stay paused if muted
  for (const producer of state.msProducers.values()) {
    if (isMicProducer(producer) && !producer.closed) {
      if (speaking) { producer.resume(); } else { producer.pause(); }
    }
  }
}

/**
 * (Re)build noise suppression and speaking detection over `stream` for the
 * current voice session, then give the new audio to whatever already sends:
 * the mic producer (server voice, the gated stream) and the DM peers' audio
 * senders (the suppressed stream, or the raw one). It keys on what exists, not
 * on activeChannelId: a secure join builds its pipeline before it sets that,
 * and its producer, made later, reads the gated stream itself.
 *
 * Tracks are swapped with replaceTrack on the existing producer and sender,
 * never by producing again: the secure-voice frame transform lives on the
 * RTCRtpSender, which replaceTrack keeps. When nothing sends yet (a call
 * joined listen-only), a rebuild that went through gives the call its
 * microphone (sendNewMicIfNothingSends), whichever caller started it.
 */
async function rebuildMicPipeline(stream: MediaStream, mode: 'server' | 'dm'): Promise<MicPipelineResult> {
  const generation = ++micPipelineGeneration;
  const session = voiceSessionGeneration;
  const current = () => generation === micPipelineGeneration && session === voiceSessionGeneration;

  setNoiseGateThreshold(useSettingsStore.getState().noiseGateThreshold);
  setNoiseSuppression(rnnoiseWanted());
  const suppressed = await applyNoiseSuppression(stream);
  if (!current()) return 'superseded';
  matchBrowserNoiseSuppression(stream, suppressed !== stream);

  onSpeakingChange(null);
  stopSpeakingDetection();
  // Speaking detection taps the suppressed stream (the raw one without suppression)
  startSpeakingDetection(suppressed, mode);
  if (mode === 'server') onSpeakingChange(followSpeakingWithMicProducer);

  let swapFailed = false;
  const { msProducers, peers } = useVoiceStore.getState();
  const micProducers = [...msProducers.values()].filter((p) => isMicProducer(p) && !p.closed);
  const producerTrack = (getGatedStream() || suppressed).getAudioTracks()[0];
  if (micProducers.length > 0 && producerTrack?.readyState === 'live') {
    for (const producer of micProducers) {
      try {
        await producer.replaceTrack({ track: producerTrack });
        debugLog('[Voice SFU] Replaced the mic producer track after a pipeline rebuild');
      } catch (err) {
        console.error('[Voice SFU] Failed to replace track on producer:', err);
        swapFailed = true;
      }
      if (!current()) return 'superseded';
    }
  }
  const peerTrack = (getSuppressedStream() || stream).getAudioTracks()[0];
  if (peers.size > 0 && peerTrack?.readyState === 'live') {
    for (const [peerId, peerConn] of peers.entries()) {
      const audioSender = peerConn.pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (!audioSender) continue;
      try {
        await audioSender.replaceTrack(peerTrack);
        debugLog(`[DMVoice] Replaced audio track for peer ${peerId} after a pipeline rebuild`);
      } catch (err) {
        console.error(`[DMVoice] Failed to replace track for peer ${peerId}:`, err);
        swapFailed = true;
      }
      if (!current()) return 'superseded';
    }
  }
  if (swapFailed) return 'swap-failed';
  // Here, not in each caller: the toggle, the fallback and a switch can each be
  // the rebuild that finishes after a listen-only call got its microphone
  await sendNewMicIfNothingSends(stream, mode);
  return 'ok';
}

/**
 * A join's microphone pipeline, built over the stream the join opened. When
 * RNNoise fails at this very start, before the join sends anything, that
 * stream was opened without the browser's own noise suppression (it is off
 * while RNNoise is to run), and asking for it on the live track changes
 * nothing in Chromium: the call would go out with no noise suppression at
 * all. The microphone is then opened again with the browser's on and the
 * pipeline rebuilt over it. A failure later in the call keeps the raw
 * microphone until the next one is opened.
 *
 * Resolves the stream the join goes on with (null: listen-only, the user
 * told), or `superseded` when a leave, another join or a newer rebuild took
 * over during the re-open, which has then stopped what it opened.
 */
async function buildJoinMicPipeline(stream: MediaStream, mode: 'server' | 'dm'): Promise<MediaStream | null | 'superseded'> {
  const rnnoiseTried = rnnoiseWanted();
  const result = await rebuildMicPipeline(stream, mode);
  // Failed at this start: it was to run, the failure listener has marked it
  // unavailable meanwhile, and nothing runs (a context that did not render in
  // time is not reported, and is left as it is)
  const failedAtStart = rnnoiseTried && useSettingsStore.getState().noiseSuppressionUnavailable && getSuppressedStream() === null;
  if (result === 'superseded' || !failedAtStart) return stream;

  const generation = micPipelineGeneration;
  const session = voiceSessionGeneration;
  const overtaken = () => generation !== micPipelineGeneration || session !== voiceSessionGeneration;
  const reopened = await reopenMicWithBrowserSuppression(stream, overtaken);
  if (overtaken()) {
    reopened?.getTracks().forEach((track) => track.stop());
    return 'superseded';
  }
  if (!reopened) {
    // Listen-only: the detector built on the stopped track goes with it
    onSpeakingChange(null);
    stopSpeakingDetection();
    return null;
  }
  if (await rebuildMicPipeline(reopened, mode) === 'superseded') {
    reopened.getTracks().forEach((track) => track.stop());
    return 'superseded';
  }
  return reopened;
}

/**
 * Open the microphone of `old` again, with the browser's own noise
 * suppression on. The old track is stopped FIRST: while a source is live,
 * Chromium hands a new getUserMedia that same source, processed as it was
 * opened, so opening before stopping gives the same unsuppressed audio. The
 * device is the one `old` was actually on. If that open fails, the microphone
 * is opened again as before, without the browser's suppression (the old one
 * is gone); if that fails too, null: the join goes on listen-only and the user
 * is told, as when a join cannot open one. Nothing more is opened once
 * `overtaken` says the join no longer owns the pipeline.
 */
async function reopenMicWithBrowserSuppression(old: MediaStream, overtaken: () => boolean): Promise<MediaStream | null> {
  const deviceId = old.getAudioTracks()[0]?.getSettings?.().deviceId || useSettingsStore.getState().audioInputDeviceId;
  const device: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : {};
  old.getTracks().forEach((track) => track.stop());
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(true), ...device } });
  } catch (err) {
    console.warn('[Voice] Could not open the microphone again with the browser\'s noise suppression, opening it as before:', err);
  }
  if (overtaken()) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(false), ...device } });
  } catch (err) {
    if (overtaken()) return null;
    console.warn('[Voice] Could not open the microphone again, joining in listen-only mode:', err);
    toast.warning(i18n.t('voice.toasts.micDenied'));
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
          emitSignal(signalEvent, {
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
      emitSignal(signalEvent, {
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
              emitSignal(signalEvent, {
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
          emitSignal(signalEvent, {
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
          emitSignal(signalEvent, {
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

/**
 * The one teardown of a space voice session, for every way it ends on this
 * client: the session generation moves (an in-flight join or rebuild gives
 * up), the pipeline ends (speaking detection, noise suppression and their
 * tracks), then the microphone, the SFU side, the secure-voice session and
 * the state. `tellServer` false is a channel already gone on the server (its
 * space was deleted): no voice:leave, the session and the room are gone.
 */
function endVoiceChannelSession(
  stateAccessors: { get: () => VoiceState; set: (partial: Partial<VoiceState>) => void },
  { tellServer }: { tellServer: boolean },
) {
  const { get, set } = stateAccessors;
  voiceSessionGeneration++; // cancel any in-flight join's mic acquisition
  const socket = getSocket();
  const { localStream, activeChannelId, localUserId } = get();

  // A pre-flight in progress dies with the voice session. The modal's own
  // effect also cancels, but logout REPLACES the store state before React
  // can run it — the capture tracks would never be stopped and the OS
  // "sharing your screen" indicator would stay lit until app restart.
  get().cancelPendingShare();

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

  if (socket && tellServer) {
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
  pendingShare: null,
  screenShareSourceKey: null,
  shareKind: 'screen',
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
          toast.error(i18n.t('voice.toasts.joinFailed'));
          return;
        }
        secure = record.secure === true;
      } catch (err) {
        console.error('[Voice] Channel resolution failed — refusing to join:', err);
        toast.error(i18n.t('voice.toasts.joinFailed'));
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

    const requestedInputDevice = useSettingsStore.getState().audioInputDeviceId;
    const switchesBeforeJoin = inputDeviceSwitchGeneration;
    const opened = await acquireAudioStream();
    let stream = opened?.stream ?? null;

    // Superseded while acquiring the mic (rapid channel switch / leave) —
    // release the just-acquired stream or the OS records forever
    if (generation !== voiceSessionGeneration) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }
    liveInputDeviceId = inputDeviceOf(opened, requestedInputDevice);

    const { selfMute, selfDeaf } = get();
    const isPTT = settings.voiceMode === 'push_to_talk';

    if (stream) {
      // RNNoise noise suppression, then speaking detection on its output (the
      // raw stream when suppression is off or failed; failing at this start,
      // the mic is opened again with the browser's own); the mic producer
      // follows the noise gate
      const built = await buildJoinMicPipeline(stream, 'server');
      // Superseded while the pipeline started (a leave, another join): only
      // this join's own streams are safe to touch, the winner owns the pipelines
      if (built === 'superseded' || generation !== voiceSessionGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        if (built !== 'superseded') built?.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = built;
    }

    if (stream) {
      if (isPTT) {
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      } else {
        if (selfMute) {
          stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        }
      }
      if (opened?.onSystemDefault) noticeSystemDefaultMic();
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
    applyInputDeviceChosenDuringJoin(requestedInputDevice, switchesBeforeJoin);
  },

  leaveChannel: () => {
    endVoiceChannelSession({ get, set }, { tellServer: true });
  },

  handleVoiceChannelGone: () => {
    endVoiceChannelSession({ get, set }, { tellServer: false });
    // The share state the space-deleted handler used to reset by hand
    set({ screenShareFrozen: false, screenShareSourceKey: null, shareKind: 'screen' });
  },

  // ── mediasoup SFU handlers ─────────────────────────────────────────────

  handleTransportCreated: async (data) => {
    if (!get().activeChannelId) return;

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
              toast.error(i18n.t('voice.toasts.connectionTimedOut'));
              errback(new Error('Transport connect timeout'));
            }
          }, 10000);
          s.emit('voice:transport:connect', { transportId: sendTransport.id, dtlsParameters }, (response: { error?: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (response.error) {
              console.error('[Voice SFU] Send transport DTLS connect failed:', response.error);
              toast.error(i18n.t('voice.toasts.connectionFailed'));
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
              toast.error(i18n.t('voice.toasts.connectionLost', { attempt: transportRejoinAttempts, max: MAX_TRANSPORT_REJOIN_ATTEMPTS }));
              // Screen share cannot survive the rejoin — release the capture stream
              // and clear state so the share button doesn't stay stuck "on"
              const { screenStream: staleScreenStream } = get();
              if (staleScreenStream) {
                staleScreenStream.getTracks().forEach((t) => t.stop());
              }
              set({ screenStream: null, isScreenSharing: false, screenSharingUserId: null, screenShareFrozen: false, screenShareSourceKey: null, shareKind: 'screen' });
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
              toast.error(i18n.t('voice.toasts.connectionFailedManual'));
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
      await produceMic(sendTransport, device);
    } catch (err) {
      console.error('[Voice SFU] Failed to set up mediasoup:', err);
      toast.error(i18n.t('voice.toasts.establishFailed'));
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

  setChannelUsers: (channelId: string, users: VoiceUser[], serverId?: string, source?: 'connect') => {
    debugLog('[Voice] setChannelUsers:', channelId, users.length, 'users', source ?? 'join');
    // A snapshot replay for the channel we are (re)joining ourselves: our own
    // voice:join answers with the fresh list (and voice:user_joined for us),
    // and the snapshot — read, then one DB round trip, then sent — can land
    // AFTER it, with our previous session and peers who left back in the
    // list, and would re-key every one of them in a secure channel.
    if (source === 'connect' && channelId === get().activeChannelId) {
      debugLog('[Voice] setChannelUsers: snapshot for the active channel ignored (the re-join replays it)');
      return;
    }
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
    // The same-session case still REFRESHES the row below: an announcement
    // carries the participant's current mute/deaf flags, and a stale ghost
    // entry (a missed voice:user_left before this re-join) would otherwise
    // keep showing the flags of the session that ended. It just never re-keys.
    const sameSession = !!listed && listed.deviceId === user.deviceId && listed.epoch === user.epoch;

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
    // never decrypts past audio (spec §21). Self echo is skipped, and so is a
    // re-announcement of a session already keyed.
    if (!sameSession && user.id !== get().localUserId && activeSecureVoiceSession(channelId)) {
      void import('../services/e2e/secureVoiceKeys')
        .then((m) => m.onParticipantJoined(channelId, user, { initialReplay: false }))
        .catch((err) => console.error('[SecureVoice] Arrival keying failed:', err));
    }
  },

  removeUserFromChannel: (channelId: string, userId: string, epoch?: string) => {
    debugLog('[Voice] removeUserFromChannel:', channelId, userId);

    // A departure naming the E2E epoch of another session than the one listed
    // for this participant (a late event of their previous session, after the
    // new one was announced) changes nothing. Without an epoch on both sides
    // it applies as before.
    if (epoch) {
      const listed = (get().channelUsers.get(channelId) || []).find((u) => u.id === userId);
      if (listed?.epoch && listed.epoch !== epoch) {
        debugLog('[Voice] removeUserFromChannel: departure of a previous session ignored:', channelId, userId);
        return false;
      }
    }

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
        .then((m) => m.onParticipantLeft(channelId, userId, epoch))
        .catch((err) => console.error('[SecureVoice] Departure rotation failed:', err));
    }
    return true;
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

  handleVoiceError: (data) => {
    const { activeChannelId, dmCallConversationId } = get();
    // A channel-scoped notice (the session takeover) about a channel this
    // client is no longer in — it moved on, perhaps evicting the other device
    // in turn — must not end the call it is in now
    if (data.channelId && data.channelId !== activeChannelId) return false;
    if (activeChannelId) get().leaveChannel();
    if (dmCallConversationId) get().leaveDMCall();
    return true;
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

  toggleMute: () => {
    const socket = getSocket();
    const { selfMute, localStream, msProducers, activeChannelId, dmCallConversationId, localUserId, channelUsers } = get();
    const newMute = !selfMute;

    // If trying to unmute but server-muted, block it
    if (!newMute && activeChannelId && localUserId) {
      const users = channelUsers.get(activeChannelId) || [];
      const me = users.find((u) => u.id === localUserId);
      if (me?.serverMuted) {
        toast.warning(i18n.t('voice.toasts.mutedByModerator'));
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
        toast.warning(i18n.t('voice.toasts.deafenedByModerator'));
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
    const { activeChannelId, msSendTransport, msDevice, isScreenSharing, screenStream, pendingShare } = get();
    if (!socket || !activeChannelId || !msSendTransport || !msDevice) return;
    if (pendingShare || shareActivationInFlight) return; // a pre-flight or activation is already in progress

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
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
    } catch (err) {
      // A getDisplayMedia permission cancel is a deliberate user action — no toast
      const isUserCancel = err instanceof DOMException && err.name === 'NotAllowedError';
      if (!isUserCancel) {
        console.warn('[Voice] Screen capture failed:', err);
        toast.error(i18n.t('voice.toasts.screenShareFailed'));
      }
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      toast.error(i18n.t('voice.toasts.screenShareFailed'));
      return;
    }
    const settings = videoTrack.getSettings() as { displaySurface?: string; width?: number; height?: number };
    const sourceKey = sourceKeyFromSettings(settings);
    const displaySurface = typeof settings.displaySurface === 'string' && settings.displaySurface ? settings.displaySurface : 'unknown';

    // Masks are placed BEFORE the first frame leaves this machine: the
    // pre-flight shows the capture locally (nothing claimed, nothing
    // produced), applies the remembered layout, and only "Go live" starts
    // the share — with the compositor already in front of the producer.
    if (loadAnnotationPrefs().skipPreflight) {
      if (displaySurface === 'monitor') {
        // The one nudge that survives the skip: a whole screen shows
        // notifications and every other window
        toast.warning(i18n.t('voice.preflight.monitorNudge'));
      }
      set({ pendingShare: { stream, sourceKey, displaySurface } }); // the layout auto-apply keys off this
      await get().confirmPendingShare();
      return;
    }

    set({ pendingShare: { stream, sourceKey, displaySurface } });
    // The OS "stop sharing" control ends the track mid-pre-flight
    videoTrack.onended = () => {
      if (get().pendingShare?.stream === stream) get().cancelPendingShare();
    };
  },

  startWhiteboardShare: async () => {
    const socket = getSocket();
    const { activeChannelId, msSendTransport, msDevice, isScreenSharing, pendingShare, secureVoiceActive } = get();
    if (!socket || !activeChannelId || !msSendTransport || !msDevice) return;
    if (pendingShare || shareActivationInFlight || isScreenSharing) return;
    // Secure voice is audio-only (spec §21) — the UI hides the button; this
    // is the belt (the server would refuse the producer anyway)
    if (secureVoiceActive) return;
    const board = createWhiteboardStream();
    if (!board) {
      toast.error(i18n.t('voice.toasts.screenShareFailed'));
      return;
    }
    // A fixed source key that can never collide with a remembered SCREEN
    // layout ('unknown:1920x1080' is a real getSettings shape for captures
    // without displaySurface). No layout can ever be saved under it — the
    // mask tool is hidden on a whiteboard.
    set({ screenShareSourceKey: `whiteboard:${WHITEBOARD_WIDTH}x${WHITEBOARD_HEIGHT}` });
    await get().activateScreenShare(board.stream, 'whiteboard');
  },

  confirmPendingShare: async () => {
    const pending = get().pendingShare;
    if (!pending) return;
    set({ pendingShare: null, screenShareSourceKey: pending.sourceKey });
    await get().activateScreenShare(pending.stream);
  },

  cancelPendingShare: () => {
    const pending = get().pendingShare;
    if (!pending) return;
    set({ pendingShare: null });
    pending.stream.getTracks().forEach((t) => t.stop());
    // Masks placed for a share that never happened would silently apply to
    // the NEXT share of anything
    try {
      shareMaskHooks?.clearPreflightMasks();
    } catch (err) {
      console.warn('[Voice] Pre-flight mask cleanup failed:', err);
    }
  },

  activateScreenShare: async (stream: MediaStream, kind: 'screen' | 'whiteboard' = 'screen') => {
    const socket = getSocket();
    const { msSendTransport, msDevice } = get();
    if (!socket || !get().activeChannelId || !msSendTransport || !msDevice) {
      stream.getTracks().forEach((t) => t.stop());
      set({ screenShareSourceKey: null }); // confirm stamped it; nothing went live
      shareMaskHooks?.clearPreflightMasks();
      return;
    }

    const createdProducers: Producer[] = [];
    shareActivationInFlight = true;
    // Read BEFORE the claim: the up-to-5s ack window is exactly where a
    // concurrent sharer-stop broadcast used to wipe the pre-flight masks
    // (the lifecycle guard now also keeps them while an activation is in
    // flight — this pre-read is the belt for the produce decision).
    const masksPreplaced = shareMaskHooks?.hasMasks() === true;
    try {
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

      // Bail if we left voice while awaiting the slot claim
      if (!get().activeChannelId) {
        throw new Error('Left voice channel during screen share setup');
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState !== 'live' || !msDevice.canProduce('video')) {
        throw new Error('Cannot produce screen video');
      }

      // 'detail' prioritizes resolution/sharpness over frame rate — right for
      // desktop content. Without encodings the producer gets a default bitrate
      // far too low for 1080p, leaving viewers in permanent blur.
      videoTrack.contentHint = 'detail';

      // Masks placed in the pre-flight: the producer is born with the
      // COMPOSITED track — the raw track never becomes a producer track, so
      // not one raw frame can ship ahead of the compositor. FAIL-CLOSED: if
      // the compositor cannot start, there is no share.
      let produceTrack: MediaStreamTrack = videoTrack;
      if (masksPreplaced) {
        const composite = shareMaskHooks
          ? await prepareComposite(shareMaskHooks.preflightCompositeHandles(videoTrack))
          : null;
        if (!composite) {
          throw new Error('Privacy mask compositor failed to start');
        }
        produceTrack = composite;
      }
      // stopTracks:false — mediasoup must NOT own the capture track's lifecycle:
      // its default replaceTrack() behavior STOPS the old track, which would
      // kill the raw capture the mask compositor reads from (stopScreenShare
      // stops screenStream tracks explicitly). disableTrackOnPause:false +
      // zeroRtpOnPause:true — the compositor's fail-closed pause must suppress
      // RTP at the sender WITHOUT disabling the shared raw track (a disabled
      // track delivers black frames to the compositor's source video).
      const videoProducer = await msSendTransport.produce({
        track: produceTrack,
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
      if (masksPreplaced) {
        // The compositor session was built before the producer existed — give
        // it its real handles now (mask removal restores the raw track, the
        // fail-closed and source-hold paths pause/resume RTP)
        attachCompositeProducerHandles({
          replaceTrack: (track) => get().replaceScreenVideoTrack(track),
          pauseProducer: () => get().setScreenVideoProducerPaused(true),
          resumeProducer: () => get().setScreenVideoProducerPaused(false),
        });
      }
      // The pre-flight's onended went dead when confirm cleared pendingShare,
      // and the handler below is not installed yet — a capture that ended
      // during the produce round-trip would otherwise leave a "live" share
      // with a dead track and no event left to fire.
      if (videoTrack.readyState !== 'live') {
        throw new Error('Screen capture ended during setup');
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

      // Second half of the ended-mid-setup window: onended may have run
      // stopScreenShare during the audio produce await — the set below would
      // resurrect a "live" share whose producer is already closed.
      if (!get().activeChannelId || videoTrack.readyState !== 'live') {
        throw new Error('Screen capture ended during setup');
      }
      set({
        screenStream: stream,
        isScreenSharing: true,
        // Set by confirmPendingShare for the pre-flight path; derived here
        // for completeness (skip path passes through confirm too)
        screenShareSourceKey: get().screenShareSourceKey
          ?? sourceKeyFromSettings(videoTrack.getSettings() as { displaySurface?: string; width?: number; height?: number }),
        screenShareAnnotationsVersion: typeof startResponse.annotationsVersion === 'number' ? startResponse.annotationsVersion : 1,
        shareKind: kind,
      });
    } catch (err) {
      console.warn('[Voice] Screen share cancelled or failed:', err);
      // Roll back everything: close half-created producers on BOTH sides,
      // release the capture stream (clears the OS capture indicator), and
      // free the sharer slot on the server.
      const s = getSocket();
      // With pre-flight masks the compositor session CAN already be live here
      // (prepareComposite ran before produce) — kill its draw loop with the
      // producers; the raw stream tracks are stopped below.
      teardownComposite();
      const producers = new Map(get().msProducers);
      for (const producer of createdProducers) {
        if (s) s.emit('voice:producer:close', { producerId: producer.id });
        if (!producer.closed) producer.close();
        producers.delete(producer.id);
      }
      set({ msProducers: producers });
      stream?.getTracks().forEach((track) => track.stop());
      // Emitted even when the claim SEEMED to fail: a lost ack can leave the
      // server believing we hold the slot (the stop handler no-ops for
      // non-sharers), and the echoed stop broadcast is what clears a
      // stranded sharer id — and with it any stale pre-flight drafts.
      if (s) s.emit('voice:screen_share:stop');
      // The stale key would make maskLayoutStore misread the NEXT pre-flight's
      // cancel as a confirm; the masks would silently composite over the next
      // share of anything (same rationale as cancelPendingShare).
      set({ screenStream: null, isScreenSharing: false, screenShareSourceKey: null, shareKind: 'screen' });
      try {
        shareMaskHooks?.clearPreflightMasks();
      } catch (hookErr) {
        console.warn('[Voice] Pre-flight mask cleanup failed:', hookErr);
      }
      // A getDisplayMedia permission cancel is a deliberate user action — no toast
      const isUserCancel = err instanceof DOMException && err.name === 'NotAllowedError';
      if (!isUserCancel) {
        toast.error(i18n.t('voice.toasts.screenShareFailed'));
      }
    } finally {
      shareActivationInFlight = false;
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
      shareKind: 'screen',
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

    // A read-only conversation (the other side's account was deleted) has no
    // calls, by any path: refused before anything is left, acquired or sent.
    // Dynamic import per the resetStores eval-cycle rule.
    // The removals applied so far: one applied while the call is set up stops it before its join
    let removalCheck: { dm: typeof import('./dmStore'); mark: number } | null = null;
    try {
      const dm = await import('./dmStore');
      const { useDMStore } = dm;
      removalCheck = { dm, mark: useDMStore.getState().removalSeq };
      if (isHeldReadOnly(useDMStore.getState(), conversationId)) {
        console.warn('[DMVoice] Refusing a call in a read-only conversation');
        if (get().incomingCall?.conversationId === conversationId) set({ incomingCall: null });
        return;
      }
    } catch (err) {
      // the conversation state could not be read: the server decides on the join
      console.warn('[DMVoice] Could not check whether the conversation is read-only:', err);
    }

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

    const requestedInputDevice = useSettingsStore.getState().audioInputDeviceId;
    const switchesBeforeJoin = inputDeviceSwitchGeneration;
    const opened = await acquireAudioStream();
    let stream = opened?.stream ?? null;

    // Superseded while acquiring the mic — release it (see joinChannel)
    if (generation !== voiceSessionGeneration) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }
    liveInputDeviceId = inputDeviceOf(opened, requestedInputDevice);

    const { selfMute, selfDeaf } = get();
    const isPTT = settings.voiceMode === 'push_to_talk';

    if (stream) {
      // RNNoise noise suppression, then speaking detection on its output
      // (read-only side-chain; DM calls never gate). Failing at this start,
      // the mic is opened again with the browser's own
      const built = await buildJoinMicPipeline(stream, 'dm');
      // Superseded while the pipeline started — release only this join's streams
      if (built === 'superseded' || generation !== voiceSessionGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        if (built !== 'superseded') built?.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = built;
    }

    if (stream) {
      if (isPTT) {
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      } else {
        if (selfMute) {
          stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        }
      }
      if (opened?.onSystemDefault) noticeSystemDefaultMic();
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
      // the account signed out during the imports above: nothing to warm
      if (isE2ESessionEnded(err)) console.debug('[DMVoice] Device-list pre-warm skipped: the session ended');
      else console.warn('[DMVoice] Device-list pre-warm setup failed:', err);
    }

    if (generation !== voiceSessionGeneration) return; // superseded during the async imports

    // Removed (here or on another device) while the call was set up: no join,
    // and the stream it opened is stopped (nothing was emitted to undo)
    if (removalCheck?.dm.wasRemovedSince(conversationId, removalCheck.mark)) {
      console.warn('[DMVoice] Not joining a call of a conversation removed while it was set up');
      get().handleDMCallEnded();
      return;
    }

    socket.emit('dm:voice:join', conversationId, { selfMute: serverMute, selfDeaf, deviceId });
    get().startLatencyMeasurement();
    applyInputDeviceChosenDuringJoin(requestedInputDevice, switchesBeforeJoin);
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

  handleDMVoiceEnded: ({ conversationId, rejoin }) => {
    const voiceState = get();
    if (rejoin === true) {
      // The answer to this device's re-join names only the conversation, and
      // is about the call that sent it: acted on while that call is still the
      // current session, never once it was hung up (and perhaps placed again
      // with the same person). A ring is another call's, left alone
      if (dmRejoinSentUnder === voiceSessionGeneration && voiceState.dmCallConversationId === conversationId) {
        voiceState.handleDMCallEnded();
      } else {
        debugLog('[DMVoice] Ignoring the answer to a re-join of a call that has since ended', conversationId);
      }
      return;
    }
    if (voiceState.dmCallConversationId === conversationId) {
      // Full teardown without emitting dm:voice:leave back (the call was
      // already ended server-side). Must go through the store action: an
      // inline cleanup here once left the E2E device pin, signal chains,
      // and callCrypto session state stale for the next call.
      voiceState.handleDMCallEnded();
    }
    if (voiceState.incomingCall?.conversationId === conversationId) {
      voiceState.setIncomingCall(null);
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

// Subscribe to input device changes — hot-swap mic while in a call.
// The picker is a native <select>: arrowing through it changes the device on
// every key press, so several switches overlap. Each one opens its device in
// parallel; only the LATEST choice is installed, whatever order getUserMedia
// answers in, and a switch that lost stops the stream it opened.
let inputDeviceSwitchGeneration = 0;

/** Set while a failed switch puts the picker back: that change is not a choice. */
let revertingInputDevice = false;

/** Stop a stream the call no longer uses (it is not the live localStream). */
function stopIfRetired(stream: MediaStream | null) {
  if (stream && useVoiceStore.getState().localStream !== stream) {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** Whether the microphone should be open now: push-to-talk held, or not muted
 *  (in a DM call track.enabled is the only mute; push-to-talk overrides mute). */
function micShouldBeOpen(): boolean {
  const isPTT = useSettingsStore.getState().voiceMode === 'push_to_talk';
  const state = useVoiceStore.getState();
  return isPTT ? state.pttActive : !state.selfMute;
}

/** A failed switch: tell the user, and put the picker back on the device the call uses. */
function reportFailedSwitch() {
  toast.error(i18n.t('voice.toasts.micSwitchFailed'));
  if (useSettingsStore.getState().audioInputDeviceId === liveInputDeviceId) return;
  revertingInputDevice = true;
  try {
    useSettingsStore.getState().setAudioInputDeviceId(liveInputDeviceId);
  } finally {
    revertingInputDevice = false;
  }
}

/**
 * The microphone has nothing to go out on yet: the call was joined
 * listen-only (a refused permission, a device that would not open). Server
 * voice makes the mic producer now; a DM call adds the track to each peer,
 * which renegotiates (perfect negotiation, sealed signalling). Called at the
 * end of every rebuild that went through; a no-op while something sends, and
 * before a join has a send transport or a peer. Never throws: a produce the
 * server refuses is told to the user, as at a join.
 */
async function sendNewMicIfNothingSends(stream: MediaStream, mode: 'server' | 'dm') {
  const state = useVoiceStore.getState();
  if (mode === 'server') {
    if (!state.activeChannelId || !state.msSendTransport || !state.msDevice || state.msSendTransport.closed) return;
    if ([...state.msProducers.values()].some((p) => isMicProducer(p) && !p.closed)) return;
    // One being made already: it takes the current track when it lands
    if (micProduceInFlight === state.msSendTransport) return;
    try {
      await produceMic(state.msSendTransport, state.msDevice);
    } catch (err) {
      console.error('[Voice SFU] Could not send the new microphone:', err);
      toast.error(i18n.t('voice.toasts.establishFailed'));
    }
    return;
  }
  const source = getSuppressedStream() || stream;
  const track = source.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') return;
  for (const [peerId, peerConn] of state.peers.entries()) {
    if (peerConn.pc.getSenders().some((s) => s.track?.kind === 'audio')) continue;
    try {
      peerConn.pc.addTrack(track, source);
      debugLog(`[DMVoice] Added the new microphone to the call with ${peerId}`);
    } catch (err) {
      console.error(`[DMVoice] Could not add the new microphone to the call with ${peerId}:`, err);
    }
  }
}

async function switchInputDevice(switchGeneration: number, session: number) {
  const wanted = () => switchGeneration === inputDeviceSwitchGeneration && session === voiceSessionGeneration;
  const requested = useSettingsStore.getState().audioInputDeviceId;

  const next = (await acquireAudioStream({ quiet: true }))?.stream ?? null;
  if (!wanted()) {
    // A newer choice, a leave or another call took over: only this switch's
    // own stream is stopped
    next?.getTracks().forEach((t) => t.stop());
    return;
  }
  if (!next) {
    // The device could not be opened: the call keeps the one it has
    reportFailedSwitch();
    return;
  }

  // Mute and push-to-talk as they are NOW, when the stream goes live
  next.getAudioTracks().forEach((track) => { track.enabled = micShouldBeOpen(); });

  const before = useVoiceStore.getState();
  const previous = before.localStream;
  useVoiceStore.setState({ localStream: next });
  const mode = before.dmCallConversationId ? 'dm' : 'server';
  const result = await rebuildMicPipeline(next, mode);
  if (result !== 'swap-failed') {
    // Installed (a call that sent nothing now sends it: the rebuild did), or
    // taken over by a newer rebuild (another switch, the noise-suppression
    // toggle, a leave): either way `previous` is retired. It stays open until
    // here, so a refused swap can go back to it.
    stopIfRetired(previous);
    if (result === 'ok' && wanted()) liveInputDeviceId = requested;
    return;
  }

  // A producer or a peer refused the new track: back on the previous device
  if (!previous || !wanted()) {
    toast.error(i18n.t('voice.toasts.micSwitchFailed'));
    stopIfRetired(previous);
    return;
  }
  // Its tracks still say what they said before the switch: a mute (or a
  // push-to-talk release) since then must hold on them too
  previous.getAudioTracks().forEach((track) => { track.enabled = micShouldBeOpen(); });
  useVoiceStore.setState({ localStream: previous });
  next.getTracks().forEach((t) => t.stop());
  reportFailedSwitch();
  const restored = await rebuildMicPipeline(previous, mode);
  if (restored === 'swap-failed') console.error('[Voice] The previous microphone could not be restored either');
}

/** Start switching to the device the settings name (the latest choice wins). */
function startInputDeviceSwitch() {
  const switchGeneration = ++inputDeviceSwitchGeneration;
  switchInputDevice(switchGeneration, voiceSessionGeneration).catch((err) => {
    console.error('[Voice] Input device switch failed:', err);
  });
}

/**
 * After a join: the user may have picked another device while it opened the
 * microphone (the subscription below ignores a change made outside a call).
 * The join's stream was opened for `requested`; switch when the choice moved.
 */
function applyInputDeviceChosenDuringJoin(requested: string, switchesBeforeJoin: number) {
  // A switch already started during the join (a DM join counts as in a call
  // before its last awaits): it owns the device from here
  if (inputDeviceSwitchGeneration !== switchesBeforeJoin) return;
  if (useSettingsStore.getState().audioInputDeviceId !== requested) startInputDeviceSwitch();
}

useSettingsStore.subscribe((state, prevState) => {
  if (state.audioInputDeviceId === prevState.audioInputDeviceId) return;
  if (revertingInputDevice) return;

  const voiceState = useVoiceStore.getState();
  if (!voiceState.activeChannelId && !voiceState.dmCallConversationId) return;

  startInputDeviceSwitch();
});

// Handle live noise suppression toggle while in a call (rebuildMicPipeline
// orders it against every other rebuild: the latest wins)
useSettingsStore.subscribe((state, prevState) => {
  if (state.enableNoiseSuppression === prevState.enableNoiseSuppression) return;
  // A toggle is the user asking again: an earlier failure this session no
  // longer holds RNNoise off
  if (state.noiseSuppressionUnavailable) state.setNoiseSuppressionUnavailable(false);

  const voiceState = useVoiceStore.getState();
  if (!voiceState.activeChannelId && !voiceState.dmCallConversationId) return;
  if (!voiceState.localStream) return;

  const mode = voiceState.dmCallConversationId ? 'dm' : 'server';
  rebuildMicPipeline(voiceState.localStream, mode).catch((err) => {
    console.error('[Voice] Noise suppression toggle failed:', err);
  });
});

/** The unavailability notice is shown once per app session. */
let noiseSuppressionNoticeShown = false;

/** Test-only: a fresh app session as far as that notice goes. */
export function _resetNoiseSuppressionNoticeForTests(): void {
  noiseSuppressionNoticeShown = false;
}

// Noise suppression failed: its worklet did not load or its processor threw,
// at the start of a pipeline (that caller already went on with the raw mic)
// or during the call (the outgoing audio went silent: rebuild on the raw mic
// and swap the tracks). For the rest of this app session pipelines run on the
// raw mic, with the browser's own suppression asked for. The saved preference
// is NEVER changed: it is tried again at the next app start, or when the user
// toggles it; Settings says it is not active meanwhile. Told once per session.
onNoiseSuppressionFailure(({ phase, reason, rawStream }) => {
  console.warn(`[NoiseSuppression] Unavailable for this session (${phase}, ${reason}): the mic goes out without it`);
  setNoiseSuppression(false);
  useSettingsStore.getState().setNoiseSuppressionUnavailable(true);
  if (!noiseSuppressionNoticeShown) {
    noiseSuppressionNoticeShown = true;
    toast.warning(i18n.t('voice.toasts.noiseSuppressionUnavailable'));
  }
  if (phase !== 'running') return;
  // The kind of pipeline that was running, read from the detector itself: a
  // secure join builds its pipeline before activeChannelId is set
  const mode = getSpeakingDetectionMode();
  if (!mode) return; // nothing running: the call ended meanwhile
  rebuildMicPipeline(rawStream, mode).then((result) => {
    if (result === 'swap-failed') toast.error(i18n.t('voice.toasts.micIssue'));
  }).catch((err) => {
    console.error('[NoiseSuppression] Fallback to the raw mic failed:', err);
  });
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

  // Every voice occupancy list is stale the moment the socket was gone: the
  // leaves that happened meanwhile never reached this client, and the server's
  // connect-time replay only names channels that still HAVE occupants — a
  // channel that emptied while we were away was never replayed, so its last
  // known occupants stayed on screen for good. Cleared synchronously, BEFORE
  // any await: the replay (voice:channel_users per occupied channel, then
  // our own re-join's events) arrives after this handler ran and rebuilds the
  // lists from the server's truth. The channel→server map stays: it is a fact
  // about channels, not about who is in them.
  useVoiceStore.setState({ channelUsers: new Map() });

  const socket = getSocket();
  if (!socket) return;

  if (!activeChannelId && !dmCallConversationId) return;
  // A leave or another join while this handler awaits ends this re-join
  const session = voiceSessionGeneration;

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
    screenShareFrozen: false,
    // Stale key = maskLayoutStore misreads the next pre-flight cancel as a confirm
    screenShareSourceKey: null,
    shareKind: 'screen',
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
    const requestedInputDevice = useSettingsStore.getState().audioInputDeviceId;
    const reopened = await acquireAudioStream();
    const newStream = reopened?.stream ?? null;
    if (session !== voiceSessionGeneration) {
      // The call ended (or another began) while the mic opened: nothing to re-join
      newStream?.getTracks().forEach((t) => t.stop());
      return;
    }
    const meanwhile = useVoiceStore.getState().localStream;
    if (meanwhile !== localStream) {
      // A device switch installed a stream meanwhile: it is the live one
      newStream?.getTracks().forEach((t) => t.stop());
      localStream = meanwhile;
    } else {
      localStream = newStream;
      useVoiceStore.setState({ localStream: newStream });
      liveInputDeviceId = inputDeviceOf(reopened, requestedInputDevice);
      if (reopened?.onSystemDefault) noticeSystemDefaultMic();
    }
  }

  const { selfMute, selfDeaf } = useVoiceStore.getState();
  const settings = useSettingsStore.getState();
  const isPTT = settings.voiceMode === 'push_to_talk';

  // Apply mute state to the (possibly new) stream
  if (localStream) {
    const shouldDisable = isPTT || selfMute;
    localStream.getAudioTracks().forEach((track) => { track.enabled = !shouldDisable; });
  }

  // Restart audio pipelines BEFORE emitting voice:join (the producer and the
  // peers are made again afterwards, from the new pipeline's streams)
  if (localStream) {
    const mode = dmCallConversationId ? 'dm' : 'server';
    try {
      await rebuildMicPipeline(localStream, mode);
    } catch (err) {
      console.error('[Voice] Audio pipeline rebuild failed on reconnect:', err);
      // Fallback: use raw stream for speaking detection
      startSpeakingDetection(localStream, mode);
      if (mode === 'server') onSpeakingChange(followSpeakingWithMicProducer);
    }
    // The call ended (or another began) while the pipeline started: there is
    // nothing to re-join, and the new session owns the pipelines
    if (session !== voiceSessionGeneration) return;
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
    // The call ended (the peer hung up, a leave, another call) while the
    // device id was resolved, which can wait for the E2E start: nothing to
    // re-join, and a join now would start a new call ringing the other person
    if (session !== voiceSessionGeneration) return;
    // the conversation turned read-only meanwhile (the other side's account
    // was deleted): no re-join of a call it can no longer have
    const { useDMStore } = await import('./dmStore');
    if (session !== voiceSessionGeneration) return;
    if (isHeldReadOnly(useDMStore.getState(), dmCallConversationId)) {
      console.warn('[DMVoice] Not re-joining a call in a read-only conversation');
    } else {
      // `rejoin`: the server rebinds this account's place in that call, and
      // answers dm:voice:ended marked `rejoin` when the call ended while the
      // socket was away (a server older than the flag ignores it and starts a
      // new call then). That answer is acted on only under this generation
      const { dmCallUsers, localUserId } = useVoiceStore.getState();
      const placeConfirmed = !!localUserId && dmCallUsers.some((u) => u.id === localUserId);
      if (placeConfirmed) dmRejoinSentUnder = session;
      socket.emit('dm:voice:join', dmCallConversationId, { selfMute: isPTT ? true : selfMute, selfDeaf, deviceId, ...(placeConfirmed && { rejoin: true }) });
    }
  }

  // Re-start latency measurement with new socket
  useVoiceStore.getState().startLatencyMeasurement();
});
