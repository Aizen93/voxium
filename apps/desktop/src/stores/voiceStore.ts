import { create } from 'zustand';
import { getSocket } from '../services/socket';
import type { VoiceUser } from '@voxium/shared';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

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
}

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

export const useVoiceStore = create<VoiceState>((set, get) => ({
  localUserId: null,
  activeChannelId: null,
  selfMute: false,
  selfDeaf: false,
  localStream: null,
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

    let stream: MediaStream | null = null;
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        console.log('[Voice] Joined channel, local stream tracks:', stream.getTracks().length);
      } else {
        console.warn('[Voice] getUserMedia not available (insecure context?), joining in listen-only mode');
      }
    } catch (err) {
      console.warn('[Voice] Microphone access denied, joining in listen-only mode:', err);
    }

    set({ activeChannelId: channelId, localStream: stream, selfMute: !stream });
    socket.emit('voice:join', channelId);
  },

  leaveChannel: () => {
    const socket = getSocket();
    const { localStream, activeChannelId, localUserId } = get();

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
    set((state) => {
      const newMap = new Map(state.channelUsers);
      const existing = newMap.get(channelId) || [];
      if (existing.some((u) => u.id === user.id)) return state;
      newMap.set(channelId, [...existing, user]);
      return { channelUsers: newMap };
    });

    // If WE are in this voice channel, create a peer connection to the new user
    const { activeChannelId, localStream, localUserId } = get();
    if (activeChannelId === channelId && localStream && user.id !== localUserId) {
      console.log('[Voice] Creating initiator peer to', user.id);
      get().createPeer(user.id, true);
    }
  },

  removeUserFromChannel: (channelId: string, userId: string) => {
    console.log('[Voice] removeUserFromChannel:', channelId, userId);

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

    const { peers, localStream } = get();
    let peerConn = peers.get(from);

    // If we get an offer and have no peer, create a non-initiator peer
    if (!peerConn && data.type === 'offer') {
      console.log(`[Voice] No peer for ${from}, creating responder peer`);
      get().createPeer(from, false);
      peerConn = get().peers.get(from);
    }

    if (!peerConn) {
      // Could be an ICE candidate arriving before the offer — queue or ignore
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
        .catch((err) => console.error(`[Voice] Error adding ICE candidate from ${from}:`, err));
    }
  },

  createPeer: (targetUserId: string, initiator: boolean) => {
    const { localStream, peers, selfDeaf } = get();

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
        console.log(`[Voice] ICE candidate for ${targetUserId}`);
        socket.emit('voice:signal', {
          to: targetUserId,
          signal: { type: 'ice-candidate', candidate: event.candidate.toJSON() },
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Voice] ICE state with ${targetUserId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.warn(`[Voice] ICE connection ${pc.iceConnectionState} with ${targetUserId}`);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Voice] Connection state with ${targetUserId}: ${pc.connectionState}`);
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

    const peerConn = peers.get(userId);
    if (peerConn) {
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
    peers.forEach((peerConn) => peerConn.pc.close());
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
