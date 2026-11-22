import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VOICE_SPEAK_REFUSED_MESSAGE } from '@voxium/shared';

/**
 * Who stops the microphone's tracks. The store runs here against the REAL
 * mediasoup-client (its Device, Transport and Producer, over the library's
 * own FakeHandler), because what is pinned is what that library does to a
 * track it was given: unless told not to, it stops the track of a produce
 * that is refused, of a producer that closes and of a track it replaces. The
 * pipeline owns those tracks and goes on using them, so the mic producer is
 * made with `stopTracks: false` and the pipeline stops them where it ends.
 */

vi.mock('mediasoup-client', () => ({ Device: vi.fn() }));

const socket = vi.hoisted(() => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn(() => socket),
  onSocketReconnect: vi.fn(),
}));

// The audio service, with the one rule of it this file relies on (pinned in
// audioAnalyser.test.ts): the pipeline's stop ends its gated track
const aa = vi.hoisted(() => {
  const state = { gated: null as MediaStream | null };
  return {
    state,
    startSpeakingDetection: vi.fn(),
    stopSpeakingDetection: vi.fn(() => {
      state.gated?.getTracks().forEach((track) => track.stop());
      state.gated = null;
    }),
    setNoiseGateThreshold: vi.fn(),
    getGatedStream: vi.fn(() => state.gated),
    setNoiseSuppression: vi.fn(),
    onSpeakingChange: vi.fn(),
    applyNoiseSuppression: vi.fn(async (stream: MediaStream) => stream),
    getSuppressedStream: vi.fn(() => null),
    stopNoiseSuppression: vi.fn(),
    setSpeakingDetectionPaused: vi.fn(),
    onNoiseSuppressionFailure: vi.fn(),
    getSpeakingDetectionMode: vi.fn(() => null),
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

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

vi.mock('../../stores/settingsStore', async () => {
  const { create } = await import('zustand');
  const store = create<Record<string, unknown>>(() => ({
    audioInputDeviceId: '',
    audioOutputDeviceId: '',
    noiseGateThreshold: 0.008,
    voiceMode: 'voice_activity',
    voiceQuality: 'medium',
    enableNoiseSuppression: false,
    noiseSuppressionUnavailable: false,
  }));
  return { useSettingsStore: store, VOICE_QUALITY_BITRATE: { low: 16000, medium: 32000, high: 64000 } };
});

import { useVoiceStore } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Device } from 'mediasoup-client';
import type { Transport, Producer } from 'mediasoup-client/types';
import { FakeHandler } from 'mediasoup-client/handlers/FakeHandler';
import * as fakeParameters from 'mediasoup-client/fakeParameters';

const { Device: RealDevice } = await vi.importActual<typeof import('mediasoup-client')>('mediasoup-client');

// ─── Fakes ───────────────────────────────────────────────────────────────────

type FakeTrack = MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };

/** An audio track as mediasoup-client handles one: it reads `kind`, `id`,
 *  `readyState` and `enabled`, and listens for `ended`. */
function fakeTrack(label: string): FakeTrack {
  const track = {
    id: label,
    kind: 'audio',
    label,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(() => { track.readyState = 'ended'; }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({}),
  };
  return track as unknown as FakeTrack;
}

function streamOf(track: FakeTrack): MediaStream {
  return { id: track.id, getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

/** The send transports the store made, in order, each with its produce() observed. */
let sendTransports: Transport[];

/** The `enabled` of the track each produce() was handed, when it was called. */
let enabledAtProduce: Array<boolean | undefined>;

/** What the server answers to `voice:produce`. */
let answerProduce: () => { producerId?: string; error?: string };

function serverAnswers() {
  let produced = 0;
  answerProduce = () => ({ producerId: `producer-${++produced}` });
  socket.emit.mockImplementation((event: string, _payload: unknown, ack?: (response: unknown) => void) => {
    if (event === 'voice:transport:connect') ack?.({});
    else if (event === 'voice:produce') ack?.(answerProduce());
  });
}

function transportCreated() {
  const send = fakeParameters.generateTransportRemoteParameters();
  const recv = fakeParameters.generateTransportRemoteParameters();
  return {
    routerRtpCapabilities: fakeParameters.generateRouterRtpCapabilities(),
    sendTransport: { id: send.id, iceParameters: send.iceParameters, iceCandidates: send.iceCandidates, dtlsParameters: send.dtlsParameters },
    recvTransport: { id: recv.id, iceParameters: recv.iceParameters, iceCandidates: recv.iceCandidates, dtlsParameters: recv.dtlsParameters },
  } as never;
}

function micProducers(): Producer[] {
  return [...useVoiceStore.getState().msProducers.values()].filter((p) => (p.appData as { type?: string }).type === 'audio');
}

/** In a channel on `raw`, the pipeline's gated output being `gated` (null: none). */
function inChannel(raw: FakeTrack, gated: FakeTrack | null) {
  useVoiceStore.setState({ activeChannelId: 'ch-1', activeVoiceServerId: 'srv-1', localStream: streamOf(raw) });
  aa.state.gated = gated ? streamOf(gated) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  useVoiceStore.setState({
    localUserId: 'me',
    activeChannelId: null,
    activeVoiceServerId: null,
    dmCallConversationId: null,
    localStream: null,
    selfMute: false,
    selfDeaf: false,
    msProducers: new Map(),
    msSendTransport: null,
    msRecvTransport: null,
    msDevice: null,
  });
  aa.state.gated = null;
  sendTransports = [];
  enabledAtProduce = [];
  vi.mocked(Device).mockImplementation(function realDeviceOverFakeHandler() {
    const device = new RealDevice({ handlerFactory: FakeHandler.createFactory(fakeParameters) });
    const createSendTransport = device.createSendTransport.bind(device);
    device.createSendTransport = (options) => {
      const transport = createSendTransport(options);
      const produce = transport.produce.bind(transport);
      vi.spyOn(transport, 'produce').mockImplementation((produceOptions) => {
        enabledAtProduce.push(produceOptions?.track?.enabled);
        return produce(produceOptions);
      });
      sendTransports.push(transport);
      return transport;
    };
    return device;
  } as never);
  serverAnswers();
});

afterEach(() => {
  useVoiceStore.getState().leaveChannel();
  useVoiceStore.getState().stopLatencyMeasurement();
});

describe('the microphone producer never stops the pipeline\'s track', () => {
  it('is made with stopTracks: false and the pause defaults left as they are', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(sendTransports[0].produce).toHaveBeenCalledTimes(1);
    const options = vi.mocked(sendTransports[0].produce).mock.calls[0][0]!;
    expect(options.stopTracks).toBe(false);
    // The noise gate, mute and push-to-talk pause by disabling the track
    expect('disableTrackOnPause' in options).toBe(false);
    expect('zeroRtpOnPause' in options).toBe(false);
  });

  it('a produce the server refuses (no SPEAK) leaves the gated track live for the listen-only call', async () => {
    const [raw, gated] = [fakeTrack('raw'), fakeTrack('gated')];
    inChannel(raw, gated);
    answerProduce = () => ({ error: VOICE_SPEAK_REFUSED_MESSAGE });

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(socket.emit).toHaveBeenCalledWith('voice:produce', expect.anything(), expect.any(Function));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(micProducers()).toHaveLength(0);
    expect(gated.stop).not.toHaveBeenCalled();
    expect(gated.readyState).toBe('live');
    expect(raw.stop).not.toHaveBeenCalled();
  });

  it('without a gated stream the producer carries the raw track: a refusal leaves it live, the leave stops it', async () => {
    const raw = fakeTrack('raw');
    inChannel(raw, null);
    answerProduce = () => ({ error: VOICE_SPEAK_REFUSED_MESSAGE });

    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    expect(vi.mocked(sendTransports[0].produce).mock.calls[0][0]!.track).toBe(raw);
    expect(raw.stop).not.toHaveBeenCalled();

    useVoiceStore.getState().leaveChannel();
    expect(raw.stop).toHaveBeenCalled();
  });

  it('without a gated stream, the producer leaves the raw track as push-to-talk left it: the key up, it is not enabled', async () => {
    const raw = fakeTrack('raw');
    inChannel(raw, null);
    useSettingsStore.setState({ voiceMode: 'push_to_talk' });
    // The key is up: the raw track's `enabled` is the push-to-talk mute
    raw.enabled = false;
    try {
      await useVoiceStore.getState().handleTransportCreated(transportCreated());

      expect(vi.mocked(sendTransports[0].produce).mock.calls[0][0]!.track).toBe(raw);
      expect(enabledAtProduce).toEqual([false]);
      expect(raw.enabled).toBe(false);
      // A producer starts paused on a disabled track: nothing goes out
      expect(micProducers()[0].paused).toBe(true);
    } finally {
      useSettingsStore.setState({ voiceMode: 'voice_activity' });
    }
  });

  it('without a gated stream, the producer leaves the raw track as the mute left it: not enabled, not even while produce() runs', async () => {
    const raw = fakeTrack('raw');
    inChannel(raw, null);
    useVoiceStore.setState({ selfMute: true });
    raw.enabled = false;

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(enabledAtProduce).toEqual([false]);
    expect(raw.enabled).toBe(false);
    expect(micProducers()[0].paused).toBe(true);
  });

  it('a plaintext transport restart makes the next producer from the same live track, not paused by the old one', async () => {
    const [raw, gated] = [fakeTrack('raw'), fakeTrack('gated')];
    inChannel(raw, gated);
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    const [first] = micProducers();
    expect(first.track).toBe(gated);
    // The noise gate paused it in a silence: the library disables its track
    first.pause();
    expect(gated.enabled).toBe(false);

    // The send transport's DTLS fails: the SFU side is closed and joined again
    const handler = (sendTransports[0] as unknown as { handler: { setConnectionState: (state: string) => void } }).handler;
    handler.setConnectionState('failed');
    expect(first.closed).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.anything());
    expect(gated.readyState).toBe('live');

    // The server's answer to that join: a new transport, and the microphone on it
    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(sendTransports[1].produce).toHaveBeenCalledTimes(1);
    const [second] = micProducers();
    expect(second).not.toBe(first);
    expect(second.track).toBe(gated);
    // Speech that started before this producer existed goes out: it does not
    // wait for the next silence-to-speech turn of the gate
    expect(second.paused).toBe(false);
    expect(gated.enabled).toBe(true);
    expect(gated.stop).not.toHaveBeenCalled();
  });

  it('muted at a transport restart: the next producer is paused by the mute', async () => {
    const [raw, gated] = [fakeTrack('raw'), fakeTrack('gated')];
    inChannel(raw, gated);
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    useVoiceStore.getState().toggleMute();
    expect(micProducers()[0].paused).toBe(true);

    (sendTransports[0] as unknown as { handler: { setConnectionState: (state: string) => void } }).handler.setConnectionState('failed');
    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    const [second] = micProducers();
    expect(second.paused).toBe(true);
    expect(gated.enabled).toBe(false);
    // The raw track's own mute is untouched by the hand-over
    expect(raw.enabled).toBe(false);
  });

  it('server-muted at a transport restart (the raw track stays enabled): the next producer is paused, its track disabled', async () => {
    const [raw, gated] = [fakeTrack('raw'), fakeTrack('gated')];
    inChannel(raw, gated);
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    // A moderator's mute pauses the producer and sets the mute flag; it does
    // not disable the raw track (the server also pauses the producer it
    // makes for a muted member)
    useVoiceStore.getState().updateUserState('ch-1', 'me', false, false, true, false);
    expect(micProducers()[0].paused).toBe(true);
    expect(raw.enabled).toBe(true);

    (sendTransports[0] as unknown as { handler: { setConnectionState: (state: string) => void } }).handler.setConnectionState('failed');
    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    const [second] = micProducers();
    expect(second.paused).toBe(true);
    expect(gated.enabled).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.objectContaining({ selfMute: true }));
  });

  it('leaving stops every track of the call where its pipeline ends', async () => {
    const [raw, gated] = [fakeTrack('raw'), fakeTrack('gated')];
    inChannel(raw, gated);
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    expect(micProducers()).toHaveLength(1);

    useVoiceStore.getState().leaveChannel();

    expect(gated.stop).toHaveBeenCalledTimes(1);
    expect(raw.stop).toHaveBeenCalled();
    expect(aa.stopSpeakingDetection).toHaveBeenCalled();
  });
});
