import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A push-to-talk release in a voice channel. The raw microphone is disabled
 * at once; the mic producer's pause, which disables the gated track it sends,
 * waits under the audio-thread gate for its look-ahead to drain (what was
 * said up to the release is sent) and is immediate under the page timer. One
 * place owns the pending pause; what changes the producer cancels it or makes
 * it immediate, and a late fire pauses nothing it was not scheduled for.
 */

vi.mock('mediasoup-client', () => ({ Device: vi.fn() }));

const socket = vi.hoisted(() => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn(() => socket),
  onSocketReconnect: vi.fn(),
}));

const aa = vi.hoisted(() => {
  const state = { decider: 'audio-thread' as 'audio-thread' | 'page-timer' | null };
  return {
    state,
    startSpeakingDetection: vi.fn(),
    stopSpeakingDetection: vi.fn(),
    setNoiseGateThreshold: vi.fn(),
    getGatedStream: vi.fn(() => null),
    setNoiseSuppression: vi.fn(),
    onSpeakingChange: vi.fn(),
    applyNoiseSuppression: vi.fn(async (stream: MediaStream) => stream),
    getSuppressedStream: vi.fn(() => null),
    stopNoiseSuppression: vi.fn(),
    setSpeakingDetectionPaused: vi.fn(),
    onNoiseSuppressionFailure: vi.fn(),
    getSpeakingDetectionMode: vi.fn(() => 'server'),
    resendSpeaking: vi.fn(),
    getSpeakingDecider: vi.fn(() => state.decider),
  };
});
vi.mock('../../services/audioAnalyser', () => aa);

vi.mock('../../services/sdpUtils', () => ({ optimizeOpusSDP: vi.fn((sdp: string) => sdp) }));
vi.mock('../../services/e2e/callCrypto', () => ({
  beginCallSignaling: vi.fn(), endCallSignaling: vi.fn(), getCallPeerDevice: vi.fn(),
  encryptCallSignal: vi.fn(), decryptCallSignal: vi.fn(),
  CallSecurityError: class extends Error {}, E2EIdentityChangedError: class extends Error {},
}));
vi.mock('../../services/e2e/secureVoiceKeys', () => ({
  isSecureVoiceSupported: vi.fn(() => true),
  beginSecureVoiceSession: vi.fn(),
  endSecureVoiceSession: vi.fn(),
  endSecureVoiceSessionFor: vi.fn(),
}));
vi.mock('../../stores/dmStore', () => ({
  useDMStore: { getState: () => ({ conversations: [], removalSeq: 0, removedAt: {} }) },
  wasRemovedSince: () => false,
}));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ channels: [{ id: 'ch-1', type: 'voice', secure: false }] }) },
}));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: { id: 'me' } }) } }));
vi.mock('../../services/e2e/e2eService', () => ({ getE2EService: () => ({ deviceId: 'device-me000001' }) }));
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ ready: true, error: null, initialize: vi.fn() }), subscribe: () => () => {} },
}));
vi.mock('@timephy/rnnoise-wasm', () => ({ NoiseSuppressorWorklet_Name: 'NoiseSuppressorWorklet' }));
vi.mock('@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url', () => ({ default: 'mock-url' }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../stores/toastStore', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

vi.mock('../../stores/settingsStore', async () => {
  const { create } = await import('zustand');
  const store = create<Record<string, unknown>>((set) => ({
    audioInputDeviceId: 'mic-a',
    audioOutputDeviceId: '',
    noiseGateThreshold: 0.008,
    voiceMode: 'push_to_talk',
    pushToTalkKey: 'Space',
    voiceQuality: 'medium',
    enableNoiseSuppression: true,
    noiseSuppressionUnavailable: false,
    setNoiseSuppressionUnavailable: vi.fn((unavailable: boolean) => set({ noiseSuppressionUnavailable: unavailable })),
  }));
  return { useSettingsStore: store, VOICE_QUALITY_BITRATE: { low: 16000, medium: 32000, high: 64000 } };
});

import { useVoiceStore, PTT_RELEASE_PAUSE_DELAY_MS } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePushToTalk } from '../../hooks/usePushToTalk';
import { GATE_LOOKAHEAD_MS } from '../../services/noiseGate';
import type { Producer } from 'mediasoup-client/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Fakes ───────────────────────────────────────────────────────────────────

function fakeTrack() {
  return { kind: 'audio', enabled: false, readyState: 'live', stop: vi.fn() };
}

function fakeStream() {
  const track = fakeTrack();
  return { track, stream: { id: 'raw', getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}

function fakeMicProducer(id: string) {
  return {
    id,
    kind: 'audio',
    appData: { type: 'audio' },
    closed: false,
    paused: false,
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
    replaceTrack: vi.fn(async () => {}),
  };
}
type FakeProducer = ReturnType<typeof fakeMicProducer>;

const producersOf = (...list: FakeProducer[]) => new Map(list.map((p) => [p.id, p as unknown as Producer]));

function Probe() {
  usePushToTalk();
  return null;
}

let container: HTMLDivElement;
let root: Root;
let raw: ReturnType<typeof fakeStream>;
let producer: FakeProducer;

const press = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); });
const release = () => act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  aa.state.decider = 'audio-thread';
  useSettingsStore.setState({ voiceMode: 'push_to_talk', pushToTalkKey: 'Space', enableNoiseSuppression: true });
  raw = fakeStream();
  producer = fakeMicProducer('mic-1');
  useVoiceStore.setState({
    localUserId: 'me',
    activeChannelId: 'ch-1',
    activeVoiceServerId: 'srv-1',
    dmCallConversationId: null,
    localStream: raw.stream,
    selfMute: false,
    selfDeaf: false,
    pttActive: false,
    msProducers: producersOf(producer),
    peers: new Map(),
    channelUsers: new Map([['ch-1', [{ id: 'me', selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false } as never]]]),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<Probe />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useVoiceStore.setState({ activeChannelId: null, localStream: null, msProducers: new Map() });
  vi.useRealTimers();
});

/** The key held, then released: the release's pause is what follows. */
function talkThenRelease() {
  press();
  expect(raw.track.enabled).toBe(true);
  release();
  expect(raw.track.enabled).toBe(false); // nothing said after the release is captured
}

describe('a push-to-talk release in a voice channel', () => {
  it('the delay is the look-ahead and a margin, well under the 150 ms before the release\'s mute reaches the server', () => {
    expect(PTT_RELEASE_PAUSE_DELAY_MS).toBe(GATE_LOOKAHEAD_MS + 25);
    expect(PTT_RELEASE_PAUSE_DELAY_MS).toBeLessThan(150);
  });

  it('under the audio-thread gate: the producer is paused after the look-ahead has drained, not before', () => {
    talkThenRelease();
    expect(producer.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PTT_RELEASE_PAUSE_DELAY_MS - 1);
    expect(producer.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(producer.pause).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(producer.pause).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('voice:mute', true);
  });

  it('under the page timer (the gate\'s module loading, or its fallback): at once', () => {
    for (const decider of ['page-timer', null] as const) {
      aa.state.decider = decider;
      producer.pause.mockClear();
      talkThenRelease();
      expect(producer.pause).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      expect(producer.pause).toHaveBeenCalledTimes(1);
    }
  });

  it('a re-press inside the delay leaves the producer live and schedules nothing', () => {
    const idle = vi.getTimerCount();
    talkThenRelease();
    expect(vi.getTimerCount()).toBe(idle + 2); // the pause, and the release's voice:mute
    vi.advanceTimersByTime(20);
    press();
    expect(vi.getTimerCount()).toBe(idle); // both dropped by the key, not left to fire and find it down
    vi.advanceTimersByTime(1_000); // held well past the first delay
    expect(producer.pause).not.toHaveBeenCalled();
    expect(raw.track.enabled).toBe(true);

    // The next release pauses once, after its own delay
    release();
    vi.advanceTimersByTime(PTT_RELEASE_PAUSE_DELAY_MS);
    expect(producer.pause).toHaveBeenCalledTimes(1);
  });

  describe('what changes the producer makes the pending pause immediate', () => {
    /** Runs `change` inside the delay; the pause comes at once, nothing after. */
    function immediateOn(change: () => void) {
      talkThenRelease();
      vi.advanceTimersByTime(10);
      act(() => change());
      expect(producer.pause).toHaveBeenCalled();
      const atChange = producer.pause.mock.calls.length;
      vi.advanceTimersByTime(1_000);
      expect(producer.pause).toHaveBeenCalledTimes(atChange);
    }

    it('a mute (it pauses at once, as it always did)', () => {
      immediateOn(() => useVoiceStore.getState().toggleMute());
      expect(useVoiceStore.getState().selfMute).toBe(true);
    });

    it('a deafen', () => {
      immediateOn(() => useVoiceStore.getState().toggleDeaf());
      expect(useVoiceStore.getState().selfDeaf).toBe(true);
    });

    it('a server mute', () => {
      immediateOn(() => useVoiceStore.getState().updateUserState('ch-1', 'me', false, false, true, false));
    });

    it('a pipeline rebuild (the noise-suppression switch)', () => {
      immediateOn(() => useSettingsStore.setState({ enableNoiseSuppression: false }));
      expect(aa.applyNoiseSuppression).toHaveBeenCalled();
    });

    it('a switch to voice activity: the producer is resumed by it and stays live', () => {
      immediateOn(() => useSettingsStore.setState({ voiceMode: 'voice_activity' }));
      expect(producer.resume.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(producer.pause.mock.invocationCallOrder.at(-1)!);
    });
  });

  describe('a late fire pauses nothing it was not scheduled for', () => {
    it('after the session\'s teardown, even were the same producer still registered', () => {
      talkThenRelease();
      const pending = vi.getTimerCount();
      act(() => { useVoiceStore.getState().leaveChannel(); });
      expect(vi.getTimerCount()).toBe(pending - 1); // the teardown dropped the pause itself
      // The teardown closed the producers; put the very same one back as if kept
      useVoiceStore.setState({ activeChannelId: 'ch-1', localStream: raw.stream, msProducers: producersOf(producer) });
      producer.pause.mockClear();
      vi.advanceTimersByTime(1_000);
      expect(producer.pause).not.toHaveBeenCalled();
    });

    it('for a replaced producer: neither the old one nor the new one', () => {
      talkThenRelease();
      const replacement = fakeMicProducer('mic-2');
      useVoiceStore.setState({ msProducers: producersOf(replacement) });
      vi.advanceTimersByTime(1_000);
      expect(producer.pause).not.toHaveBeenCalled();
      expect(replacement.pause).not.toHaveBeenCalled();

      // A closed one is not paused either
      useVoiceStore.setState({ msProducers: producersOf(producer) });
      talkThenRelease();
      producer.closed = true;
      vi.advanceTimersByTime(1_000);
      expect(producer.pause).not.toHaveBeenCalled();
    });

    it('with the key down again (the key state is read when it fires)', () => {
      talkThenRelease();
      // The key state changed without a key event reaching the hook
      useVoiceStore.setState({ pttActive: true });
      vi.advanceTimersByTime(1_000);
      expect(producer.pause).not.toHaveBeenCalled();
    });
  });

  it('a direct call: the release disables the raw microphone only, nothing is paused or scheduled', () => {
    useVoiceStore.setState({ activeChannelId: null, dmCallConversationId: 'conv-1', msProducers: producersOf(producer) });
    talkThenRelease();
    vi.advanceTimersByTime(1_000);
    expect(producer.pause).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('dm:voice:mute', true);
  });
});
