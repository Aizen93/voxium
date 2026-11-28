import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

/**
 * The page side of the audio-thread noise gate (audioAnalyser.ts): its module
 * loads after the pipeline is built, under the pipeline's generation; it then
 * takes the gain node's place in front of the same gated destination, and
 * its "speaking" messages do what the page timer's tick does. Where it cannot
 * load or fails, the page timer decides, as before.
 */

const socket = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('../../services/socket', () => ({ getSocket: vi.fn(() => socket) }));
vi.mock('@timephy/rnnoise-wasm', () => ({ NoiseSuppressorWorklet_Name: 'NoiseSuppressorWorklet' }));
vi.mock('@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url', () => ({ default: 'rnnoise-worklet-url.js' }));
vi.mock('../../services/noiseGateWorklet?worker&url', () => ({ default: 'gate-worklet-url.js' }));

// ─── Web Audio fakes ────────────────────────────────────────────────────────

/** What the analyser reads: one level for every sample. */
let analyserLevel = 0;

class FakeParam {
  value = 0;
  cancelScheduledValues = vi.fn();
  linearRampToValueAtTime = vi.fn((value: number) => { this.value = value; });
  setTargetAtTime = vi.fn((value: number) => { this.value = value; });
}

function fakeNode() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeContext {
  static all: FakeContext[] = [];
  /** Runs once on the next context made (then cleared). */
  static nextSetup: ((ctx: FakeContext) => void) | null = null;
  state = 'running';
  sampleRate = 48_000;
  currentTime = 0;
  loads: Array<{ url: string } & ReturnType<typeof deferred>> = [];
  audioWorklet: { addModule: (url: string) => Promise<void> } | undefined = {
    addModule: (url: string) => {
      const load = { url, ...deferred() };
      this.loads.push(load);
      return load.promise;
    },
  };
  analyser = {
    ...fakeNode(),
    fftSize: 2048,
    getFloatTimeDomainData: vi.fn((data: Float32Array) => { data.fill(analyserLevel); }),
  };
  gain = { ...fakeNode(), gain: new FakeParam() };
  source = fakeNode();
  destination = (() => {
    const track = { kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn() };
    return { ...fakeNode(), stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream };
  })();
  createAnalyser = () => this.analyser;
  createGain = () => this.gain;
  createMediaStreamSource = () => this.source;
  createMediaStreamDestination = () => this.destination;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
  constructor() {
    FakeContext.all.push(this);
    const setup = FakeContext.nextSetup;
    FakeContext.nextSetup = null;
    setup?.(this);
  }
  /** The gate's module load, settled by the test. */
  get load() {
    expect(this.loads).toHaveLength(1);
    return this.loads[0];
  }
}
vi.stubGlobal('AudioContext', FakeContext);

class FakeWorkletNode {
  static all: FakeWorkletNode[] = [];
  static throwNext: Error | null = null;
  port = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  onprocessorerror: ((event: Event) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(readonly context: FakeContext, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    if (FakeWorkletNode.throwNext) {
      const err = FakeWorkletNode.throwNext;
      FakeWorkletNode.throwNext = null;
      throw err;
    }
    FakeWorkletNode.all.push(this);
  }
  /** The processor posts a change of its decision. */
  report(speaking: boolean) {
    this.port.onmessage?.({ data: { type: 'speaking', speaking } } as MessageEvent);
  }
  /** The processor threw: the browser fires `processorerror` at the node. */
  fail() {
    this.onprocessorerror?.(new Event('processorerror'));
  }
}
vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);

import {
  startSpeakingDetection,
  stopSpeakingDetection,
  onSpeakingChange,
  resendSpeaking,
  setNoiseGateThreshold,
  setSpeakingDetectionPaused,
  getSpeakingDetectionMode,
  getSpeakingDecider,
  getGatedStream,
  getAudioLevel,
} from '../../services/audioAnalyser';
import { DEFAULT_NOISE_GATE_THRESHOLD } from '../../services/audioDefaults';

const mic = () => ({ id: 'mic', getAudioTracks: () => [] }) as unknown as MediaStream;
const lastContext = () => FakeContext.all.at(-1)!;
const lastNode = () => FakeWorkletNode.all.at(-1)!;
const sent = () => socket.emit.mock.calls;

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A pipeline whose audio-thread gate has loaded and taken over. */
async function attached(mode: 'server' | 'dm' = 'server') {
  startSpeakingDetection(mic(), mode);
  const ctx = lastContext();
  ctx.load.resolve();
  await settle();
  return { ctx, node: lastNode() };
}

let warn: MockInstance<typeof console.warn>;
const gateWarnings = () => warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('audio-thread noise gate'));

beforeEach(() => {
  vi.useFakeTimers();
  stopSpeakingDetection();
  onSpeakingChange(null);
  setNoiseGateThreshold(DEFAULT_NOISE_GATE_THRESHOLD);
  FakeContext.all = [];
  FakeContext.nextSetup = null;
  FakeWorkletNode.all = [];
  FakeWorkletNode.throwNext = null;
  analyserLevel = 0;
  socket.emit.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stopSpeakingDetection();
  onSpeakingChange(null);
  warn.mockRestore();
  vi.useRealTimers();
});

describe('the audio-thread noise gate, from the page', () => {
  it('is loaded on the pipeline\'s own context from the file the build emits, and takes the gain node\'s place', async () => {
    const { ctx, node } = await attached();
    expect(ctx.load.url).toBe('gate-worklet-url.js');
    expect(node.context).toBe(ctx);
    expect(node.name).toBe('voxium-noise-gate');
    expect(node.options).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { threshold: DEFAULT_NOISE_GATE_THRESHOLD, paused: false, open: false, pauseClosesGate: true },
    });
    expect(ctx.analyser.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.analyser.disconnect).toHaveBeenCalledWith(ctx.gain);
    expect(gateWarnings()).toEqual([]);
  });

  it('the gated track is the same object before and after the gate attaches; a space call\'s slot starts closed, a direct call\'s open', async () => {
    for (const mode of ['server', 'dm'] as const) {
      startSpeakingDetection(mic(), mode);
      const ctx = lastContext();
      const before = getGatedStream()!.getAudioTracks()[0];
      expect(ctx.gain.gain.value).toBe(mode === 'dm' ? 1 : 0);
      ctx.load.resolve();
      await settle();
      expect(getGatedStream()!.getAudioTracks()[0]).toBe(before);
      expect(lastNode().connect).toHaveBeenCalledWith(ctx.destination);
      stopSpeakingDetection();
    }
  });

  describe('while its module loads (here: a load that never settles), the page timer decides', () => {
    it('a direct call keeps its gain open and reports speaking by the timer', () => {
      startSpeakingDetection(mic(), 'dm');
      const ctx = lastContext();
      expect(ctx.loads).toHaveLength(1);
      expect(ctx.gain.gain.value).toBe(1);

      analyserLevel = 0.5;
      vi.advanceTimersByTime(20);
      expect(sent()).toEqual([['dm:voice:speaking', true]]);
      analyserLevel = 0;
      vi.advanceTimersByTime(2_000);
      expect(sent()).toEqual([['dm:voice:speaking', true], ['dm:voice:speaking', false]]);
      // Heard throughout: the timer never moved the gain
      expect(ctx.gain.gain.value).toBe(1);
      expect(ctx.gain.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
      expect(getSpeakingDetectionMode()).toBe('dm');
      expect(FakeWorkletNode.all).toEqual([]);
      expect(gateWarnings()).toEqual([]);
    });

    it('a space call stays gated by the timer', () => {
      startSpeakingDetection(mic(), 'server');
      const ctx = lastContext();
      expect(ctx.loads).toHaveLength(1);
      expect(ctx.gain.gain.value).toBe(0);

      vi.advanceTimersByTime(200); // silence: still closed
      expect(ctx.gain.gain.value).toBe(0);
      analyserLevel = 0.5;
      vi.advanceTimersByTime(20);
      expect(sent()).toEqual([['voice:speaking', true]]);
      expect(ctx.gain.gain.value).toBe(1);
      analyserLevel = 0;
      vi.advanceTimersByTime(2_000);
      expect(sent()).toEqual([['voice:speaking', true], ['voice:speaking', false]]);
      expect(ctx.gain.gain.value).toBe(0);
      expect(FakeWorkletNode.all).toEqual([]);
      expect(gateWarnings()).toEqual([]);
    });
  });

  describe('a "speaking" message does what the tick did', () => {
    it('in a space call: the emit, the callback, the resend', async () => {
      const cb = vi.fn();
      onSpeakingChange(cb);
      const { node } = await attached('server');

      node.report(true);
      expect(sent()).toEqual([['voice:speaking', true]]);
      expect(cb).toHaveBeenCalledWith(true);
      resendSpeaking();
      expect(sent()).toEqual([['voice:speaking', true], ['voice:speaking', true]]);

      node.report(true); // no change: nothing
      expect(sent()).toHaveLength(2);
      node.report(false);
      expect(sent().at(-1)).toEqual(['voice:speaking', false]);
      expect(cb).toHaveBeenLastCalledWith(false);
      resendSpeaking();
      expect(sent()).toHaveLength(3);
    });

    it('in a direct call, on the direct call\'s event', async () => {
      const { node } = await attached('dm');
      node.report(true);
      resendSpeaking();
      expect(sent()).toEqual([['dm:voice:speaking', true], ['dm:voice:speaking', true]]);
    });

    it('a malformed message changes nothing', async () => {
      const { node } = await attached();
      node.port.onmessage!({ data: { type: 'speaking', speaking: 'yes' } } as MessageEvent);
      node.port.onmessage!({ data: null } as MessageEvent);
      expect(sent()).toEqual([]);
    });
  });

  it('the timer decides while the module loads, and hands over what it heard: one source of "speaking" at a time', async () => {
    startSpeakingDetection(mic(), 'server');
    const ctx = lastContext();
    analyserLevel = 0.5;
    vi.advanceTimersByTime(20);
    expect(sent()).toEqual([['voice:speaking', true]]);

    ctx.load.resolve();
    await settle();
    const node = lastNode();
    // The processor starts open: the hand-over itself tells nobody anything
    expect(node.options.processorOptions).toEqual(expect.objectContaining({ open: true }));
    expect(sent()).toHaveLength(1);

    // The timer no longer decides: a long silence it would have closed on says nothing
    analyserLevel = 0;
    vi.advanceTimersByTime(2_000);
    expect(sent()).toHaveLength(1);
    node.report(false);
    expect(sent()).toEqual([['voice:speaking', true], ['voice:speaking', false]]);
  });

  describe('the threshold and the pause reach the processor', () => {
    it('as messages once it runs', async () => {
      const { node } = await attached();
      setNoiseGateThreshold(0.02);
      setSpeakingDetectionPaused(true);
      setSpeakingDetectionPaused(false);
      expect(node.port.postMessage.mock.calls).toEqual([
        [{ type: 'threshold', value: 0.02 }],
        [{ type: 'paused', value: true }],
        [{ type: 'paused', value: false }],
      ]);
    });

    it('as its start state when they were set while it loaded', async () => {
      for (const mode of ['server', 'dm'] as const) {
        startSpeakingDetection(mic(), mode);
        setNoiseGateThreshold(0.03);
        setSpeakingDetectionPaused(true);
        lastContext().load.resolve();
        await settle();
        expect(lastNode().options.processorOptions).toEqual({ threshold: 0.03, paused: true, open: false, pauseClosesGate: mode === 'server' });
        stopSpeakingDetection();
      }
    });

    it('a "speaking" report sent before the processor got the pause changes nothing', async () => {
      const { node } = await attached();
      node.report(true);
      setSpeakingDetectionPaused(true);
      expect(sent().at(-1)).toEqual(['voice:speaking', false]);
      node.report(true); // posted before the pause reached it
      expect(sent()).toHaveLength(2);
      setSpeakingDetectionPaused(false);
      node.report(true);
      expect(sent().at(-1)).toEqual(['voice:speaking', true]);
    });
  });

  describe('where it cannot run, the page timer decides, with one warning, and the call goes on', () => {
    it('its module does not load: a space call is gated by the timer', async () => {
      startSpeakingDetection(mic(), 'server');
      const ctx = lastContext();
      ctx.load.reject(new Error('refused by the content policy'));
      await settle();

      expect(gateWarnings()).toHaveLength(1);
      expect(String(gateWarnings()[0][0])).toContain('refused by the content policy');
      expect(warn.mock.calls[0]).toHaveLength(1); // by message, never the object
      expect(FakeWorkletNode.all).toEqual([]);
      expect(getSpeakingDetectionMode()).toBe('server');
      expect(ctx.gain.gain.value).toBe(0);

      analyserLevel = 0.5;
      vi.advanceTimersByTime(20);
      expect(sent()).toEqual([['voice:speaking', true]]);
      expect(ctx.gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, expect.any(Number));
      expect(ctx.gain.gain.value).toBe(1);
      analyserLevel = 0;
      vi.advanceTimersByTime(400);
      expect(sent().at(-1)).toEqual(['voice:speaking', false]);
      expect(ctx.gain.gain.value).toBe(0);
    });

    it('its module does not load: a direct call keeps its gain open, the timer only detects', async () => {
      startSpeakingDetection(mic(), 'dm');
      const ctx = lastContext();
      ctx.load.reject(new Error('network'));
      await settle();

      expect(gateWarnings()).toHaveLength(1);
      expect(ctx.gain.gain.value).toBe(1);
      analyserLevel = 0.5;
      vi.advanceTimersByTime(20);
      expect(sent()).toEqual([['dm:voice:speaking', true]]);
      expect(ctx.gain.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
      analyserLevel = 0;
      vi.advanceTimersByTime(400);
      expect(sent().at(-1)).toEqual(['dm:voice:speaking', false]);
      expect(ctx.gain.gain.value).toBe(1);
    });

    it('no AudioWorklet in this browser', async () => {
      FakeContext.nextSetup = (ctx) => { ctx.audioWorklet = undefined; };
      startSpeakingDetection(mic(), 'dm');
      await settle();
      expect(gateWarnings()).toHaveLength(1);
      expect(String(gateWarnings()[0][0])).toContain('no AudioWorklet');
      expect(lastContext().gain.gain.value).toBe(1);
    });

    it('the node cannot be made', async () => {
      FakeWorkletNode.throwNext = new Error('InvalidStateError: no such processor');
      startSpeakingDetection(mic(), 'server');
      lastContext().load.resolve();
      await settle();
      expect(gateWarnings()).toHaveLength(1);
      expect(getSpeakingDetectionMode()).toBe('server');
      analyserLevel = 0.5;
      vi.advanceTimersByTime(20);
      expect(sent()).toEqual([['voice:speaking', true]]);
    });

    it('its processor fails later: back on the gain node, from the state the page holds', async () => {
      const { ctx, node } = await attached('server');
      node.report(true);
      node.fail();

      expect(gateWarnings()).toHaveLength(1);
      expect(String(gateWarnings()[0][0])).toContain('processorerror');
      expect(node.port.onmessage).toBeNull();
      expect(node.disconnect).toHaveBeenCalled();
      expect(ctx.analyser.connect).toHaveBeenLastCalledWith(ctx.gain);
      expect(ctx.gain.gain.value).toBe(1); // it was speaking
      expect(getSpeakingDetectionMode()).toBe('server');

      // The timer decides from here
      analyserLevel = 0;
      vi.advanceTimersByTime(400);
      expect(sent()).toEqual([['voice:speaking', true], ['voice:speaking', false]]);
      expect(ctx.gain.gain.value).toBe(0);

      node.fail();
      expect(gateWarnings()).toHaveLength(1);
    });

    it('its processor fails later in a direct call: the gain opens for good', async () => {
      const { ctx, node } = await attached('dm');
      node.fail();
      expect(ctx.gain.gain.value).toBe(1);
      analyserLevel = 0.5;
      vi.advanceTimersByTime(20);
      expect(sent()).toEqual([['dm:voice:speaking', true]]);
    });
  });

  describe('a module load that lands after a rebuild or a stop touches nothing', () => {
    it('after a stop, loaded or refused', async () => {
      startSpeakingDetection(mic(), 'server');
      const first = lastContext();
      stopSpeakingDetection();
      first.load.resolve();
      await settle();

      startSpeakingDetection(mic(), 'server');
      const second = lastContext();
      stopSpeakingDetection();
      second.load.reject(new Error('the context was closed'));
      await settle();

      expect(FakeWorkletNode.all).toEqual([]);
      expect(gateWarnings()).toEqual([]);
      expect(getSpeakingDetectionMode()).toBeNull();
    });

    it('after a rebuild: only the latest pipeline gets its gate', async () => {
      startSpeakingDetection(mic(), 'server');
      const older = lastContext();
      startSpeakingDetection(mic(), 'server');
      const newer = lastContext();

      older.load.resolve();
      await settle();
      expect(FakeWorkletNode.all).toEqual([]);
      expect(newer.analyser.disconnect).not.toHaveBeenCalled();

      newer.load.resolve();
      await settle();
      expect(FakeWorkletNode.all).toHaveLength(1);
      expect(lastNode().context).toBe(newer);
    });
  });

  it('a rebuild stops the old processor: its late messages and errors touch nothing', async () => {
    const { node: old } = await attached('server');
    const lateMessage = old.port.onmessage!;
    const lateError = old.onprocessorerror!;

    startSpeakingDetection(mic(), 'server');
    expect(old.port.postMessage).toHaveBeenLastCalledWith({ type: 'stop' });
    expect(old.port.onmessage).toBeNull();
    expect(old.onprocessorerror).toBeNull();
    expect(old.disconnect).toHaveBeenCalled();

    lateMessage({ data: { type: 'speaking', speaking: true } } as MessageEvent);
    lateError(new Event('processorerror'));
    expect(sent()).toEqual([]);
    expect(gateWarnings()).toEqual([]);

    lastContext().load.resolve();
    await settle();
    lastNode().report(true);
    expect(sent()).toEqual([['voice:speaking', true]]);
  });

  it('a stop while it hears speech says "not speaking" once', async () => {
    const cb = vi.fn();
    onSpeakingChange(cb);
    const { node } = await attached('server');
    node.report(true);
    stopSpeakingDetection();
    stopSpeakingDetection();
    expect(sent()).toEqual([['voice:speaking', true], ['voice:speaking', false]]);
    expect(cb.mock.calls).toEqual([[true], [false]]);
  });

  it('getSpeakingDetectionMode() answers the kind of call under either decider, and null when stopped', async () => {
    expect(getSpeakingDetectionMode()).toBeNull();
    startSpeakingDetection(mic(), 'server');
    expect(getSpeakingDetectionMode()).toBe('server'); // the timer, while the module loads
    lastContext().load.resolve();
    await settle();
    expect(FakeWorkletNode.all).toHaveLength(1);
    expect(getSpeakingDetectionMode()).toBe('server'); // the audio-thread gate
    stopSpeakingDetection();
    expect(getSpeakingDetectionMode()).toBeNull();

    startSpeakingDetection(mic(), 'dm');
    lastContext().load.reject(new Error('blocked'));
    await settle();
    expect(getSpeakingDetectionMode()).toBe('dm'); // the timer, as the fallback
    stopSpeakingDetection();
    expect(getSpeakingDetectionMode()).toBeNull();
  });

  it('getSpeakingDecider() names what decides, and the DEV hook of the end-to-end run answers the same', async () => {
    const hook = () => (globalThis as { __voxSpeakingDecider?: () => string | null }).__voxSpeakingDecider?.();
    expect(getSpeakingDecider()).toBeNull();
    startSpeakingDetection(mic(), 'server');
    expect(getSpeakingDecider()).toBe('page-timer'); // while the module loads
    expect(hook()).toBe('page-timer');
    lastContext().load.resolve();
    await settle();
    expect(getSpeakingDecider()).toBe('audio-thread');
    expect(hook()).toBe('audio-thread');
    lastNode().fail();
    expect(getSpeakingDecider()).toBe('page-timer'); // the fallback
    stopSpeakingDetection();
    expect(getSpeakingDecider()).toBeNull();
    expect(hook()).toBeNull();

    startSpeakingDetection(mic(), 'dm');
    lastContext().load.reject(new Error('blocked'));
    await settle();
    expect(getSpeakingDecider()).toBe('page-timer');
  });

  it('the level meter is read from the analyser when asked while the gate decides, and kept while paused', async () => {
    await attached();
    analyserLevel = 0.075;
    expect(getAudioLevel()).toBeCloseTo(0.5, 6);
    setSpeakingDetectionPaused(true);
    analyserLevel = 0;
    expect(getAudioLevel()).toBeCloseTo(0.5, 6);
    setSpeakingDetectionPaused(false);
    expect(getAudioLevel()).toBe(0);
    stopSpeakingDetection();
    analyserLevel = 0.15;
    expect(getAudioLevel()).toBe(0);
  });
});
