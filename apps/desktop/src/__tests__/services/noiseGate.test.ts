import { describe, it, expect } from 'vitest';
import {
  NoiseGate,
  GATE_LEVEL_WINDOW_MS,
  GATE_OPEN_AFTER_MS,
  GATE_OVER_THRESHOLD_MS,
  GATE_LOOKAHEAD_MS,
  GATE_HOLD_MS,
  GATE_CLOSE_RAMP_MS,
  GATE_OPEN_RAMP_MS,
  isUsableThreshold,
  readNoiseGateCommand,
  readNoiseGateReport,
  readNoiseGateInit,
  type NoiseGateOptions,
} from '../../services/noiseGate';
import { DEFAULT_NOISE_GATE_THRESHOLD } from '../../services/audioDefaults';

/**
 * The noise gate's rule, driven with blocks of samples as the audio thread
 * drives it. Report positions are the index just past the block in which the
 * report came; with blocks of one sample that is the deciding sample + 1.
 */

const THRESHOLD = DEFAULT_NOISE_GATE_THRESHOLD;
const samples = (ms: number, rate: number) => Math.max(1, Math.round((ms * rate) / 1000));

// ─── Signals ────────────────────────────────────────────────────────────────

const silence = (n: number) => new Float32Array(n);

/** A constant level: its RMS is `level` (exact in floating point for 0.5). */
const steady = (n: number, level: number) => new Float32Array(n).fill(level);

/** A full-scale click: +1 and -1 in turn. */
const click = (n: number) => Float32Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1));

/** A sine of the given RMS. */
function tone(n: number, rms: number, frequency: number, rate: number) {
  const amplitude = rms * Math.SQRT2;
  return Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate));
}

/**
 * A voiced sound with a 100 Hz pitch: a decaying pulse each 10 ms period (the
 * energy gathered near the start of each period, as a voice's), scaled to the
 * given RMS over a period.
 */
function voiced(n: number, rms: number, rate: number) {
  const period = Math.round(rate / 100);
  const shape = Float64Array.from({ length: period }, (_, i) => Math.exp(-i / (0.0015 * rate)) * Math.cos((2 * Math.PI * 700 * i) / rate));
  const shapeRms = Math.sqrt(shape.reduce((sum, v) => sum + v * v, 0) / period);
  return Float32Array.from({ length: n }, (_, i) => (shape[i % period] / shapeRms) * rms);
}

function concat(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `signal` with `insert` written over it at `at`. */
function overlay(signal: Float32Array, insert: Float32Array, at: number) {
  const out = Float32Array.from(signal);
  out.set(insert, at);
  return out;
}

// ─── Driver ─────────────────────────────────────────────────────────────────

interface Report { speaking: boolean; at: number }

function makeGate(options: Partial<NoiseGateOptions> = {}) {
  const reports: Report[] = [];
  let blockEnd = 0;
  let position = 0;
  const gate = new NoiseGate({
    sampleRate: 48_000,
    threshold: THRESHOLD,
    ...options,
    onChange: (speaking) => reports.push({ speaking, at: blockEnd }),
  });
  /** Process `input` in blocks; returns the output. */
  const run = (input: Float32Array, block = 128) => {
    const output = new Float32Array(input.length);
    for (let start = 0; start < input.length; start += block) {
      const end = Math.min(start + block, input.length);
      blockEnd = position + end;
      gate.process([input.subarray(start, end)], [output.subarray(start, end)]);
    }
    position += input.length;
    return output;
  };
  return { gate, reports, run };
}

const firstNonZero = (output: Float32Array) => output.findIndex((v) => v !== 0);
const allZero = (output: Float32Array) => output.every((v) => v === 0);

describe('the noise gate', () => {
  const RATE = 48_000;
  const W = samples(GATE_LEVEL_WINDOW_MS, RATE);
  const OVER = samples(GATE_OVER_THRESHOLD_MS, RATE);
  const HOLD = samples(GATE_HOLD_MS, RATE);
  const LOOKAHEAD = samples(GATE_LOOKAHEAD_MS, RATE);

  it('its constants: a sound must last longer than the measure remembers, and the look-ahead covers the decision and the opening ramp', () => {
    expect(GATE_LEVEL_WINDOW_MS).toBeLessThan(GATE_OPEN_AFTER_MS);
    expect(GATE_OVER_THRESHOLD_MS).toBe(GATE_OPEN_AFTER_MS + GATE_LEVEL_WINDOW_MS);
    expect(GATE_LOOKAHEAD_MS).toBe(GATE_OVER_THRESHOLD_MS + GATE_OPEN_RAMP_MS);
    expect(makeGate().gate.lookaheadSamples).toBe(LOOKAHEAD);
  });

  describe('a sound shorter than the opening time never opens it, however loud', () => {
    for (const ms of [1, 3, 5, 10, 15, 20, 24, GATE_OPEN_AFTER_MS]) {
      it(`a full-scale burst of ${ms} ms: no report, and nothing of it passes`, () => {
        for (const burst of [steady(samples(ms, RATE), 1), click(samples(ms, RATE))]) {
          const { reports, run } = makeGate();
          const output = run(concat(silence(4800), burst, silence(48_000)), 1);
          expect(reports).toEqual([]);
          expect(allZero(output)).toBe(true);
        }
      });
    }

    it('a sound just longer than the opening time opens it', () => {
      const { reports, run } = makeGate();
      run(concat(silence(4800), steady(samples(GATE_OPEN_AFTER_MS, RATE) + 2, 1), silence(4800)), 1);
      expect(reports.map((r) => r.speaking)).toEqual([true]);
    });
  });

  it('a sustained sound opens it, and its FIRST samples leave the gate at full level (the look-ahead)', () => {
    const onset = 4800;
    const { reports, run } = makeGate();
    const output = run(concat(silence(onset), steady(9600, 0.5), silence(4800)), 1);

    // Decided once the level has been over the threshold for the opening rule
    expect(reports[0]).toEqual({ speaking: true, at: onset + OVER });
    // Nothing before the sound, and the sound from its very first sample, at full gain
    expect(firstNonZero(output)).toBe(onset + LOOKAHEAD);
    expect(output[onset + LOOKAHEAD]).toBe(0.5);
    expect(Array.from(output.subarray(onset + LOOKAHEAD, onset + LOOKAHEAD + 9600)).every((v) => v === 0.5)).toBe(true);
  });

  describe('a steady sound keeps the meaning of the threshold', () => {
    it('a 100 Hz voiced sound slightly over the threshold reads as continuously over it, and opens the gate', () => {
      for (const make of [voiced, (n: number, rms: number, rate: number) => tone(n, rms, 100, rate)]) {
        const { gate, reports, run } = makeGate();
        run(concat(silence(4800), make(samples(400, RATE), THRESHOLD * 1.05, RATE)), 1);
        expect(reports.map((r) => r.speaking)).toEqual([true]);
        expect(gate.open).toBe(true);
      }
    });

    it('the same sound slightly under the threshold never opens it', () => {
      for (const make of [voiced, (n: number, rms: number, rate: number) => tone(n, rms, 100, rate)]) {
        const { reports, run } = makeGate();
        const output = run(concat(silence(4800), make(samples(1000, RATE), THRESHOLD * 0.95, RATE)), 128);
        expect(reports).toEqual([]);
        expect(allZero(output)).toBe(true);
      }
    });
  });

  describe('the hold', () => {
    const end = 9600; // a 200 ms sound from the start
    // The level stays over the threshold until the sound's last sample has
    // left the window: the last sample that meets the rule is end + W - 1
    const closesAt = end + W - 1 + HOLD;

    it('closes 300 ms after the last sound that met the opening rule, with a short ramp', () => {
      const { reports, run } = makeGate();
      // Under the threshold after the sound, so the ramp can be seen on the output
      const quiet = THRESHOLD / 2;
      const output = run(concat(steady(end, 0.5), steady(samples(1000, RATE), quiet)), 1);

      expect(reports).toEqual([{ speaking: true, at: OVER }, { speaking: false, at: closesAt }]);
      // The quiet tail passes at full gain until the decision, fades over
      // the closing ramp, then nothing
      const decided = closesAt - 1;
      expect(output[decided - 1]).toBeCloseTo(quiet, 6);
      const mid = output[decided + Math.round(samples(GATE_CLOSE_RAMP_MS, RATE) / 2)];
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(quiet);
      expect(allZero(output.subarray(decided + samples(GATE_CLOSE_RAMP_MS, RATE)))).toBe(true);
    });

    it('loud short bursts every 150 ms after a sustained sound pass, but do not keep it open', () => {
      const { reports, run } = makeGate();
      let input = concat(steady(end, 0.5), silence(samples(1500, RATE)));
      const bursts = [150, 300, 450, 600, 750, 900, 1050].map((ms) => end + samples(ms, RATE));
      for (const at of bursts) input = overlay(input, click(samples(5, RATE)), at);
      const output = run(input, 1);

      // Closed exactly when it closes without the bursts
      expect(reports).toEqual([{ speaking: true, at: OVER }, { speaking: false, at: closesAt }]);
      // A burst while open passes (delayed); one after the close does not
      expect(Math.abs(output[bursts[0] + LOOKAHEAD])).toBe(1);
      expect(allZero(output.subarray(bursts[3], bursts[3] + LOOKAHEAD + samples(10, RATE)))).toBe(true);
    });

    it('speech that goes on keeps it open, through the pauses between words', () => {
      const { reports, run } = makeGate();
      const word = steady(samples(120, RATE), 0.2);
      const pause = silence(samples(200, RATE));
      run(concat(word, pause, word, pause, word, silence(samples(1000, RATE))), 128);
      expect(reports.map((r) => r.speaking)).toEqual([true, false]);
    });
  });

  it('a threshold change applies from the next sample', () => {
    const { gate, reports, run } = makeGate({ threshold: 0.03 });
    run(steady(samples(200, RATE), 0.02), 1);
    expect(reports).toEqual([]);

    expect(gate.setThreshold(Number.NaN)).toBe(false);
    expect(gate.setThreshold(-1)).toBe(false);
    run(steady(samples(200, RATE), 0.02), 1);
    expect(reports).toEqual([]);

    expect(gate.setThreshold(0.01)).toBe(true);
    run(steady(samples(200, RATE), 0.02), 1);
    expect(reports).toEqual([{ speaking: true, at: samples(400, RATE) + OVER }]);
  });

  describe('paused (muted)', () => {
    it('closes and reports "not speaking" once; nothing is decided until it ends', () => {
      const { gate, reports, run } = makeGate();
      run(steady(samples(200, RATE), 0.5), 128);
      expect(reports.map((r) => r.speaking)).toEqual([true]);

      gate.setPaused(true);
      gate.setPaused(true);
      expect(reports.map((r) => r.speaking)).toEqual([true, false]);
      expect(gate.open).toBe(false);
      const whilePaused = run(steady(samples(500, RATE), 0.5), 128);
      expect(reports).toHaveLength(2);
      // Closed with the ramp: silent once the ramp has run
      expect(allZero(whilePaused.subarray(samples(GATE_CLOSE_RAMP_MS, RATE) + 1))).toBe(true);

      // Ended: a sound has to meet the rule again
      gate.setPaused(false);
      expect(reports).toHaveLength(2);
      run(steady(OVER - 1, 0.5), 1);
      expect(reports).toHaveLength(2);
      run(steady(1, 0.5), 1);
      expect(reports.map((r) => r.speaking)).toEqual([true, false, true]);
    });

    it('a pause in silence reports nothing', () => {
      const { gate, reports } = makeGate();
      gate.setPaused(true);
      gate.setPaused(false);
      expect(reports).toEqual([]);
    });

    it('where the pause does not close the gate (a direct call): the audio is still gated, the reports wait for its end', () => {
      const { gate, reports, run } = makeGate({ pauseClosesGate: false });
      run(steady(samples(200, RATE), 0.5), 128);
      gate.setPaused(true);
      expect(reports.map((r) => r.speaking)).toEqual([true, false]);

      // Push-to-talk held while muted: heard, gated by the rule, not reported
      const held = run(steady(samples(200, RATE), 0.5), 128);
      expect(held.every((v) => v === 0.5)).toBe(true);
      expect(reports).toHaveLength(2);

      gate.setPaused(false);
      expect(reports.map((r) => r.speaking)).toEqual([true, false, true]);
    });

    it('a direct call\'s gate that closed during the pause reports nothing at its end', () => {
      const { gate, reports, run } = makeGate({ pauseClosesGate: false });
      run(steady(samples(200, RATE), 0.5), 128);
      gate.setPaused(true);
      run(silence(samples(1000, RATE)), 128);
      gate.setPaused(false);
      expect(reports.map((r) => r.speaking)).toEqual([true, false]);
    });

    it('started paused: nothing opens it', () => {
      const { reports, run } = makeGate({ paused: true, open: true });
      const output = run(steady(samples(500, RATE), 0.5), 128);
      expect(reports).toEqual([]);
      expect(allZero(output)).toBe(true);
    });
  });

  it('a change is reported once, not per block', () => {
    const { reports, run } = makeGate();
    run(steady(samples(2000, RATE), 0.5), 128);
    expect(reports.map((r) => r.speaking)).toEqual([true]);
    run(silence(samples(2000, RATE)), 128);
    expect(reports.map((r) => r.speaking)).toEqual([true, false]);
  });

  it('silence, and a noise floor under the threshold, report nothing and pass nothing', () => {
    const { reports, run } = makeGate();
    expect(allZero(run(silence(samples(2000, RATE)), 128))).toBe(true);
    // A deterministic noise at half the threshold
    let seed = 1;
    const noise = Float32Array.from({ length: samples(2000, RATE) }, () => {
      seed = (seed * 16807) % 2147483647;
      return ((seed / 2147483647) * 2 - 1) * THRESHOLD * 0.5 * Math.sqrt(3);
    });
    expect(allZero(run(noise, 128))).toBe(true);
    expect(reports).toEqual([]);
  });

  it('starting open (handed over from a decider that heard speech) reports nothing, and closes after the hold', () => {
    const { gate, reports, run } = makeGate({ open: true });
    expect(gate.open).toBe(true);
    run(silence(HOLD + 10), 1);
    expect(reports).toEqual([{ speaking: false, at: HOLD }]);
  });

  describe('at 44.1 and 48 kHz', () => {
    for (const rate of [44_100, 48_000]) {
      it(`${rate} Hz: the same times, in samples of that rate`, () => {
        const reports: Report[] = [];
        let at = 0;
        const gate = new NoiseGate({ sampleRate: rate, threshold: THRESHOLD, onChange: (speaking) => reports.push({ speaking, at }) });
        const onset = samples(100, rate);
        const length = samples(200, rate);
        const input = concat(silence(onset), steady(length, 0.5), silence(samples(1000, rate)));
        const output = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
          at = i + 1;
          gate.process([input.subarray(i, i + 1)], [output.subarray(i, i + 1)]);
        }
        const window = samples(GATE_LEVEL_WINDOW_MS, rate);
        expect(window).toBe(rate / 100); // one 100 Hz period at both rates
        expect(reports).toEqual([
          { speaking: true, at: onset + samples(GATE_OVER_THRESHOLD_MS, rate) },
          { speaking: false, at: onset + length + window - 1 + samples(GATE_HOLD_MS, rate) },
        ]);
        // The look-ahead, within a sample of GATE_LOOKAHEAD_MS at this rate
        const lookahead = gate.lookaheadSamples;
        expect(Math.abs(lookahead - (GATE_LOOKAHEAD_MS * rate) / 1000)).toBeLessThanOrEqual(1);
        expect(firstNonZero(output)).toBe(onset + lookahead);
        expect(output[onset + lookahead]).toBe(0.5);
      });
    }
  });

  it('block sizes other than 128: the same output and the same reports', () => {
    const input = concat(
      silence(4800), voiced(samples(300, RATE), 0.05, RATE), silence(samples(150, RATE)),
      click(samples(5, RATE)), silence(samples(600, RATE)), steady(samples(100, RATE), 0.3), silence(samples(800, RATE)),
    );
    const reference = makeGate();
    const expected = reference.run(input, 1);
    expect(reference.reports.map((r) => r.speaking)).toEqual([true, false, true, false]);
    for (const block of [2, 64, 100, 127, 128, 441, 1000, 4800, input.length]) {
      const { reports, run } = makeGate();
      const output = run(input, block);
      expect(output).toEqual(expected);
      expect(reports.map((r) => r.speaking)).toEqual(reference.reports.map((r) => r.speaking));
      reports.forEach((r, i) => {
        // reported in the block that holds the deciding sample
        expect(r.at).toBeGreaterThanOrEqual(reference.reports[i].at);
        expect(r.at - reference.reports[i].at).toBeLessThan(block);
      });
    }
  });

  it('a sound on the second channel alone opens it, decided on the mix of the channels, and both are gated alike', () => {
    const n = samples(400, RATE);
    const onset = 4800;
    const left = silence(n);
    const right = concat(silence(onset), steady(n - onset, 0.5));
    const outLeft = new Float32Array(n).fill(9);
    const outRight = new Float32Array(n);
    const reports: boolean[] = [];
    const gate = new NoiseGate({ sampleRate: RATE, threshold: THRESHOLD, onChange: (speaking) => reports.push(speaking) });
    gate.process([left, right], [outLeft, outRight]);
    expect(reports).toEqual([true]);
    expect(outRight[onset + LOOKAHEAD]).toBe(0.5);
    expect(firstNonZero(outRight)).toBe(onset + LOOKAHEAD);
    expect(allZero(outLeft)).toBe(true);

    // The mix is the mean: the same sound at a level whose half is under the
    // threshold, on one channel of two, does not open it
    const quiet = new NoiseGate({ sampleRate: RATE, threshold: THRESHOLD, onChange: (speaking) => reports.push(speaking) });
    quiet.process([silence(n), steady(n, THRESHOLD * 1.9)], [new Float32Array(n), new Float32Array(n)]);
    expect(reports).toEqual([true]);
  });

  it('every output channel is its own input delayed, under the one gain decided on their mix', () => {
    const gate = new NoiseGate({ sampleRate: RATE, threshold: THRESHOLD });
    const n = samples(300, RATE);
    const left = steady(n, 0.5);
    const right = steady(n, 0.25);
    const outLeft = new Float32Array(n);
    const outRight = new Float32Array(n);
    const outThird = new Float32Array(n).fill(9);
    gate.process([left, right], [outLeft, outRight, outThird]);
    expect(outLeft[LOOKAHEAD]).toBe(0.5);
    expect(outRight[LOOKAHEAD]).toBe(0.25);
    expect(allZero(outThird)).toBe(true); // no input for it: silence
  });

  it('an input with no channels (nothing connected) is silence', () => {
    const gate = new NoiseGate({ sampleRate: RATE, threshold: THRESHOLD, open: true });
    const out = new Float32Array(HOLD + 1).fill(9);
    gate.process([], [out]);
    expect(allZero(out)).toBe(true);
    expect(gate.open).toBe(false);
  });

  it('refuses a sample rate or a threshold it cannot use', () => {
    expect(() => new NoiseGate({ sampleRate: 0, threshold: THRESHOLD })).toThrow(RangeError);
    expect(() => new NoiseGate({ sampleRate: Number.NaN, threshold: THRESHOLD })).toThrow(RangeError);
    expect(() => new NoiseGate({ sampleRate: RATE, threshold: -0.1 })).toThrow(RangeError);
    expect(() => new NoiseGate({ sampleRate: RATE, threshold: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('a sample that is not a number reads as silence and does not poison the level', () => {
    const { reports, run } = makeGate();
    const output = run(concat(steady(10, Number.NaN), steady(10, Number.POSITIVE_INFINITY), steady(samples(200, RATE), 0.5)), 1);
    expect(reports).toEqual([{ speaking: true, at: 20 + OVER }]);
    expect(output.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('the messages between the page and the processor', () => {
  it('a command is read field by field', () => {
    expect(readNoiseGateCommand({ type: 'threshold', value: 0.02 })).toEqual({ type: 'threshold', value: 0.02 });
    expect(readNoiseGateCommand({ type: 'paused', value: true })).toEqual({ type: 'paused', value: true });
    expect(readNoiseGateCommand({ type: 'stop' })).toEqual({ type: 'stop' });
    for (const bad of [null, 'stop', 1, {}, { type: 'threshold', value: 'x' }, { type: 'threshold', value: -1 }, { type: 'threshold', value: Number.NaN }, { type: 'paused', value: 1 }, { type: 'level' }]) {
      expect(readNoiseGateCommand(bad)).toBeNull();
    }
  });

  it('a report is a change of the decision, nothing else', () => {
    expect(readNoiseGateReport({ type: 'speaking', speaking: false })).toEqual({ type: 'speaking', speaking: false });
    for (const bad of [null, true, { type: 'speaking' }, { type: 'speaking', speaking: 1 }, { type: 'level', speaking: true }]) {
      expect(readNoiseGateReport(bad)).toBeNull();
    }
  });

  it('the start state keeps only the usable fields', () => {
    expect(readNoiseGateInit({ threshold: 0.01, paused: false, open: true, pauseClosesGate: false }))
      .toEqual({ threshold: 0.01, paused: false, open: true, pauseClosesGate: false });
    expect(readNoiseGateInit({ threshold: Number.NaN, paused: 'yes', open: 1 })).toEqual({});
    expect(readNoiseGateInit(undefined)).toEqual({});
    expect(isUsableThreshold(0)).toBe(true);
    expect(isUsableThreshold(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
