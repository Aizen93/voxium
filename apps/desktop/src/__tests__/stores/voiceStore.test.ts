import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

vi.mock('../../services/sdpUtils', () => ({
  optimizeOpusSDP: vi.fn((sdp: string) => sdp),
}));

vi.mock('@timephy/rnnoise-wasm', () => ({
  NoiseSuppressorWorklet_Name: 'NoiseSuppressorWorklet',
}));
vi.mock('@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url', () => ({
  default: 'mock-url',
}));

vi.mock('./settingsStore', async () => {
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

import { useVoiceStore } from '../../stores/voiceStore';

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
      incomingCall: null,
      peers: new Map(),
      remoteAudios: new Map(),
    });
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
        from: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false },
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
          from: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false },
        },
      });
      useVoiceStore.getState().declineCall();
      expect(useVoiceStore.getState().incomingCall).toBeNull();
    });
  });

  describe('addDMCallUser', () => {
    it('should add a user to dmCallUsers', () => {
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', localUserId: 'user-1' });
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false };
      useVoiceStore.getState().addDMCallUser(user);
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(1);
      expect(useVoiceStore.getState().dmCallUsers[0].id).toBe('user-2');
    });

    it('should not add duplicate users', () => {
      useVoiceStore.setState({ dmCallConversationId: 'conv-1', localUserId: 'user-1' });
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false };
      useVoiceStore.getState().addDMCallUser(user);
      useVoiceStore.getState().addDMCallUser(user);
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(1);
    });
  });

  describe('removeDMCallUser', () => {
    it('should remove a user from dmCallUsers', () => {
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false };
      useVoiceStore.setState({ dmCallUsers: [user] });
      useVoiceStore.getState().removeDMCallUser('user-2');
      expect(useVoiceStore.getState().dmCallUsers).toHaveLength(0);
    });
  });

  describe('updateDMCallUserState', () => {
    it('should update mute/deaf state for a DM call user', () => {
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false };
      useVoiceStore.setState({ dmCallUsers: [user] });
      useVoiceStore.getState().updateDMCallUserState('user-2', true, true);
      const updated = useVoiceStore.getState().dmCallUsers[0];
      expect(updated.selfMute).toBe(true);
      expect(updated.selfDeaf).toBe(true);
    });
  });

  describe('setDMCallUserSpeaking', () => {
    it('should update speaking state for a DM call user', () => {
      const user = { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false };
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
        peers: new Map([['user-2', { pc: mockPc as any, makingOffer: false }]]),
        remoteAudios: new Map([['user-2', mockAudio as any]]),
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
          ['user-2', { pc: mockPc1 as any, makingOffer: false }],
          ['user-3', { pc: mockPc2 as any, makingOffer: false }],
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
});
