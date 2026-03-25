import { create } from 'zustand';
import { Device } from 'mediasoup-client';
import type { Transport, Producer, Consumer, RtpCapabilities, IceParameters, IceCandidate, DtlsParameters, RtpParameters } from 'mediasoup-client/types';
import { getSocket, onSocketReconnect } from '../services/socket';
import { startSpeakingDetection, stopSpeakingDetection, setNoiseGateThreshold, getGatedStream, setNoiseSuppression, onSpeakingChange, applyNoiseSuppression, getSuppressedStream, stopNoiseSuppression, setSpeakingDetectionPaused } from '../services/audioAnalyser';
import { useSettingsStore, VOICE_QUALITY_BITRATE } from './settingsStore';
import { toast } from './toastStore';
import { optimizeOpusSDP } from '../services/sdpUtils';
import type { VoiceUser, TransportOptions } from '@voxium/shared';

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

interface PeerConnection {
  pc: RTCPeerConnection;
  makingOffer: boolean;
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

  // mediasoup SFU state
  msDevice: Device | null;
  msSendTransport: Transport | null;
  msRecvTransport: Transport | null;
  msProducers: Map<string, Producer>;
  msConsumers: Map<string, { consumer: Consumer; producerUserId: string }>;

  // ─── Screen Share State ──────────────────────────────────────────
  screenStream: MediaStream | null;
  isScreenSharing: boolean;
  screenSharingUserId: string | null;
  remoteScreenStream: MediaStream | null;
  screenShareViewMode: 'inline' | 'floating';

  // ─── DM Call State ─────────────────────────────────────────────────
  dmCallConversationId: string | null;
  dmCallUsers: VoiceUser[];
  incomingCall: { conversationId: string; from: VoiceUser } | null;

  // ─── Shared Actions ────────────────────────────────────────────────
  setLocalUserId: (userId: string) => void;
  toggleMute: () => void;
  toggleDeaf: () => void;
  startLatencyMeasurement: () => void;
  stopLatencyMeasurement: () => void;
  destroyPeer: (userId: string) => void;
  destroyAllPeers: () => void;

  // ─── Server Voice Actions (SFU) ────────────────────────────────────
  joinChannel: (channelId: string, serverId?: string) => Promise<void>;
  leaveChannel: () => void;
  setChannelUsers: (channelId: string, users: VoiceUser[]) => void;
  addUserToChannel: (channelId: string, user: VoiceUser) => void;
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

  // ─── DM Call Actions ───────────────────────────────────────────────
  joinDMCall: (conversationId: string) => Promise<void>;
  leaveDMCall: () => void;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  setIncomingCall: (data: { conversationId: string; from: VoiceUser } | null) => void;
  addDMCallUser: (user: VoiceUser) => void;
  removeDMCallUser: (userId: string) => void;
  updateDMCallUserState: (userId: string, selfMute: boolean, selfDeaf: boolean) => void;
  setDMCallUserSpeaking: (userId: string, speaking: boolean) => void;
  handleDMSignal: (from: string, signal: unknown) => void;
  createDMPeer: (targetUserId: string, initiator: boolean) => void;
}

let latencyInterval: ReturnType<typeof setInterval> | null = null;
let pongHandler: ((timestamp: number) => void) | null = null;
let transportRejoinAttempts = 0;

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

/** Emit a signaling event on the socket with proper typing per event name. */
function emitSignal(
  socket: ReturnType<typeof getSocket>,
  event: SignalEvent,
  data: { to: string; signal: unknown },
) {
  if (!socket) return;
  if (event === 'dm:voice:signal') {
    socket.emit('dm:voice:signal', data);
  } else {
    socket.emit('voice:signal', data);
  }
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
  const peerConn: PeerConnection = { pc, makingOffer: false };

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
      .then(() => pc.createAnswer())
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
      .catch((err) => console.error(`${logPrefix} Error handling answer from ${from}:`, err));
  } else if (data.type === 'ice-candidate' && data.candidate) {
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

  // DM call state
  dmCallConversationId: null,
  dmCallUsers: [],
  incomingCall: null,

  setLocalUserId: (userId: string) => set({ localUserId: userId }),

  // ═══════════════════════════════════════════════════════════════════════════
  // SERVER VOICE (SFU)
  // ═══════════════════════════════════════════════════════════════════════════

  joinChannel: async (channelId: string, serverId?: string) => {
    const socket = getSocket();
    if (!socket) return;

    // Leave DM call if active (cross-cleanup)
    if (get().dmCallConversationId) {
      get().leaveDMCall();
    }

    if (get().activeChannelId) {
      get().leaveChannel();
    }

    transportRejoinAttempts = 0; // Reset retry counter on explicit join

    const settings = useSettingsStore.getState();
    setNoiseGateThreshold(settings.noiseGateThreshold);
    setNoiseSuppression(settings.enableNoiseSuppression);

    const stream = await acquireAudioStream();

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
    set({ activeChannelId: channelId, activeVoiceServerId: serverId ?? null, localStream: stream, selfMute: effectiveMute });

    // Emit voice:join — server will respond with voice:transport_created
    socket.emit('voice:join', channelId, { selfMute: serverMute, selfDeaf });

    get().startLatencyMeasurement();
  },

  leaveChannel: () => {
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

      // 2. Create send transport
      const sendTransport = device.createSendTransport({
        id: data.sendTransport.id,
        iceParameters: data.sendTransport.iceParameters as IceParameters,
        iceCandidates: data.sendTransport.iceCandidates as IceCandidate[],
        dtlsParameters: data.sendTransport.dtlsParameters as DtlsParameters,
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
        if (s) {
          s.emit('voice:produce', { kind, rtpParameters, appData }, (response: { producerId: string }) => {
            callback({ id: response.producerId });
          });
        } else {
          errback(new Error('Socket not available'));
        }
      });

      // 3. Create recv transport
      const recvTransport = device.createRecvTransport({
        id: data.recvTransport.id,
        iceParameters: data.recvTransport.iceParameters as IceParameters,
        iceCandidates: data.recvTransport.iceCandidates as IceCandidate[],
        dtlsParameters: data.recvTransport.dtlsParameters as DtlsParameters,
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
              get().cleanupSFU();
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
        });

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

    try {
      const consumer = await msRecvTransport.consume({
        id: data.id,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters as RtpParameters,
      });

      const newConsumers = new Map(get().msConsumers);
      newConsumers.set(consumer.id, { consumer, producerUserId: data.producerUserId });
      set({ msConsumers: newConsumers });

      const outputDeviceId = useSettingsStore.getState().audioOutputDeviceId;

      if (data.kind === 'audio') {
        // Create audio element for this consumer
        const container = getAudioContainer();
        const audio = document.createElement('audio');
        audio.id = `vox-sfu-audio-${data.producerUserId}`;
        audio.autoplay = true;
        audio.muted = selfDeaf;
        audio.srcObject = new MediaStream([consumer.track]);
        container.appendChild(audio);
        applyOutputDevice(audio, outputDeviceId);

        const newAudios = new Map(get().remoteAudios);
        newAudios.set(data.producerUserId, audio);
        set({ remoteAudios: newAudios });

        audio.play().catch((err) =>
          console.warn('[Voice SFU] Audio autoplay blocked for', data.producerUserId, err)
        );
      } else if (data.kind === 'video') {
        // Video consumer = screen share
        const appType = data.appData?.type;
        if (appType === 'screen-audio') {
          // Screen share audio track
          const container = getAudioContainer();
          const screenAudioKey = `${data.producerUserId}-screen`;
          const audio = document.createElement('audio');
          audio.id = `vox-sfu-audio-${screenAudioKey}`;
          audio.autoplay = true;
          audio.muted = selfDeaf;
          audio.srcObject = new MediaStream([consumer.track]);
          container.appendChild(audio);
          applyOutputDevice(audio, outputDeviceId);

          const newAudios = new Map(get().remoteAudios);
          newAudios.set(screenAudioKey, audio);
          set({ remoteAudios: newAudios });

          audio.play().catch((err) =>
            console.warn('[Voice SFU] Screen audio autoplay blocked:', err)
          );
        } else {
          // Screen share video track
          const stream = new MediaStream([consumer.track]);
          set({ remoteScreenStream: stream });

          consumer.track.onended = () => {
            set({ remoteScreenStream: null, screenSharingUserId: null });
          };
        }
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
    const { msConsumers, remoteAudios } = get();
    const entry = msConsumers.get(data.consumerId);
    if (!entry) return;

    entry.consumer.close();

    const newConsumers = new Map(msConsumers);
    newConsumers.delete(data.consumerId);
    set({ msConsumers: newConsumers });

    // Clean up audio element
    const audio = remoteAudios.get(data.producerUserId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      const newAudios = new Map(remoteAudios);
      newAudios.delete(data.producerUserId);
      set({ remoteAudios: newAudios });
    }

    // Clean up screen audio if any
    const screenAudio = remoteAudios.get(`${data.producerUserId}-screen`);
    if (screenAudio) {
      screenAudio.pause();
      screenAudio.srcObject = null;
      screenAudio.remove();
      const newAudios = new Map(get().remoteAudios);
      newAudios.delete(`${data.producerUserId}-screen`);
      set({ remoteAudios: newAudios });
    }

    // Clear screen share state if this producer was the screen sharer
    if (get().screenSharingUserId === data.producerUserId) {
      set({ remoteScreenStream: null, screenSharingUserId: null });
    }

    debugLog('[Voice SFU] Producer closed, consumer removed:', data.consumerId);
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

  setChannelUsers: (channelId: string, users: VoiceUser[]) => {
    debugLog('[Voice] setChannelUsers:', channelId, users.length, 'users');
    set((state) => {
      const newMap = new Map(state.channelUsers);
      newMap.set(channelId, users);
      // If the screen sharer is no longer in the channel, clear the stale reference
      const sharerGone = state.screenSharingUserId
        && channelId === state.activeChannelId
        && !users.some((u) => u.id === state.screenSharingUserId);
      const screenFix = sharerGone
        ? { screenSharingUserId: null, remoteScreenStream: null } as const
        : {};
      return { channelUsers: newMap, ...screenFix };
    });
    // No peer creation needed — SFU handles media routing via consumers
  },

  addUserToChannel: (channelId: string, user: VoiceUser) => {
    debugLog('[Voice] addUserToChannel:', channelId, user.displayName);

    const existing = get().channelUsers.get(channelId) || [];
    if (existing.some((u) => u.id === user.id)) return;

    set((state) => {
      const newMap = new Map(state.channelUsers);
      const current = newMap.get(channelId) || [];
      if (current.some((u) => u.id === user.id)) return state;
      newMap.set(channelId, [...current, user]);
      return { channelUsers: newMap };
    });
    // No peer creation needed — SFU creates consumers server-side
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
  },

  updateUserState: (channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean, serverMuted: boolean, serverDeafened: boolean) => {
    const { localUserId } = get();

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
        // Force our local mute state on — pause producers
        for (const producer of get().msProducers.values()) {
          if (producer.kind === 'audio') producer.pause();
        }
        set({ selfMute: true });
      }
      if (serverDeafened && !get().selfDeaf) {
        // Force our local deaf state on — mute all remote audio
        const remoteAudios = document.querySelectorAll<HTMLAudioElement>('audio[data-voice-remote]');
        remoteAudios.forEach((a) => { a.muted = true; });
        set({ selfDeaf: true });
      }
    }
  },

  handleForceMove: (targetChannelId: string) => {
    const { activeChannelId, activeVoiceServerId } = get();
    if (!activeChannelId || !activeVoiceServerId) return;
    // Leave current channel and join the target one
    get().leaveChannel();
    // Small delay to let cleanup complete before rejoining
    setTimeout(() => {
      get().joinChannel(targetChannelId, activeVoiceServerId);
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

    // Pause/resume mediasoup audio producer (server voice)
    if (activeChannelId) {
      for (const producer of msProducers.values()) {
        if (producer.kind === 'audio') {
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
      // Pause audio producers
      if (get().activeChannelId) {
        for (const producer of msProducers.values()) {
          if (producer.kind === 'audio') producer.pause();
        }
      }
      if (localStream) {
        localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
      }
      set({ selfMute: true });
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

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      // Produce video track via SFU
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && msDevice.canProduce('video')) {
        const videoProducer = await msSendTransport.produce({
          track: videoTrack,
          appData: { type: 'screen-video' },
        });

        const newProducers = new Map(get().msProducers);
        newProducers.set(videoProducer.id, videoProducer);
        set({ msProducers: newProducers });

        videoTrack.onended = () => {
          get().stopScreenShare();
        };
      }

      // Produce audio track if available (system audio from getDisplayMedia)
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const audioProducer = await msSendTransport.produce({
          track: audioTrack,
          appData: { type: 'screen-audio' },
        });

        const newProducers = new Map(get().msProducers);
        newProducers.set(audioProducer.id, audioProducer);
        set({ msProducers: newProducers });
      }

      socket.emit('voice:screen_share:start');

      set({
        screenStream: stream,
        isScreenSharing: true,
      });
    } catch (err) {
      console.warn('[Voice] Screen share cancelled or failed:', err);
      // Ensure state is clean even if getDisplayMedia was cancelled or produce failed mid-way
      set({ screenStream: null, isScreenSharing: false });
    }
  },

  stopScreenShare: () => {
    const socket = getSocket();
    const { screenStream, msProducers } = get();

    // Close screen-related producers
    const newProducers = new Map(msProducers);
    for (const [id, producer] of msProducers.entries()) {
      const appType = (producer.appData as Record<string, unknown>)?.type;
      if (appType === 'screen-video' || appType === 'screen-audio') {
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

    const settings = useSettingsStore.getState();
    setNoiseGateThreshold(settings.noiseGateThreshold);
    setNoiseSuppression(settings.enableNoiseSuppression);

    const stream = await acquireAudioStream();

    const { selfMute, selfDeaf } = get();
    const isPTT = settings.voiceMode === 'push_to_talk';

    if (stream) {
      // Apply RNNoise noise suppression (Jitsi/Matrix pattern: clean isolated pipeline)
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
      localStream: stream,
      selfMute: effectiveMute,
      incomingCall: null,
    });

    socket.emit('dm:voice:join', conversationId, { selfMute: serverMute, selfDeaf });
    get().startLatencyMeasurement();
  },

  leaveDMCall: () => {
    const socket = getSocket();
    const { localStream, dmCallConversationId } = get();

    get().stopLatencyMeasurement();
    onSpeakingChange(null);
    stopSpeakingDetection();
    stopNoiseSuppression();

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }

    get().destroyAllPeers();

    if (socket && dmCallConversationId) {
      socket.emit('dm:voice:leave', dmCallConversationId);
    }

    set({
      dmCallConversationId: null,
      dmCallUsers: [],
      localStream: null,
      latency: null,
      pttActive: false,
    });
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

  addDMCallUser: (user: VoiceUser) => {
    const { dmCallUsers } = get();
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
    handleSignalInternal('dm:voice:signal', '[DMVoice]', get().createDMPeer, from, signal, { get });
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
    // Pause SFU audio producer
    if (activeChannelId) {
      for (const producer of msProducers.values()) {
        if (producer.kind === 'audio') producer.pause();
      }
    }
  } else {
    if (!selfMute) {
      localStream.getAudioTracks().forEach((track) => { track.enabled = true; });
      if (socket) {
        if (activeChannelId) socket.emit('voice:mute', false);
        else socket.emit('dm:voice:mute', false);
      }
      // Resume SFU audio producer
      if (activeChannelId) {
        for (const producer of msProducers.values()) {
          if (producer.kind === 'audio') producer.resume();
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
    // Re-emit voice:join — server will send voice:transport_created to re-establish SFU
    socket.emit('voice:join', activeChannelId, { selfMute: isPTT ? true : selfMute, selfDeaf });
  } else if (dmCallConversationId) {
    debugLog('[DMVoice] Socket reconnected — re-joining DM call', dmCallConversationId);
    socket.emit('dm:voice:join', dmCallConversationId, { selfMute: isPTT ? true : selfMute, selfDeaf });
  }

  // Re-start latency measurement with new socket
  useVoiceStore.getState().startLatencyMeasurement();
});
