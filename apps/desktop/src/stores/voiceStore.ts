import { create } from 'zustand';
import { getSocket, onSocketReconnect } from '../services/socket';
import { startSpeakingDetection, stopSpeakingDetection, setNoiseGateThreshold } from '../services/audioAnalyser';
import { useSettingsStore } from './settingsStore';
import type { VoiceUser } from '@voxium/shared';

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
  } catch {
    // ignore parse errors
  }
  return { selfMute: false, selfDeaf: false };
}

function persistVoicePrefs(prefs: VoicePrefs) {
  try {
    localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify({
      selfMute: prefs.selfMute,
      selfDeaf: prefs.selfDeaf,
    }));
  } catch {
    // ignore storage errors
  }
}

const initialVoicePrefs = loadPersistedVoicePrefs();

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Retry delay for ICE restart (exponential backoff cap)
const ICE_RESTART_DELAY_MS = 3000;

interface PeerConnection {
  pc: RTCPeerConnection;
  makingOffer: boolean;
}

interface VoiceState {
  // ─── Shared State ──────────────────────────────────────────────────
  localUserId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  localStream: MediaStream | null;
  latency: number | null;
  peers: Map<string, PeerConnection>;
  remoteAudios: Map<string, HTMLAudioElement>;

  // ─── Server Voice State ────────────────────────────────────────────
  activeChannelId: string | null;
  channelUsers: Map<string, VoiceUser[]>;

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

  // ─── Server Voice Actions ──────────────────────────────────────────
  joinChannel: (channelId: string) => Promise<void>;
  leaveChannel: () => void;
  setChannelUsers: (channelId: string, users: VoiceUser[]) => void;
  addUserToChannel: (channelId: string, user: VoiceUser) => void;
  removeUserFromChannel: (channelId: string, userId: string) => void;
  updateUserState: (channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean) => void;
  setUserSpeaking: (channelId: string, userId: string, speaking: boolean) => void;
  handleSignal: (from: string, signal: unknown) => void;
  createPeer: (targetUserId: string, initiator: boolean) => void;

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

// Track ICE restart timers per peer so we can cancel them
const iceRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  if (deviceId && typeof (audio as any).setSinkId === 'function') {
    (audio as any).setSinkId(deviceId).catch((err: Error) => {
      console.warn('[Voice] Failed to set output device:', err);
    });
  }
}

type SignalEvent = 'voice:signal' | 'dm:voice:signal';

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
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (settings.audioInputDeviceId) {
      audioConstraints.deviceId = { exact: settings.audioInputDeviceId };
    }
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch (err) {
    console.warn('[Voice] Microphone access denied, joining in listen-only mode:', err);
    return null;
  }
}

/**
 * Shared RTCPeerConnection factory. Both server-voice `createPeer` and DM
 * `createDMPeer` delegate here — only the signal event name and log prefix differ.
 */
function createPeerInternal(
  signalEvent: SignalEvent,
  logPrefix: string,
  targetUserId: string,
  initiator: boolean,
  stateAccessors: { get: () => VoiceState; set: (partial: Partial<VoiceState>) => void },
) {
  const { get: getState, set: setState } = stateAccessors;
  const { localStream, peers, selfDeaf } = getState();
  const outputDeviceId = useSettingsStore.getState().audioOutputDeviceId;

  if (peers.has(targetUserId)) {
    getState().destroyPeer(targetUserId);
  }

  const socket = getSocket();
  if (!socket) return;

  console.log(`${logPrefix} Creating RTCPeerConnection to ${targetUserId} (initiator: ${initiator})`);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peerConn: PeerConnection = { pc, makingOffer: false };

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit(signalEvent as any, {
        to: targetUserId,
        signal: { type: 'ice-candidate', candidate: event.candidate.toJSON() },
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`${logPrefix} ICE state with ${targetUserId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.warn(`${logPrefix} ICE failed with ${targetUserId}, attempting ICE restart`);
      const existingTimer = iceRestartTimers.get(targetUserId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        iceRestartTimers.delete(targetUserId);
        const currentPeer = getState().peers.get(targetUserId);
        if (!currentPeer || currentPeer.pc !== pc) return;

        pc.createOffer({ iceRestart: true })
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            const s = getSocket();
            if (s && pc.localDescription) {
              s.emit(signalEvent as any, {
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
    console.log(`${logPrefix} Connection state with ${targetUserId}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      console.error(`${logPrefix} Connection failed permanently with ${targetUserId}`);
      getState().destroyPeer(targetUserId);
    }
  };

  pc.ontrack = (event) => {
    console.log(`${logPrefix} Got remote track from ${targetUserId}:`, event.track.kind);
    const remoteStream = event.streams[0];
    if (!remoteStream) return;

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
    audio.muted = selfDeaf;
    audio.srcObject = remoteStream;
    container.appendChild(audio);

    applyOutputDevice(audio, outputDeviceId);

    const newAudios = new Map(remoteAudios);
    newAudios.set(targetUserId, audio);
    setState({ remoteAudios: newAudios });

    audio.play()
      .then(() => console.log(`${logPrefix} Audio playing for ${targetUserId}`))
      .catch((err) => console.warn(`${logPrefix} Audio autoplay blocked for ${targetUserId}:`, err));
  };

  const newPeers = new Map(peers);
  newPeers.set(targetUserId, peerConn);
  setState({ peers: newPeers });

  if (initiator) {
    peerConn.makingOffer = true;
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        if (pc.localDescription) {
          console.log(`${logPrefix} Sending offer to ${targetUserId}`);
          socket.emit(signalEvent as any, {
            to: targetUserId,
            signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      })
      .catch((err) => console.error(`${logPrefix} Error creating offer for ${targetUserId}:`, err))
      .finally(() => { peerConn.makingOffer = false; });
  }
}

/**
 * Shared signal handler. Both `handleSignal` and `handleDMSignal` delegate
 * here — only the signal event name and peer-creation function differ.
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
  console.log(`${logPrefix} handleSignal from ${from}:`, data.type || 'ice-candidate');

  const { peers, localUserId } = getState();
  let peerConn = peers.get(from);

  if (!peerConn && data.type === 'offer') {
    console.log(`${logPrefix} No peer for ${from}, creating responder peer`);
    createPeerFn(from, false);
    peerConn = getState().peers.get(from);
  }

  if (!peerConn) {
    if (data.type === 'ice-candidate') {
      console.log(`${logPrefix} ICE candidate from ${from} but no peer yet, creating responder`);
      createPeerFn(from, false);
      peerConn = getState().peers.get(from);
    }
    if (!peerConn) return;
  }

  const { pc } = peerConn;

  if (data.type === 'offer') {
    // ── Perfect negotiation: detect offer collision ──────────────────
    // Collision = we're currently making our own offer OR we already have
    // a local offer set (signaling state is not stable).
    const offerCollision = peerConn.makingOffer || pc.signalingState !== 'stable';

    // The "polite" peer yields on collision; "impolite" ignores the remote offer.
    // Use lexicographic userId comparison to assign stable roles.
    const isPolite = (localUserId ?? '') < from;

    if (offerCollision && !isPolite) {
      console.log(`${logPrefix} Ignoring colliding offer from ${from} (we are impolite)`);
      return;
    }

    // Polite peer (or no collision): accept the incoming offer.
    // If we had a pending local offer, rollback first.
    const acceptOffer = offerCollision
      ? pc.setLocalDescription({ type: 'rollback' })
          .then(() => pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp })))
      : pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));

    acceptOffer
      .then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => {
        const socket = getSocket();
        if (socket && pc.localDescription) {
          console.log(`${logPrefix} Sending answer to ${from}`);
          socket.emit(signalEvent as any, {
            to: from,
            signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      })
      .catch((err) => console.error(`${logPrefix} Error handling offer from ${from}:`, err));
  } else if (data.type === 'answer') {
    // Only accept an answer if we're actually waiting for one
    if (pc.signalingState !== 'have-local-offer') {
      console.log(`${logPrefix} Ignoring stale answer from ${from} (state: ${pc.signalingState})`);
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

export const useVoiceStore = create<VoiceState>((set, get) => ({
  localUserId: null,
  activeChannelId: null,
  selfMute: initialVoicePrefs.selfMute,
  selfDeaf: initialVoicePrefs.selfDeaf,
  localStream: null,
  latency: null,
  channelUsers: new Map(),
  peers: new Map(),
  remoteAudios: new Map(),

  // DM call state
  dmCallConversationId: null,
  dmCallUsers: [],
  incomingCall: null,

  setLocalUserId: (userId: string) => set({ localUserId: userId }),

  joinChannel: async (channelId: string) => {
    const socket = getSocket();
    if (!socket) return;

    // Leave DM call if active (cross-cleanup)
    if (get().dmCallConversationId) {
      get().leaveDMCall();
    }

    if (get().activeChannelId) {
      get().leaveChannel();
    }

    const settings = useSettingsStore.getState();
    setNoiseGateThreshold(settings.noiseGateThreshold);

    const stream = await acquireAudioStream();

    const { selfMute, selfDeaf } = get();
    const isPTT = settings.voiceMode === 'push_to_talk';

    if (stream) {
      if (isPTT) {
        // PTT mode: always start with tracks disabled; the PTT key enables them
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      } else {
        // VAD mode: apply persisted mute state
        if (selfMute) {
          stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        }
        // Only start speaking detection if not muted
        if (!selfMute) {
          startSpeakingDetection(stream);
        }
      }
    }

    // If no stream available, force mute
    const effectiveMute = stream ? selfMute : true;
    // In PTT mode, always tell the server we start muted (PTT key will unmute)
    const serverMute = isPTT ? true : effectiveMute;
    set({ activeChannelId: channelId, localStream: stream, selfMute: effectiveMute });

    // Send mute/deaf state to server on join
    socket.emit('voice:join', channelId, { selfMute: serverMute, selfDeaf });

    get().startLatencyMeasurement();
  },

  leaveChannel: () => {
    const socket = getSocket();
    const { localStream, activeChannelId, localUserId } = get();

    get().stopLatencyMeasurement();
    stopSpeakingDetection();

    // Immediately remove local user from channelUsers (don't wait for server event)
    if (activeChannelId && localUserId) {
      get().removeUserFromChannel(activeChannelId, localUserId);
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }

    get().destroyAllPeers();

    if (socket) {
      socket.emit('voice:leave');
    }

    set({
      activeChannelId: null,
      localStream: null,
      latency: null,
    });
  },

  toggleMute: () => {
    const socket = getSocket();
    const { selfMute, localStream } = get();
    const newMute = !selfMute;
    const isPTT = useSettingsStore.getState().voiceMode === 'push_to_talk';

    if (localStream) {
      if (isPTT) {
        // PTT mode: only handle muting (disable tracks + stop detection).
        // When unmuting, do NOT enable tracks — the PTT key press handles that.
        if (newMute) {
          localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
          stopSpeakingDetection();
        }
      } else {
        // VAD mode: existing behavior
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = !newMute;
        });

        if (newMute) {
          stopSpeakingDetection();
        } else {
          const settings = useSettingsStore.getState();
          setNoiseGateThreshold(settings.noiseGateThreshold);
          startSpeakingDetection(localStream, get().dmCallConversationId ? 'dm' : 'server');
        }
      }
    }

    if (socket) {
      if (get().activeChannelId) {
        socket.emit('voice:mute', newMute);
      } else if (get().dmCallConversationId) {
        socket.emit('dm:voice:mute', newMute);
      }
    }

    set({ selfMute: newMute });
    persistVoicePrefs({ selfMute: newMute, selfDeaf: get().selfDeaf });
  },

  toggleDeaf: () => {
    const socket = getSocket();
    const { selfDeaf, remoteAudios } = get();
    const newDeaf = !selfDeaf;

    remoteAudios.forEach((audio) => {
      audio.muted = newDeaf;
    });

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

    // Send initial ping immediately
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

  setChannelUsers: (channelId: string, users: VoiceUser[]) => {
    console.log('[Voice] setChannelUsers:', channelId, users.length, 'users');
    set((state) => {
      const newMap = new Map(state.channelUsers);
      newMap.set(channelId, users);
      return { channelUsers: newMap };
    });
  },

  addUserToChannel: (channelId: string, user: VoiceUser) => {
    console.log('[Voice] addUserToChannel:', channelId, user.displayName);

    // Dedup: check BEFORE the set call returns
    const existing = get().channelUsers.get(channelId) || [];
    if (existing.some((u) => u.id === user.id)) return;

    set((state) => {
      const newMap = new Map(state.channelUsers);
      const current = newMap.get(channelId) || [];
      if (current.some((u) => u.id === user.id)) return state;
      newMap.set(channelId, [...current, user]);
      return { channelUsers: newMap };
    });

    // If WE are in this voice channel, create a peer connection to the new user
    // Use setTimeout(0) to ensure the state has settled before reading
    setTimeout(() => {
      const { activeChannelId, localStream, localUserId, peers } = get();
      if (activeChannelId === channelId && localStream && user.id !== localUserId && !peers.has(user.id)) {
        console.log('[Voice] Creating initiator peer to', user.id);
        get().createPeer(user.id, true);
      }
    }, 0);
  },

  removeUserFromChannel: (channelId: string, userId: string) => {
    console.log('[Voice] removeUserFromChannel:', channelId, userId);

    // Cancel any pending ICE restart for this peer
    const restartTimer = iceRestartTimers.get(userId);
    if (restartTimer) {
      clearTimeout(restartTimer);
      iceRestartTimers.delete(userId);
    }

    const { activeChannelId } = get();
    if (activeChannelId === channelId) {
      get().destroyPeer(userId);
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
      return { channelUsers: newMap };
    });
  },

  updateUserState: (channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean) => {
    set((state) => {
      const newMap = new Map(state.channelUsers);
      const existing = newMap.get(channelId) || [];
      newMap.set(channelId, existing.map((u) =>
        u.id === userId ? { ...u, selfMute, selfDeaf } : u
      ));
      return { channelUsers: newMap };
    });
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

  handleSignal: (from: string, signal: unknown) => {
    handleSignalInternal('voice:signal', '[Voice]', get().createPeer, from, signal, { get });
  },

  createPeer: (targetUserId: string, initiator: boolean) => {
    createPeerInternal('voice:signal', '[Voice]', targetUserId, initiator, { get, set });
  },

  destroyPeer: (userId: string) => {
    const { peers, remoteAudios } = get();

    // Cancel any pending ICE restart
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

    const audio = remoteAudios.get(userId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      const newAudios = new Map(remoteAudios);
      newAudios.delete(userId);
      set({ remoteAudios: newAudios });
    }
  },

  destroyAllPeers: () => {
    const { peers, remoteAudios } = get();

    // Cancel all pending ICE restart timers
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
    set({ peers: new Map(), remoteAudios: new Map() });
  },

  // ─── DM Call Methods ──────────────────────────────────────────────

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

    const stream = await acquireAudioStream();

    const { selfMute, selfDeaf } = get();
    const isPTT = settings.voiceMode === 'push_to_talk';

    if (stream) {
      if (isPTT) {
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      } else {
        if (selfMute) {
          stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        }
        if (!selfMute) {
          startSpeakingDetection(stream, 'dm');
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
    stopSpeakingDetection();

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

    // Create peer connection to new user if we're in this DM call
    setTimeout(() => {
      const state = get();
      if (state.dmCallConversationId && state.localStream && user.id !== state.localUserId && !state.peers.has(user.id)) {
        console.log('[DMVoice] Creating initiator peer to', user.id);
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

// Subscribe to output device changes and update all existing remote audio elements
useSettingsStore.subscribe((state, prevState) => {
  if (state.audioOutputDeviceId !== prevState.audioOutputDeviceId) {
    const { remoteAudios } = useVoiceStore.getState();
    remoteAudios.forEach((audio) => {
      applyOutputDevice(audio, state.audioOutputDeviceId);
    });
  }
});

// Handle live voice mode switching while in a voice channel or DM call
useSettingsStore.subscribe((state, prevState) => {
  if (state.voiceMode === prevState.voiceMode) return;

  const { activeChannelId, dmCallConversationId, localStream, selfMute } = useVoiceStore.getState();
  if ((!activeChannelId && !dmCallConversationId) || !localStream) return;

  const socket = getSocket();
  const muteEvent = activeChannelId ? 'voice:mute' : 'dm:voice:mute';

  if (state.voiceMode === 'push_to_talk') {
    localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
    stopSpeakingDetection();
    if (socket) socket.emit(muteEvent as any, true);
  } else {
    if (!selfMute) {
      localStream.getAudioTracks().forEach((track) => { track.enabled = true; });
      setNoiseGateThreshold(state.noiseGateThreshold);
      startSpeakingDetection(localStream, dmCallConversationId ? 'dm' : 'server');
      if (socket) socket.emit(muteEvent as any, false);
    }
  }
});

// On socket reconnect while in a voice channel: re-join and re-establish peers
onSocketReconnect(() => {
  const { activeChannelId, dmCallConversationId, localStream } = useVoiceStore.getState();

  const socket = getSocket();
  if (!socket) return;

  // Destroy stale peers (they used the old socket)
  useVoiceStore.getState().destroyAllPeers();

  const { selfMute, selfDeaf } = useVoiceStore.getState();
  const settings = useSettingsStore.getState();
  const isPTT = settings.voiceMode === 'push_to_talk';

  if (activeChannelId) {
    console.log('[Voice] Socket reconnected — re-joining voice channel', activeChannelId);
    socket.emit('voice:join', activeChannelId, { selfMute: isPTT ? true : selfMute, selfDeaf });
  } else if (dmCallConversationId) {
    console.log('[DMVoice] Socket reconnected — re-joining DM call', dmCallConversationId);
    socket.emit('dm:voice:join', dmCallConversationId, { selfMute: isPTT ? true : selfMute, selfDeaf });
  } else {
    return;
  }

  // Re-start latency measurement with new socket
  useVoiceStore.getState().startLatencyMeasurement();

  // Re-start speaking detection if unmuted and in VAD mode
  if (localStream && !useVoiceStore.getState().selfMute && settings.voiceMode !== 'push_to_talk') {
    setNoiseGateThreshold(settings.noiseGateThreshold);
    startSpeakingDetection(localStream, dmCallConversationId ? 'dm' : 'server');
  }
});
