import { create } from 'zustand';
import { getSocket, onSocketReconnect } from '../services/socket';
import { startSpeakingDetection, stopSpeakingDetection, setNoiseGateThreshold } from '../services/audioAnalyser';
import { useSettingsStore } from './settingsStore';
import type { VoiceUser } from '@voxium/shared';

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
  localUserId: string | null;
  activeChannelId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  localStream: MediaStream | null;
  latency: number | null;

  channelUsers: Map<string, VoiceUser[]>;

  peers: Map<string, PeerConnection>;
  remoteAudios: Map<string, HTMLAudioElement>;

  setLocalUserId: (userId: string) => void;
  joinChannel: (channelId: string) => Promise<void>;
  leaveChannel: () => void;
  toggleMute: () => void;
  toggleDeaf: () => void;

  setChannelUsers: (channelId: string, users: VoiceUser[]) => void;
  addUserToChannel: (channelId: string, user: VoiceUser) => void;
  removeUserFromChannel: (channelId: string, userId: string) => void;

  updateUserState: (channelId: string, userId: string, selfMute: boolean, selfDeaf: boolean) => void;
  setUserSpeaking: (channelId: string, userId: string, speaking: boolean) => void;
  handleSignal: (from: string, signal: unknown) => void;
  createPeer: (targetUserId: string, initiator: boolean) => void;
  destroyPeer: (userId: string) => void;
  destroyAllPeers: () => void;

  startLatencyMeasurement: () => void;
  stopLatencyMeasurement: () => void;
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

export const useVoiceStore = create<VoiceState>((set, get) => ({
  localUserId: null,
  activeChannelId: null,
  selfMute: false,
  selfDeaf: false,
  localStream: null,
  latency: null,
  channelUsers: new Map(),
  peers: new Map(),
  remoteAudios: new Map(),

  setLocalUserId: (userId: string) => set({ localUserId: userId }),

  joinChannel: async (channelId: string) => {
    const socket = getSocket();
    if (!socket) return;

    if (get().activeChannelId) {
      get().leaveChannel();
    }

    const settings = useSettingsStore.getState();
    setNoiseGateThreshold(settings.noiseGateThreshold);

    let stream: MediaStream | null = null;
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (settings.audioInputDeviceId) {
          audioConstraints.deviceId = { exact: settings.audioInputDeviceId };
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        console.log('[Voice] Joined channel, local stream tracks:', stream.getTracks().length);
      } else {
        console.warn('[Voice] getUserMedia not available (insecure context?), joining in listen-only mode');
      }
    } catch (err) {
      console.warn('[Voice] Microphone access denied, joining in listen-only mode:', err);
    }

    if (stream) {
      startSpeakingDetection(stream);
    }

    set({ activeChannelId: channelId, localStream: stream, selfMute: !stream });
    socket.emit('voice:join', channelId);

    get().startLatencyMeasurement();
  },

  leaveChannel: () => {
    const socket = getSocket();
    const { localStream, activeChannelId, localUserId } = get();

    get().stopLatencyMeasurement();
    stopSpeakingDetection();

    // Clear all ICE restart timers
    iceRestartTimers.forEach((timer) => clearTimeout(timer));
    iceRestartTimers.clear();

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
      selfMute: false,
      selfDeaf: false,
      latency: null,
    });
  },

  toggleMute: () => {
    const socket = getSocket();
    const { selfMute, localStream } = get();
    const newMute = !selfMute;

    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = !newMute;
      });

      if (newMute) {
        stopSpeakingDetection();
      } else {
        const settings = useSettingsStore.getState();
        setNoiseGateThreshold(settings.noiseGateThreshold);
        startSpeakingDetection(localStream);
      }
    }

    if (socket) {
      socket.emit('voice:mute', newMute);
    }

    set({ selfMute: newMute });
  },

  toggleDeaf: () => {
    const socket = getSocket();
    const { selfDeaf, remoteAudios } = get();
    const newDeaf = !selfDeaf;

    remoteAudios.forEach((audio) => {
      audio.muted = newDeaf;
    });

    if (socket) {
      socket.emit('voice:deaf', newDeaf);
    }

    set({ selfDeaf: newDeaf });
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
    const data = signal as { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
    console.log(`[Voice] handleSignal from ${from}:`, data.type || 'ice-candidate');

    const { peers } = get();
    let peerConn = peers.get(from);

    // If we get an offer and have no peer, create a non-initiator peer
    if (!peerConn && data.type === 'offer') {
      console.log(`[Voice] No peer for ${from}, creating responder peer`);
      get().createPeer(from, false);
      peerConn = get().peers.get(from);
    }

    if (!peerConn) {
      if (data.type === 'ice-candidate') {
        console.log(`[Voice] ICE candidate from ${from} but no peer yet, creating responder`);
        get().createPeer(from, false);
        peerConn = get().peers.get(from);
      }
      if (!peerConn) return;
    }

    const { pc } = peerConn;

    if (data.type === 'offer') {
      pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }))
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => {
          const socket = getSocket();
          if (socket && pc.localDescription) {
            console.log(`[Voice] Sending answer to ${from}`);
            socket.emit('voice:signal', {
              to: from,
              signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          }
        })
        .catch((err) => console.error(`[Voice] Error handling offer from ${from}:`, err));
    } else if (data.type === 'answer') {
      pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }))
        .catch((err) => console.error(`[Voice] Error handling answer from ${from}:`, err));
    } else if (data.type === 'ice-candidate' && data.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate))
        .catch((err) => {
          // Ignore "no remote description" errors — candidate will be applied later
          if (!String(err).includes('remote description')) {
            console.error(`[Voice] Error adding ICE candidate from ${from}:`, err);
          }
        });
    }
  },

  createPeer: (targetUserId: string, initiator: boolean) => {
    const { localStream, peers, selfDeaf } = get();
    const outputDeviceId = useSettingsStore.getState().audioOutputDeviceId;

    if (peers.has(targetUserId)) {
      console.log('[Voice] createPeer: destroying existing peer for', targetUserId);
      get().destroyPeer(targetUserId);
    }

    const socket = getSocket();
    if (!socket) {
      console.log('[Voice] createPeer: no socket');
      return;
    }

    console.log(`[Voice] Creating RTCPeerConnection to ${targetUserId} (initiator: ${initiator})`);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peerConn: PeerConnection = { pc, makingOffer: false };

    // Add local audio tracks to the connection (if available)
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
      console.log(`[Voice] Added ${localStream.getTracks().length} local tracks`);
    } else {
      console.log('[Voice] No local stream (listen-only mode)');
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('voice:signal', {
          to: targetUserId,
          signal: { type: 'ice-candidate', candidate: event.candidate.toJSON() },
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Voice] ICE state with ${targetUserId}: ${pc.iceConnectionState}`);

      if (pc.iceConnectionState === 'failed') {
        // Attempt ICE restart instead of giving up
        console.warn(`[Voice] ICE failed with ${targetUserId}, attempting ICE restart`);

        // Clear any existing restart timer
        const existingTimer = iceRestartTimers.get(targetUserId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          iceRestartTimers.delete(targetUserId);
          const currentPeer = get().peers.get(targetUserId);
          if (!currentPeer || currentPeer.pc !== pc) return; // peer was replaced

          pc.createOffer({ iceRestart: true })
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => {
              const s = getSocket();
              if (s && pc.localDescription) {
                s.emit('voice:signal', {
                  to: targetUserId,
                  signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
                });
              }
            })
            .catch((err) => console.error(`[Voice] ICE restart failed for ${targetUserId}:`, err));
        }, ICE_RESTART_DELAY_MS);
        iceRestartTimers.set(targetUserId, timer);
      }

      if (pc.iceConnectionState === 'disconnected') {
        console.warn(`[Voice] ICE disconnected with ${targetUserId} — waiting for recovery`);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Voice] Connection state with ${targetUserId}: ${pc.connectionState}`);

      // If connection completely failed after ICE restart, clean up
      if (pc.connectionState === 'failed') {
        console.error(`[Voice] Connection failed permanently with ${targetUserId}`);
        get().destroyPeer(targetUserId);
      }
    };

    // Handle remote audio stream
    pc.ontrack = (event) => {
      console.log(`[Voice] Got remote track from ${targetUserId}:`, event.track.kind);
      const remoteStream = event.streams[0];
      if (!remoteStream) return;

      const container = getAudioContainer();
      const { remoteAudios } = get();
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
      set({ remoteAudios: newAudios });

      audio.play()
        .then(() => console.log(`[Voice] Audio playing for ${targetUserId}`))
        .catch((err) => console.warn(`[Voice] Audio autoplay blocked for ${targetUserId}:`, err));
    };

    // Store the peer BEFORE creating the offer (so handleSignal can find it)
    const newPeers = new Map(peers);
    newPeers.set(targetUserId, peerConn);
    set({ peers: newPeers });

    // If initiator, create and send the offer
    if (initiator) {
      peerConn.makingOffer = true;
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          if (pc.localDescription) {
            console.log(`[Voice] Sending offer to ${targetUserId}`);
            socket.emit('voice:signal', {
              to: targetUserId,
              signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          }
        })
        .catch((err) => console.error(`[Voice] Error creating offer for ${targetUserId}:`, err))
        .finally(() => {
          peerConn.makingOffer = false;
        });
    }
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

// On socket reconnect while in a voice channel: re-join and re-establish peers
onSocketReconnect(() => {
  const { activeChannelId, localStream } = useVoiceStore.getState();
  if (!activeChannelId) return;

  console.log('[Voice] Socket reconnected — re-joining voice channel', activeChannelId);
  const socket = getSocket();
  if (!socket) return;

  // Destroy stale peers (they used the old socket)
  useVoiceStore.getState().destroyAllPeers();

  // Re-join voice on the server — it will re-broadcast our presence
  // and send us the updated user list, which triggers peer creation
  socket.emit('voice:join', activeChannelId);

  // Re-start latency measurement with new socket
  useVoiceStore.getState().startLatencyMeasurement();

  // Re-start speaking detection if unmuted
  if (localStream && !useVoiceStore.getState().selfMute) {
    const settings = useSettingsStore.getState();
    setNoiseGateThreshold(settings.noiseGateThreshold);
    startSpeakingDetection(localStream);
  }
});
