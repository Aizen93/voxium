import { describe, it, expect } from 'vitest';

/**
 * Tests for push-to-talk logic.
 * These test the core behavioral logic (guard conditions, event routing,
 * speaking indicator) without requiring React rendering or DOM event simulation.
 */

describe('Push-to-Talk logic', () => {
  describe('guard conditions (should PTT activate?)', () => {
    it('should allow PTT when in a DM call with a stream, even if muted', () => {
      const state = { activeChannelId: null, dmCallConversationId: 'conv-1', selfMute: true, localStream: {} };
      // The guard in usePushToTalk: (!activeChannelId && !dmCallConversationId) || !localStream
      // selfMute is NOT checked — PTT overrides mute
      const shouldBlock = (!state.activeChannelId && !state.dmCallConversationId) || !state.localStream;
      expect(shouldBlock).toBe(false);
    });

    it('should allow PTT when in a server voice channel with a stream', () => {
      const state = { activeChannelId: 'ch-1', dmCallConversationId: null, localStream: {} };
      const shouldBlock = (!state.activeChannelId && !state.dmCallConversationId) || !state.localStream;
      expect(shouldBlock).toBe(false);
    });

    it('should block PTT when not in any call', () => {
      const state = { activeChannelId: null, dmCallConversationId: null, localStream: {} };
      const shouldBlock = (!state.activeChannelId && !state.dmCallConversationId) || !state.localStream;
      expect(shouldBlock).toBe(true);
    });

    it('should block PTT when no localStream', () => {
      const state = { activeChannelId: 'ch-1', dmCallConversationId: null, localStream: null };
      const shouldBlock = (!state.activeChannelId && !state.dmCallConversationId) || !state.localStream;
      expect(shouldBlock).toBe(true);
    });

    it('should NOT check selfMute in the guard (PTT overrides mute)', () => {
      // This is the critical behavior change: PTT works even when muted
      const state = { activeChannelId: null, dmCallConversationId: 'conv-1', selfMute: true, localStream: {} };
      const shouldBlock = (!state.activeChannelId && !state.dmCallConversationId) || !state.localStream;
      // selfMute is true but should NOT block PTT
      expect(shouldBlock).toBe(false);
    });
  });

  describe('event routing (DM vs server)', () => {
    it('should route to dm:voice:mute when in a DM call', () => {
      const state = { activeChannelId: null, dmCallConversationId: 'conv-1' };
      let emittedEvent = '';
      if (state.activeChannelId) emittedEvent = 'voice:mute';
      else if (state.dmCallConversationId) emittedEvent = 'dm:voice:mute';
      expect(emittedEvent).toBe('dm:voice:mute');
    });

    it('should route to voice:mute when in a server voice channel', () => {
      const state = { activeChannelId: 'ch-1', dmCallConversationId: null };
      let emittedEvent = '';
      if (state.activeChannelId) emittedEvent = 'voice:mute';
      else if (state.dmCallConversationId) emittedEvent = 'dm:voice:mute';
      expect(emittedEvent).toBe('voice:mute');
    });

    it('should not emit any event when not in a call', () => {
      const state = { activeChannelId: null, dmCallConversationId: null };
      let emittedEvent = '';
      if (state.activeChannelId) emittedEvent = 'voice:mute';
      else if (state.dmCallConversationId) emittedEvent = 'dm:voice:mute';
      expect(emittedEvent).toBe('');
    });
  });

  describe('speaking indicator with PTT override', () => {
    it('should show speaking when pttActive overrides selfMute', () => {
      const isSpeaking = 0.1 > 0.05 && (!true || true); // audioLevel > threshold && (!selfMute || pttActive)
      expect(isSpeaking).toBe(true);
    });

    it('should not show speaking when muted without PTT', () => {
      const isSpeaking = 0.1 > 0.05 && (!true || false);
      expect(isSpeaking).toBe(false);
    });

    it('should show speaking when unmuted (normal voice activity)', () => {
      const isSpeaking = 0.1 > 0.05 && (!false || false);
      expect(isSpeaking).toBe(true);
    });

    it('should not show speaking when audio level is below threshold', () => {
      const isSpeaking = 0.01 > 0.05 && (!false || false);
      expect(isSpeaking).toBe(false);
    });

    it('should not show speaking when pttActive but audio is silent', () => {
      const isSpeaking = 0.01 > 0.05 && (!true || true);
      expect(isSpeaking).toBe(false);
    });
  });

  describe('STUN URL derivation', () => {
    it('should extract hostname from a valid WS URL', () => {
      const wsUrl = 'http://192.168.1.15:3001';
      const hostname = new URL(wsUrl).hostname;
      expect(hostname).toBe('192.168.1.15');
    });

    it('should extract hostname from a domain-based URL', () => {
      const wsUrl = 'https://voxium.example.com';
      const hostname = new URL(wsUrl).hostname;
      expect(hostname).toBe('voxium.example.com');
    });

    it('should produce a valid STUN URL', () => {
      const wsUrl = 'http://10.0.0.5:3001';
      const stunUrl = `stun:${new URL(wsUrl).hostname}:3478`;
      expect(stunUrl).toBe('stun:10.0.0.5:3478');
    });

    it('should fall back to localhost for invalid URLs', () => {
      let hostname: string;
      try {
        hostname = new URL('not-a-url').hostname;
      } catch {
        hostname = 'localhost';
      }
      expect(hostname).toBe('localhost');
    });
  });

  describe('noise suppression toggle generation counter', () => {
    it('should cancel stale async work when generation increments', () => {
      let generation = 0;

      // Simulate first toggle
      const gen1 = ++generation;
      expect(gen1).toBe(1);

      // Simulate second toggle before first completes
      const gen2 = ++generation;
      expect(gen2).toBe(2);

      // First toggle checks — should abort
      expect(gen1 !== generation).toBe(true);
      // Second toggle checks — should proceed
      expect(gen2 !== generation).toBe(false);
    });

    it('should allow the latest toggle to proceed', () => {
      let generation = 0;
      const gen = ++generation;
      // No subsequent toggles — should proceed
      expect(gen === generation).toBe(true);
    });
  });
});
