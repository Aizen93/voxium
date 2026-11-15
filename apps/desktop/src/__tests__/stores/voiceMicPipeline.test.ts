import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The microphone pipeline of a live call: noise suppression and speaking
 * detection are module-level singletons in audioAnalyser, rebuilt by a join,
 * the noise-suppression toggle, an input-device change, a noise-suppression
 * failure and a socket reconnect. These drive those rebuilds in the orders a
 * real browser can produce and pin what the call ends up sending.
 */

vi.mock('mediasoup-client', () => ({ Device: vi.fn() }));

const socket = vi.hoisted(() => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn(() => socket),
  onSocketReconnect: vi.fn(),
}));

// The audio service, with the state the store reads back from it
const aa = vi.hoisted(() => {
  const state = {
    failureListener: null as ((f: { phase: 'start' | 'running'; reason: 'load-error' | 'processor-error'; rawStream: MediaStream }) => void) | null,
    suppressed: null as MediaStream | null,
    gated: null as MediaStream | null,
    mode: null as 'server' | 'dm' | null,
  };
  return {
    state,
    startSpeakingDetection: vi.fn((_stream: MediaStream, mode: 'server' | 'dm' = 'server') => { state.mode = mode; }),
    stopSpeakingDetection: vi.fn(() => { state.mode = null; }),
    setNoiseGateThreshold: vi.fn(),
    getGatedStream: vi.fn(() => state.gated),
    setNoiseSuppression: vi.fn(),
    onSpeakingChange: vi.fn(),
    applyNoiseSuppression: vi.fn(async (stream: MediaStream) => stream),
    getSuppressedStream: vi.fn(() => state.suppressed),
    stopNoiseSuppression: vi.fn(),
    setSpeakingDetectionPaused: vi.fn(),
    onNoiseSuppressionFailure: vi.fn((listener: typeof state.failureListener) => { state.failureListener = listener; }),
    getSpeakingDetectionMode: vi.fn(() => state.mode),
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
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => ({ conversations: [] }) } }));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ channels: [{ id: 'ch-1', type: 'voice', secure: false }] }) },
}));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: { id: 'me' } }) } }));
vi.mock('../../services/e2e/e2eService', () => ({
  getE2EService: () => ({ deviceId: 'device-me000001', fetchDeviceList: vi.fn(async () => ({})) }),
}));
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ ready: true, error: null, initialize: vi.fn() }), subscribe: () => () => {} },
}));
vi.mock('@timephy/rnnoise-wasm', () => ({ NoiseSuppressorWorklet_Name: 'NoiseSuppressorWorklet' }));
vi.mock('@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url', () => ({ default: 'mock-url' }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

// A real store: the pipeline reacts to its subscriptions, and its setters persist
vi.mock('../../stores/settingsStore', async () => {
  const { create } = await import('zustand');
  const store = create<Record<string, unknown>>((set) => ({
    audioInputDeviceId: 'mic-a',
    audioOutputDeviceId: '',
    noiseGateThreshold: 0.008,
    voiceMode: 'voice_activity',
    voiceQuality: 'medium',
    enableNoiseSuppression: true,
    noiseSuppressionUnavailable: false,
    setEnableNoiseSuppression: vi.fn((enabled: boolean) => set({ enableNoiseSuppression: enabled })),
    setNoiseSuppressionUnavailable: vi.fn((unavailable: boolean) => set({ noiseSuppressionUnavailable: unavailable })),
    setAudioInputDeviceId: vi.fn((deviceId: string) => set({ audioInputDeviceId: deviceId })),
  }));
  return { useSettingsStore: store, VOICE_QUALITY_BITRATE: { low: 16000, medium: 32000, high: 64000 } };
});

import { useVoiceStore, _resetNoiseSuppressionNoticeForTests } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { onSocketReconnect } from '../../services/socket';
import { Device } from 'mediasoup-client';
import { beginSecureVoiceSession } from '../../services/e2e/secureVoiceKeys';
import type { Producer } from 'mediasoup-client/types';

// Captured at import, before any beforeEach clears the mock: voiceStore
// registers its one reconnect handler at module load
const reconnectHandler = vi.mocked(onSocketReconnect).mock.calls[0]?.[0] as () => Promise<void>;

// ─── Fakes ───────────────────────────────────────────────────────────────────

type FakeTrack = { kind: 'audio'; label: string; enabled: boolean; readyState: 'live' | 'ended'; stop: ReturnType<typeof vi.fn> };
type FakeStream = MediaStream & { track: FakeTrack };

function fakeStream(label: string): FakeStream {
  const track: FakeTrack = { kind: 'audio', label, enabled: true, readyState: 'live', stop: vi.fn() };
  track.stop.mockImplementation(() => { track.readyState = 'ended'; });
  return { id: label, track, getTracks: () => [track], getAudioTracks: () => [track] } as unknown as FakeStream;
}

function fakeProducer(type: 'audio' | 'screen-audio') {
  return {
    id: `producer-${type}`,
    kind: 'audio',
    appData: { type },
    closed: false,
    paused: false,
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
    replaceTrack: vi.fn(async (_: { track: MediaStreamTrack }) => {}),
  };
}

function fakePeer() {
  const sender = { track: { kind: 'audio' }, replaceTrack: vi.fn(async (_: MediaStreamTrack) => {}) };
  return { sender, peer: { pc: { getSenders: () => [sender], close: vi.fn() }, makingOffer: false, pendingCandidates: [] } };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A promise this test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const failure = (phase: 'start' | 'running', rawStream: MediaStream) => {
  expect(aa.state.failureListener).toBeTypeOf('function');
  aa.state.failureListener!({ phase, reason: 'processor-error', rawStream });
};

beforeEach(() => {
  vi.clearAllMocks();
  aa.state.suppressed = null;
  aa.state.gated = null;
  aa.state.mode = null;
  aa.applyNoiseSuppression.mockImplementation(async (stream: MediaStream) => stream);
  aa.startSpeakingDetection.mockImplementation((_stream: MediaStream, mode: 'server' | 'dm' = 'server') => { aa.state.mode = mode; });
  // Out of any call FIRST: resetting the device setting during one would start a switch
  useVoiceStore.setState({
    localUserId: 'me',
    activeChannelId: null,
    activeVoiceServerId: null,
    dmCallConversationId: null,
    localStream: null,
    selfMute: false,
    selfDeaf: false,
    pttActive: false,
    msProducers: new Map(),
    msSendTransport: null,
    msDevice: null,
    peers: new Map(),
  });
  useSettingsStore.setState({ enableNoiseSuppression: true, noiseSuppressionUnavailable: false, audioInputDeviceId: 'mic-a', voiceMode: 'voice_activity' });
  _resetNoiseSuppressionNoticeForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  useVoiceStore.getState().stopLatencyMeasurement();
});

// ─── #91: a failed noise-suppression worklet ─────────────────────────────────

describe('noise suppression failing (#91)', () => {
  it('registers one failure listener at module load', () => {
    expect(aa.state.failureListener).toBeTypeOf('function');
  });

  it('at the start of a join: told once, unavailable for this session, the SAVED setting untouched, the join goes on', async () => {
    const [raw, reopened] = [fakeStream('raw'), fakeStream('reopened')];
    const opens = [raw, reopened];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => opens.shift()) } });
    aa.applyNoiseSuppression.mockImplementationOnce(async (stream: MediaStream) => {
      failure('start', stream);
      return stream;
    });

    await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith('voice.toasts.noiseSuppressionUnavailable');
    expect(toast.error).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().enableNoiseSuppression).toBe(true);
    expect(useSettingsStore.getState().setEnableNoiseSuppression).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().noiseSuppressionUnavailable).toBe(true);
    expect(aa.setNoiseSuppression).toHaveBeenLastCalledWith(false);
    expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.anything());
    useVoiceStore.getState().leaveChannel();
  });

  // ── Failing at a join's start: the microphone is opened again with the
  //    browser's own noise suppression (asking for it on the live track does
  //    nothing in Chromium) ─────────────────────────────────────────────────

  describe('at a join\'s start, the microphone is opened again with the browser\'s noise suppression', () => {
    /** getUserMedia answering `streams` in turn; `events` records opens and stops in order. */
    function mics(...streams: FakeStream[]) {
      const events: string[] = [];
      for (const s of streams) s.track.stop.mockImplementation(() => { s.track.readyState = 'ended'; events.push(`stop ${s.id}`); });
      const queue = [...streams];
      const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
        const next = queue.shift();
        events.push(`open ${next ? next.id : 'none'} ns=${String((constraints.audio as MediaTrackConstraints).noiseSuppression)}`);
        if (!next) throw Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' });
        return next;
      });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
      return { events, getUserMedia };
    }
    const failsAtStart = () => aa.applyNoiseSuppression.mockImplementationOnce(async (stream: MediaStream) => {
      failure('start', stream);
      return stream;
    });

    it('stops the old track FIRST, then opens the same device with the browser\'s suppression on, and the join sends that', async () => {
      const [raw, reopened] = [fakeStream('raw'), fakeStream('reopened')];
      Object.assign(raw.track, { getSettings: () => ({ deviceId: 'mic-a-real' }) });
      const { events, getUserMedia } = mics(raw, reopened);
      failsAtStart();

      await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });

      expect(events).toEqual(['open raw ns=false', 'stop raw', 'open reopened ns=true']);
      expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ noiseSuppression: true, echoCancellation: true, autoGainControl: true, deviceId: { exact: 'mic-a-real' } }) });
      expect(useVoiceStore.getState().localStream).toBe(reopened);
      // The pipeline is rebuilt on it, without RNNoise
      expect(aa.applyNoiseSuppression).toHaveBeenLastCalledWith(reopened);
      expect(aa.setNoiseSuppression).toHaveBeenLastCalledWith(false);
      expect(aa.startSpeakingDetection).toHaveBeenLastCalledWith(reopened, 'server');
      expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.objectContaining({ selfMute: false }));
      expect(reopened.track.stop).not.toHaveBeenCalled();
      // No second notice of any kind
      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(toast.error).not.toHaveBeenCalled();
      useVoiceStore.getState().leaveChannel();
    });

    it('a DM call does the same', async () => {
      const [raw, reopened] = [fakeStream('raw'), fakeStream('reopened')];
      const { events } = mics(raw, reopened);
      failsAtStart();

      await useVoiceStore.getState().joinDMCall('conv-1');

      expect(events).toEqual(['open raw ns=false', 'stop raw', 'open reopened ns=true']);
      expect(useVoiceStore.getState().localStream).toBe(reopened);
      expect(aa.startSpeakingDetection).toHaveBeenLastCalledWith(reopened, 'dm');
      expect(toast.warning).toHaveBeenCalledTimes(1);
      useVoiceStore.getState().leaveDMCall();
    });

    it('a muted DM join keeps the re-opened microphone closed (in a DM call track.enabled is the only mute)', async () => {
      useVoiceStore.setState({ selfMute: true });
      const [raw, reopened] = [fakeStream('raw'), fakeStream('reopened')];
      mics(raw, reopened);
      failsAtStart();

      await useVoiceStore.getState().joinDMCall('conv-1');

      expect(useVoiceStore.getState().localStream).toBe(reopened);
      expect(useVoiceStore.getState().selfMute).toBe(true);
      expect(reopened.track.enabled).toBe(false);
      useVoiceStore.getState().leaveDMCall();
    });

    it('a push-to-talk join keeps the re-opened microphone closed until the key is held', async () => {
      useSettingsStore.setState({ voiceMode: 'push_to_talk' });
      const [raw, reopened] = [fakeStream('raw'), fakeStream('reopened')];
      mics(raw, reopened);
      failsAtStart();

      await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });

      expect(useVoiceStore.getState().localStream).toBe(reopened);
      expect(reopened.track.enabled).toBe(false);
      expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.objectContaining({ selfMute: true }));
      useVoiceStore.getState().leaveChannel();
    });

    it('a secure voice channel too: re-opened before the E2E session begins, whose join then goes on with it', async () => {
      const [raw, reopened] = [fakeStream('raw'), fakeStream('reopened')];
      const { events } = mics(raw, reopened);
      failsAtStart();
      const frames = { onFatal: vi.fn(), attachSender: vi.fn() };
      vi.mocked(beginSecureVoiceSession).mockImplementationOnce(async () => {
        events.push('secure session');
        return { frames, deviceId: 'device-me000001', epoch: 'epochME000001' } as never;
      });

      await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: true });

      expect(events).toEqual(['open raw ns=false', 'stop raw', 'open reopened ns=true', 'secure session']);
      expect(useVoiceStore.getState().localStream).toBe(reopened);
      expect(useVoiceStore.getState().secureVoiceActive).toBe(true);
      useVoiceStore.getState().leaveChannel();
    });

    it('the open with the browser\'s suppression fails: the microphone is opened again as before, and the join goes on with it, no other notice', async () => {
      const [raw, plain] = [fakeStream('raw'), fakeStream('plain')];
      const { events, getUserMedia } = mics(raw);
      getUserMedia.mockImplementationOnce(async () => { events.push('open raw ns=false'); return raw; })
        .mockImplementationOnce(async () => { events.push('open fails ns=true'); throw Object.assign(new Error('nope'), { name: 'OverconstrainedError' }); })
        .mockImplementationOnce(async (c: MediaStreamConstraints) => { events.push(`open plain ns=${String((c.audio as MediaTrackConstraints).noiseSuppression)}`); return plain; });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      failsAtStart();

      await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });

      expect(events).toEqual(['open raw ns=false', 'stop raw', 'open fails ns=true', 'open plain ns=false']);
      expect(useVoiceStore.getState().localStream).toBe(plain);
      expect(aa.startSpeakingDetection).toHaveBeenLastCalledWith(plain, 'server');
      expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.objectContaining({ selfMute: false }));
      expect(toast.warning).toHaveBeenCalledTimes(1); // the noise-suppression notice alone
      warn.mockRestore();
      useVoiceStore.getState().leaveChannel();
    });

    it('both opens fail: the join goes on listen-only, the user told, joined muted, with no detector on the stopped track', async () => {
      const raw = fakeStream('raw');
      const { events } = mics(raw); // every later open fails
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      failsAtStart();

      await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });

      expect(events).toEqual(['open raw ns=false', 'stop raw', 'open none ns=true', 'open none ns=false']);
      expect(useVoiceStore.getState().localStream).toBeNull();
      expect(useVoiceStore.getState().selfMute).toBe(true);
      expect(toast.warning).toHaveBeenCalledWith('voice.toasts.micDenied');
      expect(toast.warning).toHaveBeenCalledTimes(2);
      expect(aa.stopSpeakingDetection).toHaveBeenCalled();
      expect(aa.onSpeakingChange).toHaveBeenLastCalledWith(null);
      expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.objectContaining({ selfMute: true }));
      warn.mockRestore();
      useVoiceStore.getState().leaveChannel();
    });

    it('a leave while it opens: what it opened is stopped, nothing is announced', async () => {
      const [raw, reopened] = [fakeStream('raw'), fakeStream('reopened')];
      const answer = deferred<MediaStream>();
      const getUserMedia = vi.fn().mockResolvedValueOnce(raw).mockImplementationOnce(() => answer.promise);
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
      failsAtStart();

      const join = useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });
      await flush();
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      useVoiceStore.getState().leaveChannel();
      aa.applyNoiseSuppression.mockClear();
      answer.resolve(reopened);
      await join;

      expect(reopened.track.stop).toHaveBeenCalled();
      expect(aa.applyNoiseSuppression).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalledWith('voice:join', expect.anything(), expect.anything());
      expect(useVoiceStore.getState().localStream).toBeNull();
    });

    it('another join while it opens: what it opened is stopped, and the newer join goes on', async () => {
      const [raw, reopened, other] = [fakeStream('raw'), fakeStream('reopened'), fakeStream('other')];
      const answer = deferred<MediaStream>();
      const getUserMedia = vi.fn().mockResolvedValueOnce(raw).mockImplementationOnce(() => answer.promise).mockResolvedValueOnce(other);
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
      failsAtStart();

      const first = useVoiceStore.getState().joinDMCall('conv-1');
      await flush();
      const second = useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });
      await second;
      answer.resolve(reopened);
      await first;

      expect(reopened.track.stop).toHaveBeenCalled();
      expect(useVoiceStore.getState().localStream).toBe(other);
      expect(useVoiceStore.getState().activeChannelId).toBe('ch-1');
      expect(socket.emit).not.toHaveBeenCalledWith('dm:voice:join', expect.anything(), expect.anything());
      useVoiceStore.getState().leaveChannel();
    });

    it('a newer rebuild while it opens (the generation counter): what it opened is stopped and never built over', async () => {
      const [raw, reopened, other] = [fakeStream('raw'), fakeStream('reopened'), fakeStream('other')];
      const answer = deferred<MediaStream>();
      const getUserMedia = vi.fn().mockResolvedValueOnce(raw).mockImplementationOnce(() => answer.promise);
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
      failsAtStart();

      const join = useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });
      await flush();
      // A rebuild of the shared pipeline lands meanwhile, in the same session
      failure('running', other);
      await flush();
      expect(aa.applyNoiseSuppression).toHaveBeenLastCalledWith(other);
      answer.resolve(reopened);
      await join;

      expect(reopened.track.stop).toHaveBeenCalled();
      expect(aa.applyNoiseSuppression).not.toHaveBeenCalledWith(reopened);
      expect(aa.startSpeakingDetection).not.toHaveBeenCalledWith(reopened, expect.anything());
      expect(socket.emit).not.toHaveBeenCalledWith('voice:join', expect.anything(), expect.anything());
    });

    it('a start that is not reported as a failure (a context that did not render in time) opens nothing again', async () => {
      const raw = fakeStream('raw');
      const { getUserMedia } = mics(raw);
      // RNNoise did not run, and nothing was reported

      await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(useVoiceStore.getState().localStream).toBe(raw);
      useVoiceStore.getState().leaveChannel();
    });

    it('RNNoise off in the settings: nothing is opened again (the microphone already has the browser\'s suppression)', async () => {
      useSettingsStore.setState({ enableNoiseSuppression: false });
      const raw = fakeStream('raw');
      const { events } = mics(raw);

      await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });

      expect(events).toEqual(['open raw ns=true']);
      useVoiceStore.getState().leaveChannel();
    });

    it('a failure during the call opens nothing again: the raw microphone stays until the next one is opened', async () => {
      const raw = fakeStream('raw');
      const { getUserMedia } = mics();
      useVoiceStore.setState({ activeChannelId: 'ch-1', localStream: raw });
      aa.state.mode = 'server';

      failure('running', raw);
      await flush();

      expect(getUserMedia).not.toHaveBeenCalled();
      expect(raw.track.stop).not.toHaveBeenCalled();
      expect(aa.startSpeakingDetection).toHaveBeenLastCalledWith(raw, 'server');
    });
  });

  it('a join while RNNoise is unavailable this session never asks for it, not even before the pipeline is built', async () => {
    const raw = fakeStream('raw');
    useVoiceStore.setState({ activeChannelId: 'ch-1', localStream: raw });
    aa.state.mode = 'server';
    failure('running', raw);
    await flush();
    useVoiceStore.getState().leaveChannel();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => fakeStream('next')) } });
    aa.setNoiseSuppression.mockClear();

    await useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });
    await useVoiceStore.getState().joinDMCall('conv-1');

    expect(aa.setNoiseSuppression).toHaveBeenCalled();
    expect(aa.setNoiseSuppression).not.toHaveBeenCalledWith(true);
    useVoiceStore.getState().leaveDMCall();
  });

  it('mid-call in a voice channel: rebuilt on the raw mic, the mic producer\'s track swapped (never re-produced), told once', async () => {
    const raw = fakeStream('raw');
    const gated = fakeStream('gated');
    const mic = fakeProducer('audio');
    const screenAudio = fakeProducer('screen-audio');
    useVoiceStore.setState({
      activeChannelId: 'ch-1',
      localStream: raw,
      msProducers: new Map<string, Producer>([[mic.id, mic as unknown as Producer], [screenAudio.id, screenAudio as unknown as Producer]]),
    });
    aa.state.mode = 'server';
    aa.startSpeakingDetection.mockImplementationOnce((_s: MediaStream, mode = 'server') => { aa.state.mode = mode; aa.state.gated = gated; });

    failure('running', raw);
    await flush();

    expect(aa.setNoiseSuppression).toHaveBeenCalledWith(false);
    expect(aa.applyNoiseSuppression).toHaveBeenCalledTimes(1);
    expect(aa.applyNoiseSuppression).toHaveBeenCalledWith(raw);
    expect(aa.startSpeakingDetection).toHaveBeenCalledWith(raw, 'server');
    expect(mic.replaceTrack).toHaveBeenCalledWith({ track: gated.track });
    expect(screenAudio.replaceTrack).not.toHaveBeenCalled();
    expect(mic.close).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith('voice.toasts.noiseSuppressionUnavailable');
    expect(useSettingsStore.getState().enableNoiseSuppression).toBe(true);
    expect(useSettingsStore.getState().noiseSuppressionUnavailable).toBe(true);
    // The producer keeps following the noise gate on the new pipeline
    expect(aa.onSpeakingChange).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it('mid-call in a DM call: the peer\'s audio sender gets the raw mic track', async () => {
    const raw = fakeStream('raw');
    const { sender, peer } = fakePeer();
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', localStream: raw, peers: new Map([['peer-1', peer as never]]) });
    aa.state.mode = 'dm';

    failure('running', raw);
    await flush();

    expect(aa.startSpeakingDetection).toHaveBeenCalledWith(raw, 'dm');
    expect(sender.replaceTrack).toHaveBeenCalledWith(raw.track);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('mid-join (a secure join still keying, nothing produced yet): detection restarts on the raw mic, so what is produced next is live', async () => {
    const raw = fakeStream('raw');
    aa.state.mode = 'server'; // the join built its pipeline, activeChannelId is not set yet

    failure('running', raw);
    await flush();

    expect(aa.startSpeakingDetection).toHaveBeenCalledWith(raw, 'server');
  });

  it('with no pipeline running (the call ended meanwhile): told, unavailable for the session, nothing rebuilt', async () => {
    failure('running', fakeStream('raw'));
    await flush();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().enableNoiseSuppression).toBe(true);
    expect(useSettingsStore.getState().noiseSuppressionUnavailable).toBe(true);
    expect(aa.applyNoiseSuppression).not.toHaveBeenCalled();
    expect(aa.startSpeakingDetection).not.toHaveBeenCalled();
  });

  it('one notice per app session: a second failure, even after a toggle tried again, says nothing more', async () => {
    const raw = fakeStream('raw');
    useVoiceStore.setState({ activeChannelId: 'ch-1', localStream: raw });
    aa.state.mode = 'server';
    failure('running', raw);
    await flush();
    useSettingsStore.getState().setEnableNoiseSuppression(false);
    useSettingsStore.getState().setEnableNoiseSuppression(true);
    await flush();
    failure('running', raw);
    await flush();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('while unavailable, every rebuild runs without RNNoise, and a new microphone asks for the browser\'s own suppression', async () => {
    const [a, b] = [fakeStream('a'), fakeStream('b')];
    const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => b);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', localStream: a });
    aa.state.mode = 'dm';
    failure('running', a);
    await flush();
    aa.setNoiseSuppression.mockClear();

    useSettingsStore.getState().setAudioInputDeviceId('mic-b');
    await flush();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ noiseSuppression: true }) });
    expect(aa.setNoiseSuppression).toHaveBeenCalledWith(false);
    expect(aa.setNoiseSuppression).not.toHaveBeenCalledWith(true);
  });

  it('a toggle of the setting tries RNNoise again (the session flag is cleared, the rebuild asks for it)', async () => {
    const raw = fakeStream('raw');
    useVoiceStore.setState({ activeChannelId: 'ch-1', localStream: raw });
    aa.state.mode = 'server';
    failure('running', raw);
    await flush();
    expect(useSettingsStore.getState().noiseSuppressionUnavailable).toBe(true);

    useSettingsStore.getState().setEnableNoiseSuppression(false);
    expect(useSettingsStore.getState().noiseSuppressionUnavailable).toBe(false);
    useSettingsStore.getState().setEnableNoiseSuppression(true);
    await flush();
    expect(aa.setNoiseSuppression).toHaveBeenLastCalledWith(true);
  });

  it('the raw microphone gets the browser\'s own suppression exactly when RNNoise does not run on it', async () => {
    const raw = fakeStream('raw');
    const track = raw.track as FakeTrack & { applyConstraints: ReturnType<typeof vi.fn>; getSettings: () => { noiseSuppression: boolean }; getConstraints: () => object };
    let ns = false;
    track.getSettings = () => ({ noiseSuppression: ns });
    track.getConstraints = () => ({ deviceId: { exact: 'mic-a' }, echoCancellation: true });
    track.applyConstraints = vi.fn(async (c: { noiseSuppression: boolean }) => { ns = c.noiseSuppression; });
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', localStream: raw });
    aa.state.mode = 'dm';

    failure('running', raw); // RNNoise gone: the browser's own is asked for
    await flush();
    expect(track.applyConstraints).toHaveBeenLastCalledWith({ deviceId: { exact: 'mic-a' }, echoCancellation: true, noiseSuppression: true });

    // RNNoise back (a toggle that works): the browser's is turned off again
    aa.applyNoiseSuppression.mockImplementation(async () => fakeStream('suppressed'));
    useSettingsStore.getState().setEnableNoiseSuppression(false);
    useSettingsStore.getState().setEnableNoiseSuppression(true);
    await flush();
    expect(track.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: false }));
    expect(ns).toBe(false);
  });

  it('a track that reports no such processing, or cannot take the value, is left alone', async () => {
    const [synthetic, fixed] = [fakeStream('synthetic'), fakeStream('fixed')];
    const noSetting = Object.assign(synthetic.track, { applyConstraints: vi.fn(async () => {}), getSettings: () => ({}) });
    const cannot = Object.assign(fixed.track, {
      applyConstraints: vi.fn(async () => {}),
      getSettings: () => ({ noiseSuppression: false }),
      getCapabilities: () => ({ noiseSuppression: [false] }),
    });
    aa.state.mode = 'dm';
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', localStream: synthetic });
    failure('running', synthetic);
    await flush();
    useVoiceStore.setState({ localStream: fixed });
    failure('running', fixed);
    await flush();
    expect(noSetting.applyConstraints).not.toHaveBeenCalled();
    expect(cannot.applyConstraints).not.toHaveBeenCalled();
  });

  it('a leave while a join builds its pipeline: the join stops its own mic and never goes out', async () => {
    const raw = fakeStream('raw');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => raw) } });
    const pipeline = deferred<MediaStream>();
    aa.applyNoiseSuppression.mockImplementationOnce(() => pipeline.promise);

    const join = useVoiceStore.getState().joinChannel('ch-1', 'srv-1', { secure: false });
    await flush();
    useVoiceStore.getState().leaveChannel();
    aa.startSpeakingDetection.mockClear();
    pipeline.resolve(raw);
    await join;

    expect(socket.emit).not.toHaveBeenCalledWith('voice:join', 'ch-1', expect.anything());
    expect(raw.track.stop).toHaveBeenCalled();
    expect(aa.startSpeakingDetection).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().activeChannelId).toBeNull();
  });

  it('a leave while a socket reconnect rebuilds the pipeline: the channel left is not re-joined', async () => {
    const raw = fakeStream('raw');
    useVoiceStore.setState({ activeChannelId: 'ch-1', activeVoiceServerId: 'srv-1', localStream: raw });
    const pipeline = deferred<MediaStream>();
    aa.applyNoiseSuppression.mockImplementationOnce(() => pipeline.promise);

    const done = reconnectHandler();
    await flush();
    useVoiceStore.getState().leaveChannel();
    socket.emit.mockClear();
    pipeline.resolve(raw);
    await done;

    expect(socket.emit).not.toHaveBeenCalledWith('voice:join', expect.anything(), expect.anything());
  });

  it('the toggle mid-call: of two quick toggles only the later one finishes the rebuild, whatever order their starts resolve in', async () => {
    const raw = fakeStream('raw');
    useVoiceStore.setState({ activeChannelId: 'ch-1', localStream: raw });
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    aa.applyNoiseSuppression.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    useSettingsStore.getState().setEnableNoiseSuppression(false);
    useSettingsStore.getState().setEnableNoiseSuppression(true);
    second.resolve(raw);
    await flush();
    first.resolve(raw);
    await flush();

    expect(aa.startSpeakingDetection).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

// ─── A rebuild while the mic producer is being made ──────────────────────────
// The rebuild swaps the track of the producers in msProducers; one still in
// produce() is not there yet, and the track it was made with is the one the
// rebuild ends (Chromium sends nothing from an ended track).

describe('a pipeline rebuild that lands while produce() is in flight', () => {
  /** Joined on `raw`, the transports made, produce() held open with `gatedBefore`'s track. */
  async function produceHeld(raw: FakeStream, gatedBefore: FakeStream) {
    const made = deferred<ReturnType<typeof fakeProducer> & { track: unknown }>();
    const sendTransport = { id: 'send', on: vi.fn(), produce: vi.fn(() => made.promise), close: vi.fn() };
    const recvTransport = { id: 'recv', on: vi.fn(), close: vi.fn() };
    vi.mocked(Device).mockImplementation(function fakeDevice() {
      return { load: vi.fn(async () => {}), rtpCapabilities: {}, canProduce: () => true, createSendTransport: () => sendTransport, createRecvTransport: () => recvTransport };
    } as never);
    useVoiceStore.setState({ activeChannelId: 'ch-1', localStream: raw });
    aa.state.gated = gatedBefore;
    aa.state.mode = 'server';
    // Each rebuild makes a new gated stream over what it was started on
    aa.startSpeakingDetection.mockImplementation((stream: MediaStream, mode: 'server' | 'dm' = 'server') => {
      aa.state.mode = mode;
      aa.state.gated = fakeStream(`gated-${stream.id}-${Math.random()}`);
    });
    const transport = { id: 'x', iceParameters: {}, iceCandidates: [], dtlsParameters: {} };
    const run = useVoiceStore.getState().handleTransportCreated({ routerRtpCapabilities: {}, sendTransport: { ...transport, id: 'send' }, recvTransport: { ...transport, id: 'recv' } } as never);
    await flush();
    expect(sendTransport.produce).toHaveBeenCalledWith(expect.objectContaining({ track: gatedBefore.track }));
    return async () => {
      const producer = { ...fakeProducer('audio'), track: gatedBefore.track };
      made.resolve(producer);
      await run;
      await flush();
      return producer;
    };
  }

  it('the noise-suppression toggle: the new producer is given the rebuilt track', async () => {
    const raw = fakeStream('raw');
    const settle = await produceHeld(raw, fakeStream('gated-old'));
    useSettingsStore.getState().setEnableNoiseSuppression(false);
    await flush();
    const producer = await settle();
    expect(producer.replaceTrack).toHaveBeenCalledWith({ track: aa.state.gated!.getAudioTracks()[0] });
    expect(useVoiceStore.getState().msProducers.get(producer.id)).toBe(producer);
  });

  it('a device switch: the new producer is given the new microphone\'s track', async () => {
    const [raw, b] = [fakeStream('raw'), fakeStream('b')];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => b) } });
    const settle = await produceHeld(raw, fakeStream('gated-old'));
    useSettingsStore.getState().setAudioInputDeviceId('mic-b');
    await flush();
    expect(useVoiceStore.getState().localStream).toBe(b);
    const producer = await settle();
    expect(producer.replaceTrack).toHaveBeenCalledWith({ track: aa.state.gated!.getAudioTracks()[0] });
  });

  it('the noise-suppression fallback: the new producer is given the raw pipeline\'s track', async () => {
    const raw = fakeStream('raw');
    const settle = await produceHeld(raw, fakeStream('gated-old'));
    failure('running', raw);
    await flush();
    const producer = await settle();
    expect(producer.replaceTrack).toHaveBeenCalledWith({ track: aa.state.gated!.getAudioTracks()[0] });
  });

  it('no rebuild meanwhile: the producer keeps its track, no swap', async () => {
    const raw = fakeStream('raw');
    const settle = await produceHeld(raw, fakeStream('gated-old'));
    const producer = await settle();
    expect(producer.replaceTrack).not.toHaveBeenCalled();
  });
});

describe('a socket reconnect re-opening the microphone', () => {
  const deadStream = () => {
    const s = fakeStream('dead');
    s.track.readyState = 'ended';
    return s;
  };

  it('the call ends while the mic opens: the new stream is stopped and nothing is re-joined', async () => {
    const opened = fakeStream('reopened');
    const mic = deferred<MediaStream>();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => mic.promise) } });
    useVoiceStore.setState({ activeChannelId: 'ch-1', activeVoiceServerId: 'srv-1', localStream: deadStream() });

    const done = reconnectHandler();
    await flush();
    useVoiceStore.getState().leaveChannel();
    socket.emit.mockClear();
    mic.resolve(opened);
    await done;

    expect(opened.track.stop).toHaveBeenCalled();
    expect(useVoiceStore.getState().localStream).toBeNull();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:join', expect.anything(), expect.anything());
  });

  it('a device switch installs a stream while the mic opens: that stream stays, the reconnect\'s own is stopped', async () => {
    const [reopened, switched] = [fakeStream('reopened'), fakeStream('switched')];
    const answers = [deferred<MediaStream>(), deferred<MediaStream>()];
    let call = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => answers[call++].promise) } });
    useVoiceStore.setState({ activeChannelId: 'ch-1', activeVoiceServerId: 'srv-1', localStream: deadStream() });

    const done = reconnectHandler();
    await flush();
    useSettingsStore.getState().setAudioInputDeviceId('mic-b');
    answers[1].resolve(switched);
    await flush();
    expect(useVoiceStore.getState().localStream).toBe(switched);
    answers[0].resolve(reopened);
    await done;

    expect(reopened.track.stop).toHaveBeenCalled();
    expect(useVoiceStore.getState().localStream).toBe(switched);
    expect(switched.track.stop).not.toHaveBeenCalled();
  });
});
