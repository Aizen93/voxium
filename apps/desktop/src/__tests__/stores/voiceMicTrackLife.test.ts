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

// The real compositor module, its teardown observed: a share's end must stop it
vi.mock('../../services/screenComposite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/screenComposite')>();
  return { ...actual, teardownComposite: vi.fn(actual.teardownComposite) };
});
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn(() => socket),
  onSocketReconnect: vi.fn(),
}));

// The audio service, with the rules of it this file relies on (pinned in
// audioAnalyser.test.ts): the pipeline's stops end its gated and suppressed
// tracks, and a resend of the speaking state sends "speaking" only while the
// detector hears it
const aa = vi.hoisted(() => {
  const state = { gated: null as MediaStream | null, suppressed: null as MediaStream | null, speaking: false };
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
    getSuppressedStream: vi.fn(() => state.suppressed),
    stopNoiseSuppression: vi.fn(() => {
      state.suppressed?.getTracks().forEach((track) => track.stop());
      state.suppressed = null;
    }),
    setSpeakingDetectionPaused: vi.fn(),
    onNoiseSuppressionFailure: vi.fn(),
    getSpeakingDetectionMode: vi.fn(() => null),
    resendSpeaking: vi.fn(() => {
      if (state.speaking) socket.emit('voice:speaking', true);
    }),
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
import { teardownComposite } from '../../services/screenComposite';
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

/** Runs once a produce() has made its producer, before the store goes on. */
let afterProduce: (() => void) | null;

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
  aa.state.suppressed = null;
  aa.state.speaking = false;
  sendTransports = [];
  enabledAtProduce = [];
  afterProduce = null;
  vi.mocked(Device).mockImplementation(function realDeviceOverFakeHandler() {
    const device = new RealDevice({ handlerFactory: FakeHandler.createFactory(fakeParameters) });
    const createSendTransport = device.createSendTransport.bind(device);
    device.createSendTransport = (options) => {
      const transport = createSendTransport(options);
      const produce = transport.produce.bind(transport);
      vi.spyOn(transport, 'produce').mockImplementation((produceOptions) => {
        enabledAtProduce.push(produceOptions?.track?.enabled);
        return produce(produceOptions).then((producer) => {
          afterProduce?.();
          return producer;
        });
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

describe('a channel gone on the server (its space was deleted while in its voice channel)', () => {
  it('ends the call through the one teardown of the store: every track of the pipeline stops, and no voice:leave goes out', async () => {
    const [raw, suppressed, gated] = [fakeTrack('raw'), fakeTrack('suppressed'), fakeTrack('gated')];
    inChannel(raw, gated);
    aa.state.suppressed = streamOf(suppressed);
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    const [producer] = micProducers();
    // Share state a pending or frozen share left behind, off its defaults
    useVoiceStore.setState({ pttActive: true, screenShareFrozen: true, screenShareSourceKey: 'window:1280x720', shareKind: 'whiteboard' });
    socket.emit.mockClear();
    aa.onSpeakingChange.mockClear();

    useVoiceStore.getState().handleVoiceChannelGone();

    // The pipeline ends where the call does: noise suppression (its audio
    // context and suppressed track) and the speaking detector (its gated track)
    expect(aa.stopNoiseSuppression).toHaveBeenCalled();
    expect(suppressed.stop).toHaveBeenCalled();
    expect(aa.stopSpeakingDetection).toHaveBeenCalled();
    expect(gated.stop).toHaveBeenCalled();
    expect(aa.onSpeakingChange).toHaveBeenCalledWith(null);
    expect(raw.stop).toHaveBeenCalled();
    expect(producer.closed).toBe(true);
    // The server already removed the session and its room
    expect(socket.emit).not.toHaveBeenCalledWith('voice:leave');
    const state = useVoiceStore.getState();
    expect(state.activeChannelId).toBeNull();
    expect(state.activeVoiceServerId).toBeNull();
    expect(state.localStream).toBeNull();
    expect(state.pttActive).toBe(false);
    expect(state.msSendTransport).toBeNull();
    expect(state.msProducers.size).toBe(0);
    expect(state.screenShareFrozen).toBe(false);
    expect(state.screenShareSourceKey).toBeNull();
    expect(state.shareKind).toBe('screen');
  });

  it('a live screen share ends with the call: its capture tracks stop and the mask compositor is torn down', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    const [capture, captureAudio] = [fakeTrack('capture'), fakeTrack('capture-audio')];
    useVoiceStore.setState({
      isScreenSharing: true,
      screenSharingUserId: 'me',
      screenStream: { getTracks: () => [capture, captureAudio] } as unknown as MediaStream,
    });
    vi.mocked(teardownComposite).mockClear();

    useVoiceStore.getState().handleVoiceChannelGone();

    expect(capture.stop).toHaveBeenCalled();
    expect(captureAudio.stop).toHaveBeenCalled();
    expect(teardownComposite).toHaveBeenCalled();
    const state = useVoiceStore.getState();
    expect(state.screenStream).toBeNull();
    expect(state.isScreenSharing).toBe(false);
    expect(state.screenSharingUserId).toBeNull();
  });

  it('a leave (the same teardown) still says voice:leave', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    socket.emit.mockClear();

    useVoiceStore.getState().leaveChannel();

    expect(socket.emit).toHaveBeenCalledWith('voice:leave');
  });
});

describe('the speaking state once the microphone producer is made', () => {
  /** The speaking states this client sent. */
  function speakingSent(): unknown[] {
    return socket.emit.mock.calls.filter((call) => call[0] === 'voice:speaking').map((call) => call[1]);
  }

  /** The send transport, once connected (which resets the store's count of
   *  restarts in a row), fails its DTLS: the SFU side is closed and joined again. */
  function restartTransport(index: number) {
    const { handler } = sendTransports[index] as unknown as { handler: { setConnectionState: (state: string) => void } };
    handler.setConnectionState('connected');
    handler.setConnectionState('failed');
  }

  it('someone talking as the producer is made: their speaking state goes out once', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    aa.state.speaking = true;

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(micProducers()).toHaveLength(1);
    expect(speakingSent()).toEqual([true]);
  });

  it('silent as the producer is made: nothing is sent', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(aa.resendSpeaking).toHaveBeenCalledTimes(1);
    expect(speakingSent()).toEqual([]);
  });

  it('self-muted: nothing is sent, whatever the detector heard', async () => {
    const raw = fakeTrack('raw');
    inChannel(raw, fakeTrack('gated'));
    useVoiceStore.setState({ selfMute: true });
    raw.enabled = false;
    aa.state.speaking = true;

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(micProducers()).toHaveLength(1);
    expect(aa.resendSpeaking).not.toHaveBeenCalled();
    expect(speakingSent()).toEqual([]);
  });

  it('push-to-talk with the key up: nothing is sent; with the key held: the state goes out', async () => {
    useSettingsStore.setState({ voiceMode: 'push_to_talk' });
    try {
      const raw = fakeTrack('raw');
      inChannel(raw, fakeTrack('gated'));
      raw.enabled = false;
      aa.state.speaking = true;

      await useVoiceStore.getState().handleTransportCreated(transportCreated());
      expect(aa.resendSpeaking).not.toHaveBeenCalled();
      expect(speakingSent()).toEqual([]);

      // Held at the next producer (a transport restart)
      useVoiceStore.setState({ pttActive: true });
      raw.enabled = true;
      restartTransport(0);
      await useVoiceStore.getState().handleTransportCreated(transportCreated());
      expect(speakingSent()).toEqual([true]);
    } finally {
      useSettingsStore.setState({ voiceMode: 'voice_activity' });
    }
  });

  /** The `selfMute` of the voice:join a transport restart sent. */
  function restartJoinSelfMute(): unknown {
    const joins = socket.emit.mock.calls.filter((call) => call[0] === 'voice:join');
    return (joins[joins.length - 1][2] as { selfMute: boolean }).selfMute;
  }

  it('push-to-talk with the key held at a transport restart: the join states the microphone open', async () => {
    useSettingsStore.setState({ voiceMode: 'push_to_talk' });
    try {
      inChannel(fakeTrack('raw'), fakeTrack('gated'));
      await useVoiceStore.getState().handleTransportCreated(transportCreated());
      useVoiceStore.setState({ pttActive: true });
      restartTransport(0);
      expect(restartJoinSelfMute()).toBe(false);
    } finally {
      useSettingsStore.setState({ voiceMode: 'voice_activity' });
    }
  });

  it('push-to-talk with the key up at a transport restart: the join states the microphone muted', async () => {
    useSettingsStore.setState({ voiceMode: 'push_to_talk' });
    try {
      inChannel(fakeTrack('raw'), fakeTrack('gated'));
      await useVoiceStore.getState().handleTransportCreated(transportCreated());
      restartTransport(0);
      expect(restartJoinSelfMute()).toBe(true);
    } finally {
      useSettingsStore.setState({ voiceMode: 'voice_activity' });
    }
  });

  it('push-to-talk held under the mute flag at a transport restart: the join states it muted', async () => {
    useSettingsStore.setState({ voiceMode: 'push_to_talk' });
    try {
      inChannel(fakeTrack('raw'), fakeTrack('gated'));
      await useVoiceStore.getState().handleTransportCreated(transportCreated());
      // The new producer starts paused under the mute flag, whatever the key does
      useVoiceStore.setState({ pttActive: true, selfMute: true });
      restartTransport(0);
      expect(restartJoinSelfMute()).toBe(true);
    } finally {
      useSettingsStore.setState({ voiceMode: 'voice_activity' });
    }
  });

  it('outside push-to-talk a transport restart joins with the manual mute flag', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    useVoiceStore.setState({ selfMute: true, pttActive: true });
    restartTransport(0);
    expect(restartJoinSelfMute()).toBe(true);
  });

  it('push-to-talk held while self-muted: nothing is sent', async () => {
    useSettingsStore.setState({ voiceMode: 'push_to_talk' });
    try {
      inChannel(fakeTrack('raw'), fakeTrack('gated'));
      useVoiceStore.setState({ selfMute: true, pttActive: true });
      aa.state.speaking = true;

      await useVoiceStore.getState().handleTransportCreated(transportCreated());

      expect(micProducers()).toHaveLength(1);
      expect(speakingSent()).toEqual([]);
    } finally {
      useSettingsStore.setState({ voiceMode: 'voice_activity' });
    }
  });

  it('a produce the server refuses (no SPEAK) sends nothing', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    aa.state.speaking = true;
    answerProduce = () => ({ error: VOICE_SPEAK_REFUSED_MESSAGE });

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(micProducers()).toHaveLength(0);
    expect(aa.resendSpeaking).not.toHaveBeenCalled();
    expect(speakingSent()).toEqual([]);
  });

  it('a plaintext transport restart while talking: the new producer sends the state once more', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    aa.state.speaking = true;
    await useVoiceStore.getState().handleTransportCreated(transportCreated());
    expect(speakingSent()).toEqual([true]);

    // The detector runs on across the restart, still hearing speech: no change to send
    restartTransport(0);
    expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.anything());
    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(micProducers()).toHaveLength(1);
    expect(speakingSent()).toEqual([true, true]);
  });

  it('a producer closed before it was handed over (its transport failed) sends nothing', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    aa.state.speaking = true;
    // The send transport fails right as the producer is made: the SFU side
    // is closed (the producer with its transport) and joined again, in the
    // same voice session
    afterProduce = () => restartTransport(0);

    await useVoiceStore.getState().handleTransportCreated(transportCreated());

    expect(socket.emit).toHaveBeenCalledWith('voice:join', 'ch-1', expect.anything());
    expect(aa.resendSpeaking).not.toHaveBeenCalled();
    expect(speakingSent()).toEqual([]);
  });

  it('a producer whose voice session moved on while produce() ran sends nothing', async () => {
    inChannel(fakeTrack('raw'), fakeTrack('gated'));
    aa.state.speaking = true;
    let answer!: () => void;
    socket.emit.mockImplementation((event: string, _payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'voice:transport:connect') ack?.({});
      else if (event === 'voice:produce') answer = () => ack?.({ producerId: 'producer-late' });
    });

    const created = useVoiceStore.getState().handleTransportCreated(transportCreated());
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    // Another session begins meanwhile (here a DM call's end moves the
    // generation without closing this transport)
    useVoiceStore.getState().handleDMCallEnded();
    answer();
    await created;

    expect(aa.resendSpeaking).not.toHaveBeenCalled();
    expect(speakingSent()).toEqual([]);
  });
});
