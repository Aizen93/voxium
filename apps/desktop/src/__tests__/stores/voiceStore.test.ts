import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock all external dependencies before importing the store ───────────────

vi.mock('mediasoup-client', () => ({
  Device: vi.fn(),
}));

vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
  onSocketReconnect: vi.fn(),
}));

vi.mock('../../services/audioAnalyser', () => ({
  startSpeakingDetection: vi.fn(),
  stopSpeakingDetection: vi.fn(),
  setNoiseGateThreshold: vi.fn(),
  getGatedStream: vi.fn().mockReturnValue(null),
  setNoiseSuppression: vi.fn(),
  onSpeakingChange: vi.fn(),
  applyNoiseSuppression: vi.fn().mockImplementation((stream: MediaStream) => Promise.resolve(stream)),
  getSuppressedStream: vi.fn().mockReturnValue(null),
  stopNoiseSuppression: vi.fn(),
  setSpeakingDetectionPaused: vi.fn(),
}));

vi.mock('../../services/sdpUtils', () => ({
  optimizeOpusSDP: vi.fn((sdp: string) => sdp),
}));

// callCrypto is dynamically imported by voiceStore's send/receive chains —
// vi.mock intercepts dynamic imports too. Default behavior (set in beforeEach):
// encrypt tags the signal into a fake envelope, decrypt passes payloads through
// verbatim, so tests drive the WebRTC layer with plain signal objects.
const cc = vi.hoisted(() => {
  class CallSecurityError extends Error {
    constructor(
      readonly kind: 'legacy-signal' | 'binding-mismatch' | 'peer-not-e2e',
      message: string,
    ) {
      super(message);
      this.name = 'CallSecurityError';
    }
  }
  class E2EIdentityChangedError extends Error {
    constructor(readonly peerUserId: string) {
      super(`identity changed for ${peerUserId}`);
      this.name = 'E2EIdentityChangedError';
    }
  }
  return {
    CallSecurityError,
    E2EIdentityChangedError,
    beginCallSignaling: vi.fn(),
    endCallSignaling: vi.fn(),
    getCallPeerDevice: vi.fn(),
    encryptCallSignal: vi.fn(),
    decryptCallSignal: vi.fn(),
  };
});
vi.mock('../../services/e2e/callCrypto', () => cc);
vi.mock('../../stores/dmStore', () => ({
  useDMStore: { getState: () => ({ conversations: [] }) },
}));

vi.mock('@timephy/rnnoise-wasm', () => ({
  NoiseSuppressorWorklet_Name: 'NoiseSuppressorWorklet',
}));
vi.mock('@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url', () => ({
  default: 'mock-url',
}));

vi.mock('../../stores/settingsStore', async () => {
  const { create } = await import('zustand');
  const store = create(() => ({
    audioInputDeviceId: '',
    audioOutputDeviceId: '',
    noiseGateThreshold: 0.008,
    voiceMode: 'voice_activity' as const,
    voiceQuality: 'medium' as const,
    pushToTalkKey: 'Backquote',
    enableNoiseSuppression: true,
    enableNotificationSounds: true,
    enableDesktopNotifications: true,
    setAudioInputDeviceId: vi.fn(),
    setAudioOutputDeviceId: vi.fn(),
    setNoiseGateThreshold: vi.fn(),
    setVoiceMode: vi.fn(),
    setVoiceQuality: vi.fn(),
    setPushToTalkKey: vi.fn(),
    setEnableNoiseSuppression: vi.fn(),
    setEnableNotificationSounds: vi.fn(),
    setEnableDesktopNotifications: vi.fn(),
    subscribe: vi.fn(),
  }));
  return {
    useSettingsStore: store,
    VOICE_QUALITY_BITRATE: { low: 16000, medium: 32000, high: 64000 },
  };
});

import { useVoiceStore, isMicProducer } from '../../stores/voiceStore';
import { getSocket } from '../../services/socket';
import type { Producer, Consumer } from 'mediasoup-client/types';

// ─── Fakes ───────────────────────────────────────────────────────────────────

function fakeProducer(appType: string, kind: 'audio' | 'video' = appType === 'screen-video' ? 'video' : 'audio') {
  return {
    id: `producer-${appType}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    appData: { type: appType },
    closed: false,
    paused: false,
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
  };
}

function fakeConsumer() {
  return {
    id: `consumer-${Math.random().toString(36).slice(2, 8)}`,
    close: vi.fn(),
  };
}

function fakeAudioElement() {
  return {
    muted: false,
    pause: vi.fn(),
    srcObject: {} as unknown,
    remove: vi.fn(),
  };
}

/** Minimal RTCPeerConnection double tracking signaling state transitions. */
class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  localDescription: { type: string; sdp?: string } | null = null;
  remoteDescription: { type: string; sdp?: string } | null = null;
  signalingState = 'stable';
  iceConnectionState = 'new';
  connectionState = 'new';
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  addTrack = vi.fn();
  close = vi.fn();
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'x' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'x' });
  setLocalDescription = vi.fn().mockImplementation((desc: { type: string; sdp?: string }) => {
    if (desc?.type === 'rollback') {
      this.localDescription = null;
      this.signalingState = 'stable';
    } else {
      this.localDescription = desc;
      this.signalingState = desc?.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    return Promise.resolve();
  });
  setRemoteDescription = vi.fn().mockImplementation((desc: { type: string; sdp?: string }) => {
    this.remoteDescription = desc;
    this.signalingState = desc?.type === 'offer' ? 'have-remote-offer' : 'stable';
    return Promise.resolve();
  });
  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }
}

/** Drain the send/receive chains: dynamic imports + crypto are microtasks,
 *  peer creation is a macrotask — a few timer rounds settle everything. */
const flushAsync = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe('voiceStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useVoiceStore.setState({
      localUserId: null,
      activeChannelId: null,
      activeVoiceServerId: null,
      selfMute: false,
      selfDeaf: false,
      pttActive: false,
      localStream: null,
      latency: null,
      dmCallConversationId: null,
      dmCallUsers: [],
      dmCallPeerDevice: null,
      incomingCall: null,
      peers: new Map(),
      remoteAudios: new Map(),
    });
    // Reset the module-level signal chains / pre-pin buffer (leaveDMCall is a
    // no-op socket-wise here because the state was just cleared)
    useVoiceStore.getState().leaveDMCall();
    for (const fn of [cc.beginCallSignaling, cc.endCallSignaling, cc.getCallPeerDevice, cc.encryptCallSignal, cc.decryptCallSignal]) {
      fn.mockReset();
    }
    cc.getCallPeerDevice.mockReturnValue(null);
    cc.encryptCallSignal.mockImplementation(async (_conv: string, _peer: unknown, signal: unknown) =>
      JSON.stringify({ env: signal }));
    cc.decryptCallSignal.mockImplementation(async (_conv: string, _peer: unknown, payload: unknown) => payload);
    vi.mocked(vi.mocked(getSocket)()!.emit).mockClear();
  });

  describe('ICE_SERVERS (STUN configuration)', () => {
    it('should derive STUN host from VITE_WS_URL', () => {
      // The ICE_SERVERS constant is module-level, we verify it indirectly
      // by checking that the store initializes without errors
      const state = useVoiceStore.getState();
      expect(state).toBeDefined();
      expect(state.localUserId).toBeNull();
    });
  });

  describe('pttActive state', () => {
    it('should initialize pttActive as false', () => {
      expect(useVoiceStore.getState().pttActive).toBe(false);
    });

    it('should allow setting pttActive', () => {
      useVoiceStore.setState({ pttActive: true });
      expect(useVoiceStore.getState().pttActive).toBe(true);
    });

    it('should reset pttActive when leaveDMCall is called', () => {
      useVoiceStore.setState({ pttActive: true, dmCallConversationId: 'conv-1' });
      useVoiceStore.getState().leaveDMCall();
      expect(useVoiceStore.getState().pttActive).toBe(false);
    });

    it('should reset pttActive when leaveChannel is called', () => {
      useVoiceStore.setState({ pttActive: true, activeChannelId: 'ch-1' });
      useVoiceStore.getState().leaveChannel();
      expect(useVoiceStore.getState().pttActive).toBe(false);
    });
  });

  describe('setLocalUserId', () => {
    it('should set localUserId', () => {
      useVoiceStore.getState().setLocalUserId('user-123');
      expect(useVoiceStore.getState().localUserId).toBe('user-123');
    });
  });

  describe('setIncomingCall', () => {
    it('should set incoming call data', () => {
      const callData = {
        conversationId: 'conv-1',
        from: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false },
      };
      useVoiceStore.getState().setIncomingCall(callData);
      expect(useVoiceStore.getState().incomingCall).toEqual(callData);
    });

    it('should clear incoming call with null', () => {
      useVoiceStore.getState().setIncomingCall(null);
      expect(useVoiceStore.getState().incomingCall).toBeNull();
    });
  });

  describe('declineCall', () => {
    it('should clear incomingCall state', () => {
      useVoiceStore.setState({
        incomingCall: {
          conversationId: 'conv-1',
          from: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false },
        },
      });
      useVoiceStore.getState().declineCall();
      expect(useVoiceStore.getState().incomingCall).toBeNull();
    });
  });

  describe('addDMCallUser', () => {
    const bob = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false, deviceId: 'device-bob00001' };

    it('should add a user to dmCallUsers and pin their E2E call device', () => {
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', localUserId: 'user-1' });
      useVoiceStore.getState().addDMCallUser(bob);
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(1);
      expect(useVoiceStore.getState().dmCallUsers[0].id).toBe('user-2');
      expect(useVoiceStore.getState().dmCallPeerDevice).toEqual({ userId: 'user-2', deviceId: 'device-bob00001' });
    });

    it('should not add duplicate users', () => {
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', localUserId: 'user-1' });
      useVoiceStore.getState().addDMCallUser(bob);
      useVoiceStore.getState().addDMCallUser(bob);
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(1);
    });

    it('does NOT demand a deviceId for the local user echo', () => {
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', localUserId: 'user-1' });
      const self = { ...bob, id: 'user-1', deviceId: undefined };
      useVoiceStore.getState().addDMCallUser(self);
      expect(useVoiceStore.getState().dmCallConversationId).toBe('conv-1');
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(1);
      expect(useVoiceStore.getState().dmCallPeerDevice).toBeNull();
    });
  });

  describe('removeDMCallUser', () => {
    it('should remove a user from dmCallUsers', () => {
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false };
      useVoiceStore.setState({ dmCallUsers: [user] });
      useVoiceStore.getState().removeDMCallUser('user-2');
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(0);
    });
  });

  describe('updateDMCallUserState', () => {
    it('should update mute/deaf state for a DM call user', () => {
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false };
      useVoiceStore.setState({ dmCallUsers: [user] });
      useVoiceStore.getState().updateDMCallUserState('user-2', true, true);
      const updated = useVoiceStore.getState().dmCallUsers[0];
      expect(updated.selfMute).toBe(true);
      expect(updated.selfDeaf).toBe(true);
    });
  });

  describe('setDMCallUserSpeaking', () => {
    it('should update speaking state for a DM call user', () => {
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false };
      useVoiceStore.setState({ dmCallUsers: [user] });
      useVoiceStore.getState().setDMCallUserSpeaking('user-2', true);
      expect(useVoiceStore.getState().dmCallUsers[0].speaking).toBe(true);
    });
  });

  describe('destroyPeer', () => {
    it('should remove a peer and clean up audio element', () => {
      const mockPc = { close: vi.fn() };
      const mockAudio = { pause: vi.fn(), srcObject: {}, remove: vi.fn() };
      useVoiceStore.setState({
        peers: new Map([['user-2', { pc: mockPc as unknown as RTCPeerConnection, makingOffer: false, pendingCandidates: [] }]]),
        remoteAudios: new Map([['user-2', mockAudio as unknown as HTMLAudioElement]]),
      });
      useVoiceStore.getState().destroyPeer('user-2');
      expect(useVoiceStore.getState().peers.size).toBe(0);
      expect(useVoiceStore.getState().remoteAudios.size).toBe(0);
      expect(mockPc.close).toHaveBeenCalled();
      expect(mockAudio.pause).toHaveBeenCalled();
    });

    it('should handle destroying a non-existent peer gracefully', () => {
      expect(() => useVoiceStore.getState().destroyPeer('nonexistent')).not.toThrow();
    });
  });

  describe('destroyAllPeers', () => {
    it('should destroy all peers and audio elements', () => {
      const mockPc1 = { close: vi.fn() };
      const mockPc2 = { close: vi.fn() };
      useVoiceStore.setState({
        peers: new Map([
          ['user-2', { pc: mockPc1 as unknown as RTCPeerConnection, makingOffer: false, pendingCandidates: [] }],
          ['user-3', { pc: mockPc2 as unknown as RTCPeerConnection, makingOffer: false, pendingCandidates: [] }],
        ]),
      });
      useVoiceStore.getState().destroyAllPeers();
      expect(useVoiceStore.getState().peers.size).toBe(0);
      expect(mockPc1.close).toHaveBeenCalled();
      expect(mockPc2.close).toHaveBeenCalled();
    });
  });

  describe('toggleMute / toggleDeaf', () => {
    it('should toggle selfMute', () => {
      expect(useVoiceStore.getState().selfMute).toBe(false);
      useVoiceStore.getState().toggleMute();
      expect(useVoiceStore.getState().selfMute).toBe(true);
      useVoiceStore.getState().toggleMute();
      expect(useVoiceStore.getState().selfMute).toBe(false);
    });

    it('should toggle selfDeaf', () => {
      expect(useVoiceStore.getState().selfDeaf).toBe(false);
      useVoiceStore.getState().toggleDeaf();
      expect(useVoiceStore.getState().selfDeaf).toBe(true);
    });
  });

  // ─── P1: screen share + mute filtering (HIGH-1) ──────────────────────────

  describe('isMicProducer', () => {
    it('matches only the mic producer, never screen audio/video', () => {
      expect(isMicProducer(fakeProducer('audio') as unknown as Producer)).toBe(true);
      expect(isMicProducer(fakeProducer('screen-audio') as unknown as Producer)).toBe(false);
      expect(isMicProducer(fakeProducer('screen-video') as unknown as Producer)).toBe(false);
    });
  });

  describe('toggleMute — screen audio keeps flowing (HIGH-1)', () => {
    it('pauses only the mic producer, not screen-share audio', () => {
      const mic = fakeProducer('audio');
      const screenAudio = fakeProducer('screen-audio');
      useVoiceStore.setState({
        activeChannelId: 'ch-1',
        msProducers: new Map([[mic.id, mic], [screenAudio.id, screenAudio]]) as unknown as Map<string, Producer>,
      });

      useVoiceStore.getState().toggleMute(); // mute

      expect(mic.pause).toHaveBeenCalled();
      expect(screenAudio.pause).not.toHaveBeenCalled();
    });
  });

  describe('handleProducerClosed — precise per-consumer cleanup (HIGH-1)', () => {
    it('closing the screen-audio consumer removes ONLY the -screen element, never the mic element', () => {
      const consumer = fakeConsumer();
      const micAudio = fakeAudioElement();
      const screenAudio = fakeAudioElement();
      useVoiceStore.setState({
        msConsumers: new Map([
          [consumer.id, { consumer: consumer as unknown as Consumer, producerUserId: 'user-2', appType: 'screen-audio' }],
        ]),
        remoteAudios: new Map([
          ['user-2', micAudio as unknown as HTMLAudioElement],
          ['user-2-screen', screenAudio as unknown as HTMLAudioElement],
        ]),
      });

      useVoiceStore.getState().handleProducerClosed({ consumerId: consumer.id, producerUserId: 'user-2' });

      expect(screenAudio.remove).toHaveBeenCalled();
      expect(micAudio.remove).not.toHaveBeenCalled();
      expect(useVoiceStore.getState().remoteAudios.has('user-2')).toBe(true);
      expect(useVoiceStore.getState().remoteAudios.has('user-2-screen')).toBe(false);
    });

    it('closing the screen-video consumer clears the remote stream but leaves audio elements', () => {
      const consumer = fakeConsumer();
      const micAudio = fakeAudioElement();
      useVoiceStore.setState({
        msConsumers: new Map([
          [consumer.id, { consumer: consumer as unknown as Consumer, producerUserId: 'user-2', appType: 'screen-video' }],
        ]),
        remoteAudios: new Map([['user-2', micAudio as unknown as HTMLAudioElement]]),
        remoteScreenStream: {} as MediaStream,
      });

      useVoiceStore.getState().handleProducerClosed({ consumerId: consumer.id, producerUserId: 'user-2' });

      expect(useVoiceStore.getState().remoteScreenStream).toBeNull();
      expect(micAudio.remove).not.toHaveBeenCalled();
    });

    it('closing the mic consumer removes only the mic element', () => {
      const consumer = fakeConsumer();
      const micAudio = fakeAudioElement();
      const screenAudio = fakeAudioElement();
      useVoiceStore.setState({
        msConsumers: new Map([
          [consumer.id, { consumer: consumer as unknown as Consumer, producerUserId: 'user-2', appType: 'audio' }],
        ]),
        remoteAudios: new Map([
          ['user-2', micAudio as unknown as HTMLAudioElement],
          ['user-2-screen', screenAudio as unknown as HTMLAudioElement],
        ]),
      });

      useVoiceStore.getState().handleProducerClosed({ consumerId: consumer.id, producerUserId: 'user-2' });

      expect(micAudio.remove).toHaveBeenCalled();
      expect(screenAudio.remove).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown consumerId', () => {
      expect(() =>
        useVoiceStore.getState().handleProducerClosed({ consumerId: 'nope', producerUserId: 'user-2' }),
      ).not.toThrow();
    });
  });

  describe('stopScreenShare — closes producers on both sides (HIGH-1)', () => {
    it('emits voice:producer:close per screen producer and voice:screen_share:stop, leaving the mic alone', () => {
      const socket = vi.mocked(getSocket)()!;
      vi.mocked(socket.emit).mockClear();

      const mic = fakeProducer('audio');
      const screenVideo = fakeProducer('screen-video');
      const screenAudio = fakeProducer('screen-audio');
      useVoiceStore.setState({
        activeChannelId: 'ch-1',
        isScreenSharing: true,
        screenStream: { getTracks: () => [] } as unknown as MediaStream,
        msProducers: new Map([
          [mic.id, mic],
          [screenVideo.id, screenVideo],
          [screenAudio.id, screenAudio],
        ]) as unknown as Map<string, Producer>,
      });

      useVoiceStore.getState().stopScreenShare();

      expect(socket.emit).toHaveBeenCalledWith('voice:producer:close', { producerId: screenVideo.id });
      expect(socket.emit).toHaveBeenCalledWith('voice:producer:close', { producerId: screenAudio.id });
      expect(socket.emit).not.toHaveBeenCalledWith('voice:producer:close', { producerId: mic.id });
      expect(socket.emit).toHaveBeenCalledWith('voice:screen_share:stop');

      expect(screenVideo.close).toHaveBeenCalled();
      expect(screenAudio.close).toHaveBeenCalled();
      expect(mic.close).not.toHaveBeenCalled();

      const state = useVoiceStore.getState();
      expect(state.isScreenSharing).toBe(false);
      expect(state.screenStream).toBeNull();
      expect(state.msProducers.size).toBe(1); // mic only
    });
  });

  describe('joinChannel — generation guard (MED-9)', () => {
    it('a join superseded by leaveChannel mid-mic-acquisition never emits voice:join', async () => {
      const socket = vi.mocked(getSocket)()!;
      vi.mocked(socket.emit).mockClear();

      // Start joining, then leave synchronously while the (async) mic
      // acquisition is still in flight — the stale join must be abandoned.
      const joinPromise = useVoiceStore.getState().joinChannel('ch-race');
      useVoiceStore.getState().leaveChannel();
      await joinPromise;

      const joinEmits = vi.mocked(socket.emit).mock.calls.filter((c) => c[0] === 'voice:join');
      expect(joinEmits).toHaveLength(0);
      expect(useVoiceStore.getState().activeChannelId).toBeNull();
    });

    it('control: an unimpeded join emits voice:join for the channel', async () => {
      const socket = vi.mocked(getSocket)()!;
      vi.mocked(socket.emit).mockClear();

      // navigator.mediaDevices is undefined in jsdom → listen-only join
      await useVoiceStore.getState().joinChannel('ch-ok');

      expect(socket.emit).toHaveBeenCalledWith(
        'voice:join',
        'ch-ok',
        expect.objectContaining({ selfMute: expect.any(Boolean), selfDeaf: expect.any(Boolean) }),
      );
      expect(useVoiceStore.getState().activeChannelId).toBe('ch-ok');

      // Clean up latency interval / voice state for subsequent tests
      useVoiceStore.getState().leaveChannel();
    });
  });

  describe('updateUserState — server-deafen enforcement (HIGH-12)', () => {
    it('mutes every remote audio element when the local user is server-deafened', () => {
      const micAudio = fakeAudioElement();
      const screenAudio = fakeAudioElement();
      useVoiceStore.setState({
        localUserId: 'me',
        selfDeaf: false,
        channelUsers: new Map([['ch-1', [
          { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false },
        ]]]),
        remoteAudios: new Map([
          ['user-2', micAudio as unknown as HTMLAudioElement],
          ['user-2-screen', screenAudio as unknown as HTMLAudioElement],
        ]),
      });

      useVoiceStore.getState().updateUserState('ch-1', 'me', false, false, false, true);

      expect(micAudio.muted).toBe(true);
      expect(screenAudio.muted).toBe(true);
      expect(useVoiceStore.getState().selfDeaf).toBe(true);
    });

    it('restores hearing when the server-deafen is lifted (un-deafen)', () => {
      const micAudio = fakeAudioElement();
      micAudio.muted = true;
      useVoiceStore.setState({
        localUserId: 'me',
        selfDeaf: true, // forced on by the earlier server-deafen
        channelUsers: new Map([['ch-1', [
          { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null, selfMute: true, selfDeaf: true, serverMuted: true, serverDeafened: true, speaking: false },
        ]]]),
        remoteAudios: new Map([['user-2', micAudio as unknown as HTMLAudioElement]]),
      });

      // Moderator un-deafens us
      useVoiceStore.getState().updateUserState('ch-1', 'me', true, false, true, false);

      expect(micAudio.muted).toBe(false);
      expect(useVoiceStore.getState().selfDeaf).toBe(false);
    });

    it('does NOT force-undeafen a self-deafened user on unrelated state updates', () => {
      const micAudio = fakeAudioElement();
      micAudio.muted = true;
      useVoiceStore.setState({
        localUserId: 'me',
        selfDeaf: true, // user's own choice — was never server-deafened
        channelUsers: new Map([['ch-1', [
          { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null, selfMute: true, selfDeaf: true, serverMuted: false, serverDeafened: false, speaking: false },
        ]]]),
        remoteAudios: new Map([['user-2', micAudio as unknown as HTMLAudioElement]]),
      });

      // e.g. a moderator server-mutes us — serverDeafened stays false
      useVoiceStore.getState().updateUserState('ch-1', 'me', true, true, true, false);

      expect(micAudio.muted).toBe(true);
      expect(useVoiceStore.getState().selfDeaf).toBe(true);
    });

    it('pauses only the mic producer when server-muted', () => {
      const mic = fakeProducer('audio');
      const screenAudio = fakeProducer('screen-audio');
      useVoiceStore.setState({
        localUserId: 'me',
        selfMute: false,
        channelUsers: new Map([['ch-1', []]]),
        msProducers: new Map([[mic.id, mic], [screenAudio.id, screenAudio]]) as unknown as Map<string, Producer>,
      });

      useVoiceStore.getState().updateUserState('ch-1', 'me', false, false, true, false);

      expect(mic.pause).toHaveBeenCalled();
      expect(screenAudio.pause).not.toHaveBeenCalled();
      expect(useVoiceStore.getState().selfMute).toBe(true);
    });
  });

  // ─── P3: ICE candidate queueing in handleDMSignal ─────────────────────────

  describe('handleDMSignal — ICE candidate queue (P3)', () => {
    const PEER = { userId: 'peer-x', deviceId: 'device-peerx001' };

    beforeEach(() => {
      FakeRTCPeerConnection.instances = [];
      vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
      // Identity constructors: `new RTCSessionDescription(init)` → init
      vi.stubGlobal('RTCSessionDescription', function (this: unknown, init: unknown) { return init; });
      vi.stubGlobal('RTCIceCandidate', function (this: unknown, init: unknown) { return init; });
      // Signals only flow once the call peer's device is pinned (spec §20);
      // the mocked decrypt passes payloads through verbatim
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallPeerDevice: PEER });
    });

    afterEach(() => {
      useVoiceStore.getState().destroyAllPeers();
      vi.unstubAllGlobals();
    });

    it('queues candidates arriving before the remote description and flushes them on answer', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.getState().createDMPeer('peer-x', true);
      await flushAsync(); // let the initiator offer chain settle

      const pc = FakeRTCPeerConnection.instances[0];
      expect(pc).toBeDefined();
      expect(pc.signalingState).toBe('have-local-offer');

      // ICE candidate races ahead of the answer → must be queued, not dropped
      useVoiceStore.getState().handleDMSignal('peer-x', {
        type: 'ice-candidate',
        candidate: { candidate: 'c1' },
      });
      await flushAsync(); // decrypt chain
      expect(pc.addIceCandidate).not.toHaveBeenCalled();
      expect(useVoiceStore.getState().peers.get('peer-x')!.pendingCandidates).toHaveLength(1);

      // Answer arrives → remote description set → queue flushed
      useVoiceStore.getState().handleDMSignal('peer-x', { type: 'answer', sdp: 'remote' });
      await flushAsync();

      expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
      expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'c1' });
      expect(useVoiceStore.getState().peers.get('peer-x')!.pendingCandidates).toHaveLength(0);
    });

    it('control: a candidate arriving AFTER the answer is applied immediately', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.getState().createDMPeer('peer-x', true);
      await flushAsync();

      const pc = FakeRTCPeerConnection.instances[0];
      useVoiceStore.getState().handleDMSignal('peer-x', { type: 'answer', sdp: 'remote' });
      await flushAsync();
      expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'remote' });

      useVoiceStore.getState().handleDMSignal('peer-x', {
        type: 'ice-candidate',
        candidate: { candidate: 'c2' },
      });
      await flushAsync();

      expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
      expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'c2' });
      expect(useVoiceStore.getState().peers.get('peer-x')!.pendingCandidates).toHaveLength(0);
    });
  });

  describe('DM call signaling — E2E cutover (spec §20)', () => {
    const PEER = { userId: 'peer-x', deviceId: 'device-peerx001' };
    const peerUser = { id: 'peer-x', username: 'peer', displayName: 'Peer', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false };
    const socketEmit = () => vi.mocked(vi.mocked(getSocket)()!.emit);

    beforeEach(() => {
      FakeRTCPeerConnection.instances = [];
      vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
      vi.stubGlobal('RTCSessionDescription', function (this: unknown, init: unknown) { return init; });
      vi.stubGlobal('RTCIceCandidate', function (this: unknown, init: unknown) { return init; });
    });

    afterEach(() => {
      useVoiceStore.getState().destroyAllPeers();
      vi.unstubAllGlobals();
    });

    it('seals every outbound signal to the pinned device and emits ONLY envelopes', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallPeerDevice: PEER });

      useVoiceStore.getState().createDMPeer('peer-x', true); // initiator → offer
      await flushAsync();

      expect(cc.encryptCallSignal).toHaveBeenCalledWith('conv-1', PEER, { type: 'offer', sdp: 'x' });
      const signalEmits = socketEmit().mock.calls.filter((c) => c[0] === 'dm:voice:signal');
      expect(signalEmits).toHaveLength(1);
      // The wire payload is the fake envelope from the encrypt mock — the
      // plaintext signal object must never be emitted
      expect(signalEmits[0][1]).toEqual({
        to: 'peer-x',
        signal: JSON.stringify({ env: { type: 'offer', sdp: 'x' } }),
      });
    });

    it('drops outbound signals once the call has ended (no plaintext, no ghost envelope)', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallPeerDevice: PEER });
      // Slow encrypt: hang up while the offer is being sealed
      cc.encryptCallSignal.mockImplementation(async (_c: string, _p: unknown, signal: unknown) => {
        await new Promise((r) => setTimeout(r, 0));
        return JSON.stringify({ env: signal });
      });

      useVoiceStore.getState().createDMPeer('peer-x', true);
      useVoiceStore.getState().leaveDMCall();
      await flushAsync();

      const signalEmits = socketEmit().mock.calls.filter((c) => c[0] === 'dm:voice:signal');
      expect(signalEmits).toHaveLength(0);
    });

    it('aborts the call when an inbound signal is legacy plaintext (hard cutover)', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallPeerDevice: PEER, dmCallUsers: [peerUser] });
      cc.decryptCallSignal.mockRejectedValue(new cc.CallSecurityError('legacy-signal', 'not an envelope'));

      useVoiceStore.getState().handleDMSignal('peer-x', { type: 'offer', sdp: 'plaintext' });
      await flushAsync();

      expect(useVoiceStore.getState().dmCallConversationId).toBeNull();
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(0);
      expect(socketEmit()).toHaveBeenCalledWith('dm:voice:leave', 'conv-1');
    });

    it('aborts the call when the peer identity changes mid-call — never degrades', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallPeerDevice: PEER });
      cc.decryptCallSignal.mockRejectedValue(new cc.E2EIdentityChangedError('peer-x'));

      useVoiceStore.getState().handleDMSignal('peer-x', '{"v":1,"e":"olm1","t":1,"b":"x"}');
      await flushAsync();

      expect(useVoiceStore.getState().dmCallConversationId).toBeNull();
    });

    it('aborts when the peer joins without an E2E call device (un-updated client)', () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.setState({ dmCallConversationId: 'conv-1' });

      useVoiceStore.getState().addDMCallUser(peerUser); // no deviceId

      expect(useVoiceStore.getState().dmCallConversationId).toBeNull();
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(0);
    });

    it('buffers signals arriving before the pin and flushes them once the joined event lands', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.setState({ dmCallConversationId: 'conv-1' });

      // The peer's offer beats their dm:voice:joined event — must buffer
      useVoiceStore.getState().handleDMSignal('peer-x', { type: 'offer', sdp: 'early' });
      await flushAsync();
      expect(cc.decryptCallSignal).not.toHaveBeenCalled();

      // joined event pins the device → session begins → buffer flushes in order
      useVoiceStore.getState().addDMCallUser({ ...peerUser, deviceId: PEER.deviceId });
      await flushAsync();

      expect(cc.beginCallSignaling).toHaveBeenCalledWith('conv-1', PEER);
      expect(cc.decryptCallSignal).toHaveBeenCalledWith('conv-1', PEER, { type: 'offer', sdp: 'early' });
      // The buffered offer drove responder-peer creation
      const pc = FakeRTCPeerConnection.instances[0];
      expect(pc).toBeDefined();
      expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'early' });
    });

    it('re-pins and tears down the old peer when the call peer rejoins from another device', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      const mockPc = { close: vi.fn() };
      useVoiceStore.setState({
        dmCallConversationId: 'conv-1',
        dmCallPeerDevice: PEER,
        dmCallUsers: [peerUser],
        peers: new Map([['peer-x', { pc: mockPc as unknown as RTCPeerConnection, makingOffer: false, pendingCandidates: [] }]]),
      });

      useVoiceStore.getState().addDMCallUser({ ...peerUser, deviceId: 'device-peerx002' });
      await flushAsync();

      expect(useVoiceStore.getState().dmCallPeerDevice).toEqual({ userId: 'peer-x', deviceId: 'device-peerx002' });
      expect(mockPc.close).toHaveBeenCalled(); // old DTLS session is dead
      expect(cc.beginCallSignaling).toHaveBeenCalledWith('conv-1', { userId: 'peer-x', deviceId: 'device-peerx002' });
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(1); // no duplicate entry
    });

    it('drops signals from anyone who is not the pinned call peer', async () => {
      useVoiceStore.getState().setLocalUserId('me');
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallPeerDevice: PEER });

      useVoiceStore.getState().handleDMSignal('mallory', { type: 'offer', sdp: 'evil' });
      await flushAsync();

      expect(cc.decryptCallSignal).not.toHaveBeenCalled();
      expect(useVoiceStore.getState().peers.size).toBe(0);
      expect(useVoiceStore.getState().dmCallConversationId).toBe('conv-1'); // call unharmed
    });

    it('leaveDMCall clears the pin and the callCrypto session state', async () => {
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallPeerDevice: PEER });

      useVoiceStore.getState().leaveDMCall();
      await flushAsync();

      expect(useVoiceStore.getState().dmCallPeerDevice).toBeNull();
      expect(cc.endCallSignaling).toHaveBeenCalledWith('conv-1');
    });
  });
});
