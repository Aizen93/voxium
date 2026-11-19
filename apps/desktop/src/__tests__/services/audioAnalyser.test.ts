import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock socket
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({
    emit: vi.fn(),
  }),
}));

// Mock the rnnoise-wasm worklet URL (not loadable in test environment)
vi.mock('@timephy/rnnoise-wasm', () => ({
  NoiseSuppressorWorklet_Name: 'NoiseSuppressorWorklet',
}));
vi.mock('@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url', () => ({
  default: 'mock-worklet-url.js',
}));

// Mock AudioContext and related Web Audio API
const mockAnalyserNode = {
  fftSize: 2048,
  getFloatTimeDomainData: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const mockGainNode = {
  gain: { value: 0, cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const mockSourceNode = {
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const addModule = vi.fn().mockRejectedValue(new Error('Worklet not available in test'));

/**
 * One AudioContext. `currentTime` is what the rendering thread has played:
 * it advances with the (fake) clock unless the context is stalled, the way a
 * context that never starts rendering (suspended, a dead audio device) does.
 */
class MockAudioContext {
  static created: MockAudioContext[] = [];
  static stallNext = false;
  /** Runs once on the next context made (then cleared). */
  static nextSetup: ((ctx: MockAudioContext) => void) | null = null;
  readonly createdAt = Date.now();
  readonly stalled = MockAudioContext.stallNext;
  readonly sampleRate = 48_000;
  readonly destinations: Array<{ stream: MediaStream }> = [];
  state = 'running';
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  audioWorklet = { addModule };
  createAnalyser = vi.fn().mockReturnValue(mockAnalyserNode);
  createGain = vi.fn().mockReturnValue(mockGainNode);
  createMediaStreamSource = vi.fn().mockReturnValue(mockSourceNode);
  createMediaStreamDestination = vi.fn(() => {
    const destination = { stream: { getAudioTracks: () => [{ kind: 'audio', enabled: true }] } as unknown as MediaStream, connect: vi.fn(), disconnect: vi.fn() };
    this.destinations.push(destination);
    return destination;
  });
  constructor() {
    MockAudioContext.created.push(this);
    const setup = MockAudioContext.nextSetup;
    MockAudioContext.nextSetup = null;
    setup?.(this);
  }
  get currentTime(): number {
    return this.stalled ? 0 : (Date.now() - this.createdAt) / 1000;
  }
}
vi.stubGlobal('AudioContext', MockAudioContext);

/** The main-thread side of an RNNoise worklet node. */
class MockAudioWorkletNode {
  static created: MockAudioWorkletNode[] = [];
  onprocessorerror: ((e: Event) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    MockAudioWorkletNode.created.push(this);
  }
  /** The processor threw (its constructor, or `process()` later): the browser
   *  fires `processorerror` at the node, as a task of its own. */
  fail() {
    this.onprocessorerror?.(new Event('processorerror'));
  }
}
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

import {
  setNoiseSuppression,
  setNoiseGateThreshold,
  onSpeakingChange,
  onNoiseSuppressionFailure,
  getAudioLevel,
  getGatedStream,
  getSuppressedStream,
  getSpeakingDetectionMode,
  applyNoiseSuppression,
  startSpeakingDetection,
  stopSpeakingDetection,
  stopNoiseSuppression,
} from '../../services/audioAnalyser';

const micStream = (name = 'mic') => ({ id: name, getAudioTracks: () => [] }) as unknown as MediaStream;
const lastNode = () => MockAudioWorkletNode.created.at(-1)!;

describe('audioAnalyser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addModule.mockRejectedValue(new Error('Worklet not available in test'));
    onNoiseSuppressionFailure(null);
    stopSpeakingDetection();
    stopNoiseSuppression();
    MockAudioContext.created = [];
    MockAudioContext.stallNext = false;
    MockAudioWorkletNode.created = [];
  });

  afterEach(() => {
    stopSpeakingDetection();
    stopNoiseSuppression();
    onNoiseSuppressionFailure(null);
    vi.useRealTimers();
  });

  describe('setNoiseSuppression', () => {
    it('should set the noise suppression flag without throwing', () => {
      expect(() => setNoiseSuppression(true)).not.toThrow();
      expect(() => setNoiseSuppression(false)).not.toThrow();
    });
  });

  describe('setNoiseGateThreshold', () => {
    it('should accept a numeric threshold', () => {
      expect(() => setNoiseGateThreshold(0.01)).not.toThrow();
      expect(() => setNoiseGateThreshold(0.1)).not.toThrow();
    });
  });

  describe('onSpeakingChange', () => {
    it('should accept a callback or null', () => {
      const cb = vi.fn();
      expect(() => onSpeakingChange(cb)).not.toThrow();
      expect(() => onSpeakingChange(null)).not.toThrow();
    });
  });

  describe('getAudioLevel', () => {
    it('should return 0 initially', () => {
      expect(getAudioLevel()).toBe(0);
    });
  });

  describe('getSuppressedStream / getGatedStream', () => {
    it('should return null when no pipeline is active', () => {
      expect(getSuppressedStream()).toBeNull();
      expect(getGatedStream()).toBeNull();
    });
  });

  // A failed RNNoise worklet outputs silence: the microphone has to go out
  // raw instead, and the user has to hear about it. The browser constructs the
  // processor on the rendering thread AFTER the node, and reports a throw there
  // (or in `process()` later) as a `processorerror` TASK — never before a
  // microtask queued at construction, which is what the readiness check used
  // to wait for.
  describe('applyNoiseSuppression', () => {
    let failures: Array<{ phase: string; rawStream: MediaStream }>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      failures = [];
      onNoiseSuppressionFailure((failure) => failures.push(failure));
      setNoiseSuppression(true);
      addModule.mockResolvedValue(undefined);
    });

    it('returns the original stream when suppression is disabled, and reports nothing', async () => {
      setNoiseSuppression(false);
      const mic = micStream();
      expect(await applyNoiseSuppression(mic)).toBe(mic);
      expect(MockAudioContext.created).toHaveLength(0);
      expect(failures).toEqual([]);
    });

    it('falls back to the original stream when addModule rejects, and reports the failure', async () => {
      addModule.mockRejectedValueOnce(new Error('blocked'));
      const mic = micStream();
      expect(await applyNoiseSuppression(mic)).toBe(mic);
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
      expect(failures).toEqual([{ phase: 'start', reason: 'load-error', rawStream: mic }]);
    });

    it('a healthy worklet: the suppressed stream, once the rendering thread ran (not at the next microtask)', async () => {
      const mic = micStream();
      let result: MediaStream | undefined;
      void applyNoiseSuppression(mic).then((s) => { result = s; });
      // The node exists, but nothing has rendered yet: no verdict
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(MockAudioWorkletNode.created).toHaveLength(1);
      expect(result).toBeUndefined();

      await vi.advanceTimersByTimeAsync(100);
      expect(result).toBe(MockAudioContext.created[0].destinations[0].stream);
      expect(getSuppressedStream()).toBe(result);
      expect(mockSourceNode.connect).toHaveBeenCalledWith(lastNode());
      expect(failures).toEqual([]);
    });

    it('a processor that fails at start (its error a later task): the raw stream, reported once', async () => {
      const mic = micStream();
      let result: MediaStream | undefined;
      void applyNoiseSuppression(mic).then((s) => { result = s; });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const node = lastNode();
      setTimeout(() => node.fail(), 3); // the rendering thread threw in the constructor

      await vi.advanceTimersByTimeAsync(100);
      expect(result).toBe(mic);
      expect(getSuppressedStream()).toBeNull();
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
      expect(failures).toEqual([{ phase: 'start', reason: 'processor-error', rawStream: mic }]);
      node.fail(); // a second report from the dead node changes nothing
      expect(failures).toHaveLength(1);
    });

    it('a context that never renders: the raw stream after the timeout for THIS pipeline, reported as nothing broken', async () => {
      MockAudioContext.stallNext = true;
      const mic = micStream();
      let result: MediaStream | undefined;
      void applyNoiseSuppression(mic).then((s) => { result = s; });
      await vi.advanceTimersByTimeAsync(1_900);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toBe(mic);
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
      expect(failures).toEqual([]);

      // The next start (a rendering context) runs suppression again
      MockAudioContext.stallNext = false;
      const next = applyNoiseSuppression(micStream('again'));
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toBe(MockAudioContext.created[1].destinations[0].stream);
      expect(failures).toEqual([]);
    });

    it('a context that has rendered while the polls were starved (a long main-thread task, a hidden page): healthy at the timeout', async () => {
      // The polls never get to run; only the timeout settles the start
      const poll = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
      const mic = micStream();
      let result: MediaStream | undefined;
      void applyNoiseSuppression(mic).then((s) => { result = s; });
      await vi.advanceTimersByTimeAsync(2_000);
      poll.mockRestore();
      expect(result).toBe(MockAudioContext.created[0].destinations[0].stream);
      expect(getSuppressedStream()).toBe(result);
      expect(failures).toEqual([]);
    });

    it('a start that failed on a suspended context logs no refused resume (Firefox refuses it once the context is closed)', async () => {
      addModule.mockRejectedValueOnce(new Error('blocked'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // A suspended context whose pending resume is refused when it closes
      let rejectResume: (err: Error) => void = () => {};
      MockAudioContext.nextSetup = (ctx) => {
        ctx.state = 'suspended';
        ctx.resume = vi.fn(() => new Promise<undefined>((_, reject) => { rejectResume = reject; }));
        ctx.close = vi.fn(async () => {
          ctx.state = 'closed';
          rejectResume(new Error('AbortError: the context was closed'));
          return undefined;
        });
      };
      await applyNoiseSuppression(micStream());
      await vi.advanceTimersByTimeAsync(10);
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
      expect(warn.mock.calls.filter(([m]) => String(m).includes('Failed to resume'))).toEqual([]);
      warn.mockRestore();
    });

    it('a processor that fails MID-CALL: suppression torn down, reported with the raw stream to fall back on', async () => {
      const mic = micStream();
      const pending = applyNoiseSuppression(mic);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).not.toBe(mic);

      lastNode().fail(); // process() threw minutes into the call
      expect(failures).toEqual([{ phase: 'running', reason: 'processor-error', rawStream: mic }]);
      expect(getSuppressedStream()).toBeNull();
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
      lastNode().fail();
      expect(failures).toHaveLength(1);
    });

    it('an error from a node that was replaced since is ignored', async () => {
      const first = applyNoiseSuppression(micStream('a'));
      await vi.advanceTimersByTimeAsync(100);
      await first;
      const firstNode = lastNode();
      const second = applyNoiseSuppression(micStream('b'));
      await vi.advanceTimersByTimeAsync(100);
      const suppressed = await second;

      firstNode.fail();
      expect(failures).toEqual([]);
      expect(getSuppressedStream()).toBe(suppressed);
    });

    it('a newer call while one is starting: the older gives up quietly on its own context, the newer wins', async () => {
      const micA = micStream('a');
      const micB = micStream('b');
      const a = applyNoiseSuppression(micA);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const b = applyNoiseSuppression(micB);
      await vi.advanceTimersByTimeAsync(100);

      expect(await a).toBe(micA);
      const suppressed = await b;
      expect(suppressed).toBe(MockAudioContext.created[1].destinations[0].stream);
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
      expect(MockAudioContext.created[1].close).not.toHaveBeenCalled();
      expect(getSuppressedStream()).toBe(suppressed);
      expect(failures).toEqual([]);
      // The live node is the newer call's own
      MockAudioWorkletNode.created[0].fail();
      expect(failures).toEqual([]);
      MockAudioWorkletNode.created[1].fail();
      expect(failures).toEqual([{ phase: 'running', reason: 'processor-error', rawStream: micB }]);
    });

    it('stopped while starting (the call ended): the raw stream, its context closed, nothing reported', async () => {
      const mic = micStream();
      const pending = applyNoiseSuppression(mic);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      stopNoiseSuppression();
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe(mic);
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
      expect(getSuppressedStream()).toBeNull();
      expect(failures).toEqual([]);
    });

    it('a listener that throws does not break the fallback', async () => {
      onNoiseSuppressionFailure(() => { throw new Error('listener bug'); });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      addModule.mockRejectedValueOnce(new Error('blocked'));
      const mic = micStream();
      expect(await applyNoiseSuppression(mic)).toBe(mic);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[NoiseSuppression]'), expect.any(Error));
      error.mockRestore();
      warn.mockRestore();
    });

    it('cleans up the previous suppression context on re-apply', async () => {
      const first = applyNoiseSuppression(micStream('a'));
      await vi.advanceTimersByTimeAsync(100);
      await first;
      addModule.mockRejectedValueOnce(new Error('fail'));
      await applyNoiseSuppression(micStream('b'));
      expect(MockAudioContext.created[0].close).toHaveBeenCalled();
    });
  });

  describe('startSpeakingDetection / stopSpeakingDetection', () => {
    it('should start and stop without errors in server mode', () => {
      const mockStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      expect(() => startSpeakingDetection(mockStream, 'server')).not.toThrow();
      expect(() => stopSpeakingDetection()).not.toThrow();
    });

    it('should start and stop without errors in dm mode', () => {
      const mockStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      expect(() => startSpeakingDetection(mockStream, 'dm')).not.toThrow();
      expect(() => stopSpeakingDetection()).not.toThrow();
    });

    it('should set up the pipeline after starting (gated stream available)', () => {
      const mockStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      startSpeakingDetection(mockStream, 'server');
      expect(getGatedStream()).toBe(MockAudioContext.created.at(-1)!.destinations[0].stream);
    });

    it('reports which kind of call it runs for, and nothing once stopped', () => {
      const mockStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      expect(getSpeakingDetectionMode()).toBeNull();
      startSpeakingDetection(mockStream, 'dm');
      expect(getSpeakingDetectionMode()).toBe('dm');
      startSpeakingDetection(mockStream, 'server');
      expect(getSpeakingDetectionMode()).toBe('server');
      stopSpeakingDetection();
      expect(getSpeakingDetectionMode()).toBeNull();
    });

    it('should reset audio level to 0 after stopping', () => {
      const mockStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      startSpeakingDetection(mockStream, 'server');
      stopSpeakingDetection();
      expect(getAudioLevel()).toBe(0);
    });

    it('should emit speaking:false when stopping while speaking', () => {
      const cb = vi.fn();
      onSpeakingChange(cb);
      const mockStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      startSpeakingDetection(mockStream, 'server');
      // Manually force isSpeaking state by calling stop (which emits false if speaking)
      stopSpeakingDetection();
      // cb is not called because isSpeaking starts as false
      onSpeakingChange(null);
    });

    it('should handle double-stop gracefully', () => {
      const mockStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      startSpeakingDetection(mockStream, 'server');
      expect(() => stopSpeakingDetection()).not.toThrow();
      expect(() => stopSpeakingDetection()).not.toThrow();
    });

    it('a stop (a rebuild) that closes a context still resuming logs no refused resume (Firefox refuses it)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let rejectResume: (err: Error) => void = () => {};
      MockAudioContext.nextSetup = (ctx) => {
        ctx.state = 'suspended';
        ctx.resume = vi.fn(() => new Promise<undefined>((_, reject) => { rejectResume = reject; }));
        ctx.close = vi.fn(async () => { ctx.state = 'closed'; return undefined; });
      };
      startSpeakingDetection({ getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream, 'server');
      stopSpeakingDetection();
      rejectResume(new Error('AbortError: the context was closed'));
      await Promise.resolve();
      await Promise.resolve();
      expect(warn.mock.calls.filter(([m]) => String(m).includes('Failed to resume'))).toEqual([]);
      warn.mockRestore();
    });
  });

  describe('stopNoiseSuppression', () => {
    it('should handle being called when no pipeline is active', () => {
      expect(() => stopNoiseSuppression()).not.toThrow();
    });

    it('should handle double-stop gracefully', () => {
      expect(() => stopNoiseSuppression()).not.toThrow();
      expect(() => stopNoiseSuppression()).not.toThrow();
    });
  });
});
