import { getSocket } from './socket';
import { DEFAULT_NOISE_GATE_THRESHOLD } from './audioDefaults';
import { NoiseSuppressorWorklet_Name } from '@timephy/rnnoise-wasm';
import NoiseSuppressorWorkletUrl from '@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url';
import NoiseGateWorkletUrl from './noiseGateWorklet?worker&url';
import { NOISE_GATE_PROCESSOR_NAME, readNoiseGateReport, type NoiseGateCommand, type NoiseGateInit } from './noiseGate';

// ─── Noise Suppression Effect (isolated-pipeline pattern) ─────────────────────────
//
// Clean, isolated pipeline: source → RNNoise AudioWorklet → destination
// No analyser, no gain gate — just noise suppression.
// The processed stream feeds speaking detection and the noise gate (below),
// whose gated track the call sends; the processed track itself goes out only
// while no gated stream exists.

let nsContext: AudioContext | null = null;
let nsSource: MediaStreamAudioSourceNode | null = null;
let nsWorklet: AudioWorkletNode | null = null;
let nsDestination: MediaStreamAudioDestinationNode | null = null;

/** Whether noise suppression is enabled (user setting). */
let noiseSuppEnabled = true;

/** Bumped by every start and every stop: a start that is no longer the latest
 *  gives up at its next step, on its OWN context, and commits nothing. */
let nsGeneration = 0;

/** How long a start waits for the context to render before it gives up on
 *  this pipeline (the raw mic is used; the next rebuild tries again). */
const NS_START_TIMEOUT_MS = 2000;
const NS_START_POLL_MS = 10;
/** Render quanta (128 frames) the context must have played since the node was
 *  created before the start is taken as healthy. */
const NS_START_QUANTA = 2;

export function setNoiseSuppression(enabled: boolean) {
  noiseSuppEnabled = enabled;
}

/**
 * Stop the tracks of a pipeline's output, where that pipeline ends. Whatever
 * sends them (a mic producer, a DM peer's sender) does not stop them: the
 * pipeline owns their life. A destination's track holds no device, so this
 * frees the track only; the microphone is released by the raw stream's stop.
 */
function stopDestinationTracks(destination: MediaStreamAudioDestinationNode | null) {
  destination?.stream.getTracks().forEach((track) => track.stop());
}

/**
 * Noise suppression could not run: the worklet's module did not load
 * (`load-error`) or its processor threw (`processor-error`), at `start` (the
 * caller already got the raw stream back) or while `running` (the outgoing
 * audio was silent since the failure: the caller must rebuild on `rawStream`
 * and swap the outgoing track). A context that merely did not render in time
 * is not reported: that start uses the raw mic and the next one tries again.
 */
export interface NoiseSuppressionFailure {
  phase: 'start' | 'running';
  reason: 'load-error' | 'processor-error';
  rawStream: MediaStream;
}
let failureListener: ((failure: NoiseSuppressionFailure) => void) | null = null;

/** The one place told when an enabled noise suppression could not run. */
export function onNoiseSuppressionFailure(listener: ((failure: NoiseSuppressionFailure) => void) | null) {
  failureListener = listener;
}

function reportFailure(failure: NoiseSuppressionFailure) {
  try {
    failureListener?.(failure);
  } catch (err) {
    console.error('[NoiseSuppression] Failure listener threw:', err);
  }
}

class NoiseSuppressionSuperseded extends Error {
  constructor() {
    super('superseded by a newer start or a stop');
    this.name = 'NoiseSuppressionSuperseded';
  }
}

/** The context did not render within the start window: nothing is broken that
 *  this start can tell, so it is not reported. */
class NoiseSuppressionNotRendering extends Error {
  constructor() {
    super(`the AudioContext did not render within ${NS_START_TIMEOUT_MS} ms`);
    this.name = 'NoiseSuppressionNotRendering';
  }
}

class NoiseSuppressionProcessorError extends Error {
  constructor(event: Event) {
    super(`AudioWorklet processor error (${describeProcessorError(event)})`);
    this.name = 'NoiseSuppressionProcessorError';
  }
}

function describeProcessorError(event: Event): string {
  const message = (event as ErrorEvent).message;
  return typeof message === 'string' && message ? `${event.type}: ${message}` : event.type;
}

/**
 * Resolves once the context has rendered a few quanta since the node was made
 * with no `processorerror` (and one more poll, which leaves room for an error
 * task queued meanwhile); rejects on that error, on a supersession, or when the
 * context never rendered within the timeout.
 *
 * A processor's failure (a WASM compile error, a CSP refusal, a throw in
 * `process()`) reaches this thread as a `processorerror` TASK, so a microtask
 * queued at construction always runs before it and can never see it. What does
 * tell is the context's `currentTime`, which only the rendering thread
 * advances. Chromium constructs the processor at the start of the first
 * quantum after the node is made, so by then a constructor error is on its
 * way; Gecko may construct it later and report the error after this check has
 * passed. That is why the `processorerror` listener stays armed for the node's
 * lifetime: a later error is a `running` failure, handled the same way.
 *
 * The timeout is not itself a failure. When it fires, a context that HAS
 * rendered enough (a long main-thread task or a hidden page's throttled
 * timers starved the polls) is taken as healthy; one that never rendered
 * gives up on this pipeline only.
 */
function waitForProcessorStart(ctx: AudioContext, node: AudioWorkletNode, isCurrent: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = ctx.currentTime;
    const quantum = 128 / (ctx.sampleRate || 48_000);
    const hasRendered = () => ctx.currentTime >= startedAt + NS_START_QUANTA * quantum;
    let rendered = false;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };
    node.onprocessorerror = (event) => finish(new NoiseSuppressionProcessorError(event));
    const timeout = setTimeout(() => {
      if (!isCurrent()) finish(new NoiseSuppressionSuperseded());
      else if (hasRendered()) finish();
      else finish(new NoiseSuppressionNotRendering());
    }, NS_START_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (!isCurrent()) {
        finish(new NoiseSuppressionSuperseded());
        return;
      }
      if (!hasRendered()) return;
      if (rendered) finish();
      else rendered = true;
    }, NS_START_POLL_MS);
  });
}

/** The processor threw on the live node (in `process()`, or a constructor
 *  Gecko ran late): the node outputs silence from now on. */
function handleRunningFailure(node: AudioWorkletNode, rawStream: MediaStream, event: Event) {
  if (node !== nsWorklet) return; // a pipeline replaced since
  console.error(`[NoiseSuppression] RNNoise worklet failed during the call (${describeProcessorError(event)}), falling back to the raw mic`);
  stopNoiseSuppression();
  reportFailure({ phase: 'running', reason: 'processor-error', rawStream });
}

/**
 * Apply RNNoise noise suppression to a mic stream.
 * Returns the processed stream, or the original stream if suppression is
 * disabled, fails to start, its context does not render in time, or a newer
 * start or a stop superseded this one. A failure of the worklet itself (not a
 * supersession, not a context that did not render) is reported to
 * onNoiseSuppressionFailure.
 *
 * This follows the isolated-pipeline pattern: a dedicated AudioContext with
 * source → NoiseSuppressorWorklet → destination. Nothing else in the path.
 *
 * The worklet compiles RNNoise WASM synchronously in its constructor, on the
 * rendering thread. If that fails (e.g. CSP blocks it), or `process()` throws
 * later in the call, the node outputs silence; the browser reports either as
 * `processorerror`, which stays armed for the node's lifetime.
 */
export async function applyNoiseSuppression(micStream: MediaStream): Promise<MediaStream> {
  // Clean up any previous suppression context (and supersede a start in flight)
  stopNoiseSuppression();
  const generation = nsGeneration;
  const isCurrent = () => generation === nsGeneration;

  if (!noiseSuppEnabled) return micStream;

  // Built in locals and committed only by the latest start: an overlapping
  // start must never build its node on another start's context
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  // Set when this start closes its own context: the resume still pending on it
  // is then refused (Firefox does so), which is no news
  let closedHere = false;
  try {
    const created = new AudioContext();
    ctx = created;
    if (created.state === 'suspended') {
      // Not awaited: a context that never starts is caught by the start check
      created.resume().catch((err) => {
        if (closedHere || created.state === 'closed') return;
        console.warn('[NoiseSuppression] Failed to resume AudioContext:', err);
      });
    }

    await ctx.audioWorklet.addModule(NoiseSuppressorWorkletUrl);
    if (!isCurrent()) throw new NoiseSuppressionSuperseded();
    node = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name);
    await waitForProcessorStart(ctx, node, isCurrent);
    if (!isCurrent()) throw new NoiseSuppressionSuperseded();

    source = ctx.createMediaStreamSource(micStream);
    const destination = ctx.createMediaStreamDestination();
    // Clean pipeline: source → RNNoise → destination
    source.connect(node);
    node.connect(destination);

    const live = node;
    live.onprocessorerror = (event) => handleRunningFailure(live, micStream, event);
    nsContext = ctx;
    nsWorklet = live;
    nsSource = source;
    nsDestination = destination;

    if (import.meta.env.DEV) console.log('[NoiseSuppression] RNNoise pipeline active');
    return destination.stream;
  } catch (err) {
    if (node) node.onprocessorerror = null;
    try { source?.disconnect(); } catch (disconnectErr) {
      console.warn('[NoiseSuppression] Source disconnect error (already disconnected):', disconnectErr);
    }
    closedHere = true;
    ctx?.close().catch((closeErr) => {
      console.warn('[NoiseSuppression] AudioContext close error:', closeErr);
    });
    if (err instanceof NoiseSuppressionSuperseded || !isCurrent()) {
      if (import.meta.env.DEV) console.log('[NoiseSuppression] Start superseded');
      return micStream;
    }
    if (err instanceof NoiseSuppressionNotRendering) {
      console.warn('[NoiseSuppression] Its AudioContext did not render in time; this pipeline uses the raw mic, the next one tries again');
      return micStream;
    }
    console.warn('[NoiseSuppression] Failed to initialize RNNoise worklet, using raw mic:', err);
    reportFailure({
      phase: 'start',
      reason: err instanceof NoiseSuppressionProcessorError ? 'processor-error' : 'load-error',
      rawStream: micStream,
    });
    return micStream;
  }
}

/** Returns the noise-suppressed stream if active, or null. */
export function getSuppressedStream(): MediaStream | null {
  return nsDestination?.stream ?? null;
}

/** Tear down the noise suppression pipeline. */
export function stopNoiseSuppression() {
  nsGeneration++;
  if (nsWorklet) nsWorklet.onprocessorerror = null;
  if (nsSource) {
    try { nsSource.disconnect(); } catch (err) {
      console.warn('[NoiseSuppression] Source disconnect error (already disconnected):', err);
    }
    nsSource = null;
  }
  if (nsWorklet) {
    try { nsWorklet.disconnect(); } catch (err) {
      console.warn('[NoiseSuppression] Worklet disconnect error (already disconnected):', err);
    }
    nsWorklet = null;
  }
  // The suppressed track ends with its pipeline: whatever sent it (a mic
  // producer or a DM peer, only while no gated stream existed) leaves it alone
  stopDestinationTracks(nsDestination);
  nsDestination = null;
  if (nsContext) {
    nsContext.close().catch((err) => {
      console.warn('[NoiseSuppression] AudioContext close error:', err);
    });
    nsContext = null;
  }
}

// ─── Speaking Detection and the noise gate (after noise suppression) ────────
//
// The (already processed) stream goes through the noise gate into the gated
// destination, whose track the call sends. Two deciders exist, never both at
// once, each opening the gate and saying "speaking":
// - the audio-thread gate (noiseGateWorklet.ts around noiseGate.ts), which
//   decides on the samples themselves: a sound must last before it opens the
//   gate, and a look-ahead delay keeps the start of a word. It reports each
//   change by message, which a hidden page receives as it is (its timers are
//   slowed to one a second or less);
// - the page timer, every 20 ms on an AnalyserNode, with a gain node as the
//   gate: the decider while the gate's module loads, and the fallback where it
//   cannot load or fails. Whenever it decides, the load included, a direct
//   call keeps its gain open: the timer only detects speaking, as it always
//   has (a slowed timer in a hidden page would otherwise silence the call).
// The analyser stays in the path for the page timer, which the fallback needs.

let sdContext: AudioContext | null = null;
let sdSource: MediaStreamAudioSourceNode | null = null;
let sdAnalyser: AnalyserNode | null = null;
let sdGainNode: GainNode | null = null;
let sdDestination: MediaStreamAudioDestinationNode | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let isSpeaking = false;
let silenceStart = 0;

/** Bumped by every start and every stop: a module load still pending for an
 *  earlier pipeline gives up, on its own context, and touches nothing. */
let sdGeneration = 0;
/** Which decider runs, or null when speaking detection is not running. */
let sdDecider: 'timer' | 'worklet' | null = null;
/** The audio-thread gate's node while it decides. */
let gateNode: AudioWorkletNode | null = null;
/** The one warning a pipeline logs when its audio-thread gate cannot run. */
let gateFailureWarned = false;

const SILENCE_DELAY_MS = 300;
const TICK_INTERVAL_MS = 20;
const GAIN_RAMP_SEC = 0.03;
let threshold = DEFAULT_NOISE_GATE_THRESHOLD;
let speakingMode: 'server' | 'dm' = 'server';
let speakingChangeCallback: ((speaking: boolean) => void) | null = null;

/** When true, tick skips analyser processing (e.g. user is muted). */
let detectionPaused = false;

export function setNoiseGateThreshold(value: number) {
  threshold = value;
  sendToGate({ type: 'threshold', value });
}

export function onSpeakingChange(cb: ((speaking: boolean) => void) | null) {
  speakingChangeCallback = cb;
}

/**
 * Pause or resume speaking detection (muted, or deafened). Under the page
 * timer the interval still fires but skips its work — no
 * getFloatTimeDomainData, no RMS calculation, no socket emissions. The
 * audio-thread gate is told too and goes on processing every block (it
 * still delays the audio): in a space call it closes, in a direct call it
 * goes on gating the audio (push-to-talk overrides the mute there); either
 * way the page takes no report from it until the pause ends, as the timer
 * makes none (the one "not speaking" the gate posts at a pause is what the
 * page has already said).
 */
export function setSpeakingDetectionPaused(paused: boolean) {
  detectionPaused = paused;
  sendToGate({ type: 'paused', value: paused });
  if (paused && isSpeaking) {
    // Muting mid-sentence: with the tick paused, the last broadcast
    // 'speaking: true' would stick forever — everyone would see the green
    // speaking ring next to a mic-off icon. Force the silent transition now.
    isSpeaking = false;
    silenceStart = 0;
    if (sdGainNode && sdContext && speakingMode !== 'dm') {
      sdGainNode.gain.setTargetAtTime(0, sdContext.currentTime, GAIN_RAMP_SEC);
    }
    emitSpeaking(false);
    speakingChangeCallback?.(false);
  }
}

/**
 * Whether the detector says the local user is speaking: the state the others
 * are told (voice:speaking, dm:voice:speaking), whichever decider runs. False
 * while paused (muted), and when detection is not running.
 */
export function isSpeechDetected(): boolean {
  return isSpeaking;
}

/**
 * Which decider gates the microphone and says "speaking" now: the
 * audio-thread gate, the page timer (while the gate's module loads, and the
 * fallback where it cannot run), or null when speaking detection is not
 * running.
 */
export function getSpeakingDecider(): 'audio-thread' | 'page-timer' | null {
  if (sdDecider === 'worklet') return 'audio-thread';
  return sdDecider === 'timer' ? 'page-timer' : null;
}

/** The kind of call speaking detection runs for, or null when it is not
 *  running (whichever decider runs, and while the gate's module loads). */
export function getSpeakingDetectionMode(): 'server' | 'dm' | null {
  return sdDecider !== null ? speakingMode : null;
}

/**
 * Returns the noise-gated stream, the one a call sends.
 * For SFU: the mic producer's track; the gate silences audio when not
 * speaking (saves bandwidth).
 * For DM P2P: the peers' audio track, gated the same way by the audio-thread
 * gate; while the page timer decides (the gate's module loading, the
 * fallback), its gain stays open.
 * Null when speaking detection does not run, its start included when it
 * failed halfway: a direct call's senders and a rebuild's swap of the
 * producers already made then take the suppressed stream, or the raw one; a
 * microphone producer made afterwards takes the raw microphone.
 */
export function getGatedStream(): MediaStream | null {
  return sdDestination?.stream ?? null;
}

function emitSpeaking(speaking: boolean) {
  const socket = getSocket();
  if (!socket) return;
  if (speakingMode === 'dm') {
    socket.emit('dm:voice:speaking', speaking);
  } else {
    socket.emit('voice:speaking', speaking);
  }
}

/**
 * Send the detector's current state once more when it is "speaking", through
 * the sender the tick uses. The tick sends only changes, and a change it sent
 * before the voice session existed on the server reached nobody, so someone
 * already talking when their microphone producer is made would show no ring
 * until their next pause. Only while the detector hears speech: a stop and a
 * pause (the mute) end speech first, so nothing goes out then either.
 */
export function resendSpeaking(): void {
  if (!isSpeaking) return;
  emitSpeaking(true);
}

/**
 * Start speaking detection on a stream (should be the noise-suppressed stream).
 * For SFU mode: also applies a gain gate (silence when not speaking).
 * For DM mode: gated the same way by the audio-thread gate; while the page
 * timer decides (the gate's module loading, the fallback), the gain gate is
 * open and the timer only detects speaking.
 *
 * Synchronous: the gated stream exists when it returns (none when the start
 * failed halfway), and its track stays the same object for the pipeline's
 * life. The audio-thread gate is attached
 * to this pipeline once its module has loaded (attachAudioThreadGate); until
 * then the page timer decides. A space call's gain starts closed, so nothing
 * passes ungated meanwhile; a direct call's starts open, as in the fallback,
 * so a load that is slow or never settles leaves the call heard (a peer
 * already holds this track).
 */
export function startSpeakingDetection(stream: MediaStream, mode: 'server' | 'dm' = 'server') {
  speakingMode = mode;
  stopSpeakingDetection();
  const generation = sdGeneration;

  try {
    sdContext = new AudioContext();
    sdAnalyser = sdContext.createAnalyser();
    sdAnalyser.fftSize = 2048;

    sdGainNode = sdContext.createGain();
    // Server SFU: closed until the timer opens it (gate audio to pause the
    // producer during silence, saves bandwidth). DM P2P: open, the timer's
    // gain gate is bypassed; the audio-thread gate gates once it takes over
    sdGainNode.gain.value = mode === 'dm' ? 1 : 0;
    sdDestination = sdContext.createMediaStreamDestination();

    sdSource = sdContext.createMediaStreamSource(stream);
  } catch (err) {
    console.warn('[SpeakingDetection] Failed to create AudioContext:', err);
    // What was built goes, its gated track stopped: getGatedStream() answers
    // null and every caller falls back to another stream (see there), never
    // to a destination nothing feeds
    stopSpeakingDetection();
    return;
  }

  if (sdContext.state === 'suspended') {
    const resuming = sdContext;
    resuming.resume().catch((err) => {
      // A rebuild that closed this context meanwhile is refused its pending
      // resume (Firefox does so): no news
      if (sdContext !== resuming || resuming.state === 'closed') return;
      console.warn('[SpeakingDetection] Failed to resume AudioContext:', err);
    });
  }

  // Pipeline: source → analyser → gain → destination (the gain gives way to
  // the audio-thread gate once it is attached)
  sdSource.connect(sdAnalyser);
  sdAnalyser.connect(sdGainNode);
  sdGainNode.connect(sdDestination);

  startTimerDecider();
  void attachAudioThreadGate(sdContext, generation);
  if (import.meta.env.DEV) {
    // Diagnostics surface for the Playwright run (the audio-thread gate, not
    // the fallback, decides) — DEV builds only
    (globalThis as { __voxSpeakingDecider?: () => string | null }).__voxSpeakingDecider = getSpeakingDecider;
    console.log('[SpeakingDetection] Started');
  }
}

/** The page-timer decider: the tick every 20 ms, on the analyser and the gain node. */
function startTimerDecider() {
  if (!sdAnalyser || tickInterval !== null) return;
  const dataArray = new Float32Array(sdAnalyser.fftSize);

  function tick() {
    const ctx = sdContext;
    if (!sdAnalyser || !sdGainNode || !ctx) return;
    if (detectionPaused) return;

    sdAnalyser.getFloatTimeDomainData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);

    const now = Date.now();
    // DM: the timer never gates (its gain stays open: a slowed timer in a
    // hidden page would silence the call); it only detects speaking
    const bypassGate = speakingMode === 'dm';

    if (rms > threshold) {
      silenceStart = 0;
      if (!bypassGate) {
        sdGainNode.gain.cancelScheduledValues(ctx.currentTime);
        sdGainNode.gain.linearRampToValueAtTime(1, ctx.currentTime + GAIN_RAMP_SEC);
      }
      if (!isSpeaking) {
        isSpeaking = true;
        emitSpeaking(true);
        speakingChangeCallback?.(true);
      }
    } else {
      if (isSpeaking) {
        if (silenceStart === 0) {
          silenceStart = now;
        } else if (now - silenceStart > SILENCE_DELAY_MS) {
          if (!bypassGate) {
            sdGainNode.gain.cancelScheduledValues(ctx.currentTime);
            sdGainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + GAIN_RAMP_SEC);
          }
          isSpeaking = false;
          emitSpeaking(false);
          speakingChangeCallback?.(false);
        }
      }
    }
  }

  tickInterval = setInterval(tick, TICK_INTERVAL_MS);
  sdDecider = 'timer';
}

function stopTimerDecider() {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The state the audio-thread gate starts in: the one the page holds now. */
function gateInit(): NoiseGateInit {
  return {
    threshold,
    paused: detectionPaused,
    // Handed over as it is: a speaking state the timer heard is kept, so the
    // hand-over itself changes nothing the others are told
    open: isSpeaking,
    pauseClosesGate: speakingMode !== 'dm',
  };
}

function sendToGate(command: NoiseGateCommand) {
  if (!gateNode) return;
  try {
    gateNode.port.postMessage(command);
  } catch (err) {
    console.warn(`[SpeakingDetection] Could not reach the audio-thread noise gate (${command.type}): ${errorMessage(err)}`);
  }
}

/**
 * Load the gate's module on this pipeline's context and hand the decision
 * over to it. Only for the pipeline that asked: a rebuild or a stop meanwhile
 * bumped the generation (and closed this context), and the late load then
 * touches nothing and says nothing. A failure leaves the timer deciding.
 */
async function attachAudioThreadGate(ctx: AudioContext, generation: number) {
  const current = () => generation === sdGeneration && ctx === sdContext;
  let node: AudioWorkletNode;
  try {
    if (!ctx.audioWorklet) throw new Error('this browser has no AudioWorklet');
    await ctx.audioWorklet.addModule(NoiseGateWorkletUrl);
    if (!current()) return;
    node = new AudioWorkletNode(ctx, NOISE_GATE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: gateInit(),
    });
  } catch (err) {
    if (!current()) return;
    fallBackToTimerGate(`could not be loaded (${errorMessage(err)})`);
    return;
  }
  handOverToAudioThread(node);
}

/**
 * The audio-thread gate takes over, in one task: the gate is connected where
 * the gain node was, feeding the same destination (the track a producer or a
 * peer may already hold stays the same), then the timer is stopped and the
 * gain node cut off. No tick can run inside the task, so there is one source
 * of "speaking" at a time, and the gate starts in the state the page holds
 * (gateInit). Its delay line starts empty: the audio from the hand-over on
 * leaves GATE_LOOKAHEAD_MS later, after that much silence when the gate
 * starts open (speaking) and gated by the rule when it starts closed. The
 * audio thread does not wait for this task: a render quantum (128 samples)
 * that runs after the gate is connected and before the gain node is cut off
 * passes through the gain node and enters the gate's delay line too; where
 * the gain and the gate are both open it is heard at once and again
 * GATE_LOOKAHEAD_MS later.
 */
function handOverToAudioThread(node: AudioWorkletNode) {
  const analyser = sdAnalyser;
  const gain = sdGainNode;
  const destination = sdDestination;
  if (!analyser || !gain || !destination) return;
  gateNode = node;
  node.onprocessorerror = (event) => handleGateFailure(node, event);
  node.port.onmessage = (event: MessageEvent) => handleGateReport(node, event);
  try {
    analyser.connect(node);
    node.connect(destination);
  } catch (err) {
    fallBackToTimerGate(`could not be connected (${errorMessage(err)})`);
    return;
  }
  stopTimerDecider();
  sdDecider = 'worklet';
  try {
    analyser.disconnect(gain);
  } catch (err) {
    console.warn('[SpeakingDetection] Gain gate disconnect error (already disconnected):', errorMessage(err));
  }
}

/** A change of the audio-thread gate's decision: what the tick does with one. */
function handleGateReport(node: AudioWorkletNode, event: MessageEvent) {
  if (node !== gateNode) return; // a pipeline replaced since
  const report = readNoiseGateReport(event.data);
  if (!report || report.speaking === isSpeaking) return;
  // Sent before the gate was told of the pause, which already ended speech
  if (report.speaking && detectionPaused) return;
  isSpeaking = report.speaking;
  silenceStart = 0;
  emitSpeaking(report.speaking);
  speakingChangeCallback?.(report.speaking);
}

/** The processor threw (its constructor, or later): the node is silent from now on. */
function handleGateFailure(node: AudioWorkletNode, event: Event) {
  if (node !== gateNode) return; // a pipeline replaced since
  fallBackToTimerGate(`failed (${describeProcessorError(event)})`);
}

function detachGateNode(node: AudioWorkletNode) {
  node.port.onmessage = null;
  node.onprocessorerror = null;
  try {
    node.port.postMessage({ type: 'stop' } satisfies NoiseGateCommand);
  } catch (err) {
    console.warn('[SpeakingDetection] Could not stop the audio-thread noise gate:', errorMessage(err));
  }
  try { node.disconnect(); } catch (err) {
    console.warn('[SpeakingDetection] Noise gate disconnect error (already disconnected):', errorMessage(err));
  }
}

/**
 * The audio-thread gate cannot run on this pipeline: the timer decides, on
 * the gain node, with one warning. A direct call keeps the timer's bypass
 * there (its gain open), a space call's gain follows the timer from the
 * state the page holds. The call goes on either way.
 */
function fallBackToTimerGate(reason: string) {
  if (!gateFailureWarned) {
    gateFailureWarned = true;
    console.warn(`[SpeakingDetection] The audio-thread noise gate ${reason}; the page timer decides`);
  }
  const node = gateNode;
  gateNode = null;
  const ctx = sdContext;
  const analyser = sdAnalyser;
  const gain = sdGainNode;
  if (!ctx || !analyser || !gain) return;
  if (node) {
    detachGateNode(node);
    try { analyser.disconnect(node); } catch (err) {
      console.warn('[SpeakingDetection] Noise gate input disconnect error (already disconnected):', errorMessage(err));
    }
    try { analyser.connect(gain); } catch (err) {
      console.warn('[SpeakingDetection] Could not put the gain gate back:', errorMessage(err));
    }
  }
  const timerRunning = tickInterval !== null;
  if (speakingMode === 'dm') {
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.value = 1;
  } else if (!timerRunning) {
    // The timer drove nothing while the gate decided: the gain takes the
    // state the page holds, and the timer's ticks move it from there
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.value = isSpeaking ? 1 : 0;
  }
  if (!timerRunning) silenceStart = 0;
  startTimerDecider();
}

export function stopSpeakingDetection() {
  sdGeneration++;
  stopTimerDecider();
  if (gateNode) {
    const node = gateNode;
    gateNode = null;
    detachGateNode(node);
  }
  sdDecider = null;
  gateFailureWarned = false;

  if (isSpeaking) {
    isSpeaking = false;
    emitSpeaking(false);
    speakingChangeCallback?.(false);
  }

  if (sdSource) { sdSource.disconnect(); sdSource = null; }

  if (sdContext) {
    sdContext.close().catch((err) => {
      console.warn('[SpeakingDetection] AudioContext close error:', err);
    });
    sdContext = null;
  }

  sdAnalyser = null;
  sdGainNode = null;
  // The gated track ends with its pipeline: the mic producer made from it
  // leaves it alone (stopTracks: false), so a transport restart can make the
  // next producer from the same pipeline
  stopDestinationTracks(sdDestination);
  sdDestination = null;
  silenceStart = 0;
  detectionPaused = false;
}
