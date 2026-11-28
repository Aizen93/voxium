/**
 * The microphone's noise gate: the decision "is this a voice, is the gate
 * open" and the gain it puts on the audio, driven one block of samples at a
 * time. It runs on the audio thread, inside the AudioWorkletProcessor of
 * noiseGateWorklet.ts, which is a thin shell around this class; it imports
 * nothing and uses no Web Audio type, so it is tested without a browser.
 *
 * The rule, on the incoming samples:
 * - The level is the RMS of the last GATE_LEVEL_WINDOW_MS of input, compared
 *   with the user's threshold.
 * - A sound "meets the opening rule" once it has lasted GATE_OPEN_AFTER_MS:
 *   the level must stay over the threshold for that long plus the window's
 *   own memory (a loud burst keeps the window over the threshold for its
 *   length plus the window), so a burst shorter than GATE_OPEN_AFTER_MS never
 *   opens the gate, however loud it is.
 * - The gate opens when a sound meets the rule, and closes GATE_HOLD_MS after
 *   the last sample at which a sound met it. A shorter sound (a click, a key
 *   press) passes while the gate is open but does not hold it open.
 * - The audio leaves through a look-ahead delay of GATE_LOOKAHEAD_MS: the
 *   decision is taken on the undelayed samples, the gain is applied to the
 *   delayed ones, so the start of a word that opened the gate still passes.
 *
 * Every constant below is on the timeline of the incoming samples: the
 * decision (and its report) happens when the incoming sample meets the rule;
 * what leaves the gate at that moment is the input of GATE_LOOKAHEAD_MS
 * earlier.
 */

/**
 * The RMS window of the level measure, 10 ms: one pitch period of a 100 Hz
 * voice, so a steady voiced sound whose period divides the window (100 or
 * 200 Hz) reads as one steady level, and one whose period does not ripples
 * only a little (a 120 Hz tone by about 6 percent), where a window shorter
 * than a pitch period dips under the threshold inside each period; and short
 * enough that a click has left the measure 10 ms after it ends.
 */
export const GATE_LEVEL_WINDOW_MS = 10;

/**
 * How long a sound must last to open the gate, and to keep it open: a
 * syllable lasts longer; a mouse click or a key press whose sound dies away
 * quickly does not. The gate rejects short sounds, not every key press: one
 * whose sound decays with a time constant of about 7 ms or more at a high
 * peak (10 ms at a peak of 0.3, 15 ms at 0.1) keeps the level over the
 * default threshold long enough to open it, and typing with such tails
 * after speech can keep it open; a louder click stays over the threshold
 * longer, not shorter.
 */
export const GATE_OPEN_AFTER_MS = 25;

/** How long the level must stay over the threshold for a sound to meet the
 *  opening rule: its duration plus the window's memory. */
export const GATE_OVER_THRESHOLD_MS = GATE_OPEN_AFTER_MS + GATE_LEVEL_WINDOW_MS;

/**
 * The opening ramp, 5 ms: long enough that the gain does not step, and run
 * while the delayed audio is still before the sound that opened the gate, so
 * it never fades a word in.
 */
export const GATE_OPEN_RAMP_MS = 5;

/**
 * The look-ahead delay on the audio path: the time the decision takes for a
 * loud sound plus the opening ramp, so the first samples of that sound leave
 * the gate at full gain. It is the latency the gate adds to the microphone.
 */
export const GATE_LOOKAHEAD_MS = GATE_OVER_THRESHOLD_MS + GATE_OPEN_RAMP_MS;

/** How long the gate stays open after the last sound that met the opening
 *  rule: the pause between two words. */
export const GATE_HOLD_MS = 300;

/** The closing ramp, as the page's gain gate has. */
export const GATE_CLOSE_RAMP_MS = 30;

/** The name the processor is registered under (noiseGateWorklet.ts). */
export const NOISE_GATE_PROCESSOR_NAME = 'voxium-noise-gate';

/** A sample that is not a finite number is silence, in the level and in the audio. */
function finite(sample: number): number {
  return sample - sample === 0 ? sample : 0;
}

/** A threshold the gate can use: a finite RMS level of at least 0. */
export function isUsableThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** What the page sends the processor. */
export type NoiseGateCommand =
  | { type: 'threshold'; value: number }
  | { type: 'paused'; value: boolean }
  | { type: 'stop' };

/** What the processor sends the page: a change of its decision, nothing else. */
export interface NoiseGateReport {
  type: 'speaking';
  speaking: boolean;
}

/** The state the processor starts in (its `processorOptions`). */
export interface NoiseGateInit {
  threshold: number;
  paused: boolean;
  open: boolean;
  pauseClosesGate: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A command the processor received, or null for anything else. */
export function readNoiseGateCommand(data: unknown): NoiseGateCommand | null {
  if (!isRecord(data)) return null;
  if (data.type === 'threshold' && isUsableThreshold(data.value)) return { type: 'threshold', value: data.value };
  if (data.type === 'paused' && typeof data.value === 'boolean') return { type: 'paused', value: data.value };
  if (data.type === 'stop') return { type: 'stop' };
  return null;
}

/** A report the page received from the processor, or null for anything else. */
export function readNoiseGateReport(data: unknown): NoiseGateReport | null {
  if (!isRecord(data) || data.type !== 'speaking' || typeof data.speaking !== 'boolean') return null;
  return { type: 'speaking', speaking: data.speaking };
}

/** The fields of a start state that are usable; the others are left out. */
export function readNoiseGateInit(data: unknown): Partial<NoiseGateInit> {
  if (!isRecord(data)) return {};
  const init: Partial<NoiseGateInit> = {};
  if (isUsableThreshold(data.threshold)) init.threshold = data.threshold;
  if (typeof data.paused === 'boolean') init.paused = data.paused;
  if (typeof data.open === 'boolean') init.open = data.open;
  if (typeof data.pauseClosesGate === 'boolean') init.pauseClosesGate = data.pauseClosesGate;
  return init;
}

export interface NoiseGateOptions {
  sampleRate: number;
  /** The RMS level a sound must exceed (the user's noise-gate threshold). */
  threshold: number;
  /** Muted: see `setPaused`. */
  paused?: boolean;
  /**
   * Start open, the hold counting from the first sample: the decider this
   * gate takes over from had heard speech, which is not reported again.
   */
  open?: boolean;
  /**
   * Whether a pause closes the gate (a space call: the page's gain gate
   * closed too) or only stops the reports (a direct call: push-to-talk held
   * while muted is still heard, gated by the rule). Default true.
   */
  pauseClosesGate?: boolean;
  /** Told each change of the decision, once, never while paused. */
  onChange?: (speaking: boolean) => void;
}

export class NoiseGate {
  private readonly windowLength: number;
  private readonly squares: Float64Array;
  private squareIndex = 0;
  private sumOfSquares = 0;
  private thresholdSum = 0;
  private readonly overLength: number;
  private readonly holdLength: number;
  private readonly delayLength: number;
  private readonly openStep: number;
  private readonly closeStep: number;
  private readonly delayLines: Float32Array[] = [];
  private channels = 0;
  private delayIndex = 0;
  /** Consecutive samples the level has been over the threshold (capped). */
  private overRun = 0;
  /** Samples since the last one at which a sound met the opening rule. */
  private sinceQualifying = 0;
  private gain: number;
  private decision: boolean;
  /** What `onChange` was last told. */
  private reported: boolean;
  private paused: boolean;
  private readonly pauseClosesGate: boolean;
  private readonly onChange: ((speaking: boolean) => void) | null;

  constructor(options: NoiseGateOptions) {
    const { sampleRate } = options;
    if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('The noise gate needs a positive sample rate');
    }
    if (!isUsableThreshold(options.threshold)) {
      throw new RangeError('The noise gate needs a finite threshold of at least 0');
    }
    const samples = (ms: number) => Math.max(1, Math.round((ms * sampleRate) / 1000));
    this.windowLength = samples(GATE_LEVEL_WINDOW_MS);
    this.squares = new Float64Array(this.windowLength);
    this.overLength = samples(GATE_OVER_THRESHOLD_MS);
    this.holdLength = samples(GATE_HOLD_MS);
    const openRampLength = samples(GATE_OPEN_RAMP_MS);
    // GATE_LOOKAHEAD_MS in samples, summed from its parts so that rounding
    // can never leave it a sample short of the decision and the ramp
    this.delayLength = this.overLength + openRampLength;
    this.openStep = 1 / openRampLength;
    this.closeStep = 1 / samples(GATE_CLOSE_RAMP_MS);
    this.pauseClosesGate = options.pauseClosesGate ?? true;
    this.paused = options.paused === true;
    this.onChange = options.onChange ?? null;
    this.setThreshold(options.threshold);
    this.decision = options.open === true && !(this.paused && this.pauseClosesGate);
    this.reported = this.decision && !this.paused;
    this.gain = this.decision ? 1 : 0;
  }

  /** Whether the gate is open (its decision, before the ramp). */
  get open(): boolean {
    return this.decision;
  }

  /** The samples the audio is delayed by. */
  get lookaheadSamples(): number {
    return this.delayLength;
  }

  /** Use a new threshold from the next sample on; an unusable value is
   *  ignored (false) and the gate keeps the one it has. */
  setThreshold(value: number): boolean {
    if (!isUsableThreshold(value)) return false;
    this.thresholdSum = value * value * this.windowLength;
    return true;
  }

  /**
   * Muted (or deafened). A pause reports "not speaking" once when "speaking"
   * was the last report, and nothing more until it ends. Where the pause
   * closes the gate, nothing is decided while it lasts: the gate is closed
   * and opens again only for a sound that meets the rule after it. Where it
   * does not, the gate goes on gating the audio and the end of the pause
   * reports the state it is in.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    if (paused) {
      this.paused = true;
      if (this.reported) {
        this.reported = false;
        this.onChange?.(false);
      }
      if (this.pauseClosesGate) {
        this.decision = false;
        this.overRun = 0;
        this.sinceQualifying = 0;
      }
      return;
    }
    this.paused = false;
    this.report(this.decision);
  }

  /**
   * One block: `input` the channels coming in (none when nothing is
   * connected: silence), `output` the channels to fill, each as long as the
   * block. The decision reads the mix of the input channels (their mean, as
   * an analyser's down-mix to one channel), so a voice on any one channel
   * counts; every output channel is its input channel, delayed, times the
   * gain.
   */
  process(input: ReadonlyArray<Float32Array>, output: ReadonlyArray<Float32Array>): void {
    const inputs = input.length;
    const length = output.length > 0 ? output[0].length : (inputs > 0 ? input[0].length : 0);
    this.useChannels(output.length);
    const closing = this.pauseClosesGate;
    for (let i = 0; i < length; i++) {
      // The level: a running sum of the squares of the mix over the window,
      // summed again exactly each time the window wraps so rounding cannot
      // build up (one channel: the mix is that channel's sample itself)
      let mix = 0;
      for (let c = 0; c < inputs; c++) {
        const channel = input[c];
        if (i < channel.length) mix += finite(channel[i]);
      }
      const x = inputs > 0 ? mix / inputs : 0;
      const square = x * x;
      this.sumOfSquares += square - this.squares[this.squareIndex];
      this.squares[this.squareIndex] = square;
      if (++this.squareIndex === this.windowLength) {
        this.squareIndex = 0;
        let exact = 0;
        for (let k = 0; k < this.windowLength; k++) exact += this.squares[k];
        this.sumOfSquares = exact;
      }

      // The decision
      if (this.paused && closing) {
        this.overRun = 0;
      } else if (this.sumOfSquares > this.thresholdSum) {
        if (this.overRun < this.overLength) this.overRun++;
      } else {
        this.overRun = 0;
      }
      if (this.overRun >= this.overLength) {
        this.sinceQualifying = 0;
        if (!this.decision) {
          this.decision = true;
          this.report(true);
        }
      } else if (this.decision && ++this.sinceQualifying >= this.holdLength) {
        this.decision = false;
        this.report(false);
      }

      // The gain, ramped toward the decision
      if (this.decision) {
        if (this.gain < 1) this.gain = Math.min(1, this.gain + this.openStep);
      } else if (this.gain > 0) {
        this.gain = Math.max(0, this.gain - this.closeStep);
      }

      // The audio, through the look-ahead delay
      const gain = this.gain;
      for (let c = 0; c < output.length; c++) {
        const line = this.delayLines[c];
        const channel = c < input.length ? input[c] : null;
        const delayed = line[this.delayIndex];
        line[this.delayIndex] = channel !== null && i < channel.length ? finite(channel[i]) : 0;
        output[c][i] = delayed * gain;
      }
      if (++this.delayIndex === this.delayLength) this.delayIndex = 0;
    }
  }

  private report(speaking: boolean): void {
    if (this.paused || speaking === this.reported) return;
    this.reported = speaking;
    this.onChange?.(speaking);
  }

  /** A delay line per output channel; a channel that (re)appears starts silent. */
  private useChannels(count: number): void {
    if (count === this.channels) return;
    for (let c = this.channels; c < count; c++) {
      if (c < this.delayLines.length) this.delayLines[c].fill(0);
      else this.delayLines.push(new Float32Array(this.delayLength));
    }
    this.channels = count;
  }
}
