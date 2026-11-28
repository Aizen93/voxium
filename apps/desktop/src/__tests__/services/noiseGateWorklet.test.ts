import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NOISE_GATE_PROCESSOR_NAME, GATE_OVER_THRESHOLD_MS, GATE_HOLD_MS } from '../../services/noiseGate';

/**
 * The processor shell, loaded as the audio thread loads it: the
 * AudioWorkletGlobalScope's names are put on the global object before its
 * module runs, and the class it registers is driven like the browser drives it.
 */

type Port = { postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null };
type Processor = { port: Port; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
type ProcessorClass = new (options: { processorOptions?: unknown }) => Processor;

const registered: Array<{ name: string; processor: ProcessorClass }> = [];
const RATE = 48_000;
const samples = (ms: number) => Math.round((ms * RATE) / 1000);

beforeAll(async () => {
  vi.stubGlobal('sampleRate', RATE);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port: Port = { postMessage: vi.fn(), onmessage: null };
  });
  vi.stubGlobal('registerProcessor', (name: string, processor: ProcessorClass) => registered.push({ name, processor }));
  await import('../../services/noiseGateWorklet');
});

function make(processorOptions?: unknown) {
  expect(registered).toHaveLength(1);
  return new registered[0].processor({ processorOptions });
}

/** Run `length` samples of a constant `level` through, in render quanta of 128. */
function feed(processor: Processor, length: number, level: number) {
  let alive = true;
  for (let done = 0; done < length; done += 128) {
    const input = new Float32Array(128).fill(level);
    alive = processor.process([[input]], [[new Float32Array(128)]]) && alive;
  }
  return alive;
}

const reports = (processor: Processor) => processor.port.postMessage.mock.calls.map(([message]) => message);

describe('the noise gate processor', () => {
  it('registers under the name the page asks for', () => {
    expect(registered.map((r) => r.name)).toEqual([NOISE_GATE_PROCESSOR_NAME]);
  });

  it('posts each change of its decision to the page, and nothing else', () => {
    const processor = make({ threshold: 0.01, paused: false, open: false, pauseClosesGate: true });
    expect(feed(processor, samples(500), 0.5)).toBe(true);
    expect(reports(processor)).toEqual([{ type: 'speaking', speaking: true }]);
    feed(processor, samples(GATE_HOLD_MS + 100), 0);
    expect(reports(processor)).toEqual([{ type: 'speaking', speaking: true }, { type: 'speaking', speaking: false }]);
  });

  it('a threshold from the page applies; a malformed message changes nothing', () => {
    const processor = make({ threshold: 0.6 });
    feed(processor, samples(200), 0.5);
    expect(reports(processor)).toEqual([]);
    processor.port.onmessage!({ data: { type: 'threshold', value: 'low' } });
    processor.port.onmessage!({ data: null });
    feed(processor, samples(200), 0.5);
    expect(reports(processor)).toEqual([]);
    processor.port.onmessage!({ data: { type: 'threshold', value: 0.1 } });
    feed(processor, samples(GATE_OVER_THRESHOLD_MS) + 128, 0.5);
    expect(reports(processor)).toEqual([{ type: 'speaking', speaking: true }]);
  });

  it('the pause from the page closes it (a space call) and reports "not speaking" once', () => {
    const processor = make({ threshold: 0.01, pauseClosesGate: true });
    feed(processor, samples(200), 0.5);
    processor.port.onmessage!({ data: { type: 'paused', value: true } });
    feed(processor, samples(500), 0.5);
    expect(reports(processor)).toEqual([{ type: 'speaking', speaking: true }, { type: 'speaking', speaking: false }]);
  });

  it('starts in the state the page hands it (paused, open, the pause not closing it)', () => {
    const processor = make({ threshold: 0.01, paused: true, open: false, pauseClosesGate: false });
    feed(processor, samples(200), 0.5);
    expect(reports(processor)).toEqual([]);
    processor.port.onmessage!({ data: { type: 'paused', value: false } });
    expect(reports(processor)).toEqual([{ type: 'speaking', speaking: true }]);
  });

  it('without usable start options: the default threshold, closed, not paused', () => {
    const processor = make(undefined);
    feed(processor, samples(200), 0.5);
    expect(reports(processor)).toEqual([{ type: 'speaking', speaking: true }]);
  });

  it('a stop ends its processing', () => {
    const processor = make({ threshold: 0.01 });
    processor.port.onmessage!({ data: { type: 'stop' } });
    expect(feed(processor, 128, 0.5)).toBe(false);
  });

  it('an input with nothing connected is processed as silence', () => {
    const processor = make({ threshold: 0.01, open: true });
    const out = new Float32Array(128).fill(9);
    expect(processor.process([[]], [[out]])).toBe(true);
    expect(processor.process([], [])).toBe(true);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});
