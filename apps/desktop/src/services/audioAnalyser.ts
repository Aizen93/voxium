import { getSocket } from './socket';
import { NoiseSuppressorWorklet_Name } from '@timephy/rnnoise-wasm';
import NoiseSuppressorWorkletUrl from '@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url';

// ─── Noise Suppression Effect (Jitsi/Matrix pattern) ─────────────────────────
//
// Clean, isolated pipeline: source → RNNoise AudioWorklet → destination
// No analyser, no gain gate — just noise suppression.
// The processed track replaces the original mic track on WebRTC connections.

let nsContext: AudioContext | null = null;
let nsSource: MediaStreamAudioSourceNode | null = null;
let nsWorklet: AudioWorkletNode | null = null;
let nsDestination: MediaStreamAudioDestinationNode | null = null;

/** Whether noise suppression is enabled (user setting). */
let noiseSuppEnabled = true;

export function setNoiseSuppression(enabled: boolean) {
  noiseSuppEnabled = enabled;
}

/**
 * Apply RNNoise noise suppression to a mic stream.
 * Returns the processed stream, or the original stream if suppression is
 * disabled or the worklet fails to load.
 *
 * This follows the Jitsi/Matrix pattern: a dedicated AudioContext with
 * source → NoiseSuppressorWorklet → destination. Nothing else in the path.
 */
export async function applyNoiseSuppression(micStream: MediaStream): Promise<MediaStream> {
  // Clean up any previous suppression context
  stopNoiseSuppression();

  if (!noiseSuppEnabled) return micStream;

  try {
    // RNNoise is trained on 48kHz audio — force this sample rate
    // to avoid silent/distorted output on systems defaulting to 44100Hz
    nsContext = new AudioContext({ sampleRate: 48000 });

    if (nsContext.state === 'suspended') {
      await nsContext.resume();
    }

    await nsContext.audioWorklet.addModule(NoiseSuppressorWorkletUrl);
    nsWorklet = new AudioWorkletNode(nsContext, NoiseSuppressorWorklet_Name);

    nsSource = nsContext.createMediaStreamSource(micStream);
    nsDestination = nsContext.createMediaStreamDestination();

    // Clean pipeline: source → RNNoise → destination
    nsSource.connect(nsWorklet);
    nsWorklet.connect(nsDestination);

    if (import.meta.env.DEV) console.log('[NoiseSuppression] RNNoise pipeline active');
    return nsDestination.stream;
  } catch (err) {
    console.warn('[NoiseSuppression] Failed to load RNNoise worklet, using raw mic:', err);
    stopNoiseSuppression();
    return micStream;
  }
}

/** Returns the noise-suppressed stream if active, or null. */
export function getSuppressedStream(): MediaStream | null {
  return nsDestination?.stream ?? null;
}

/** Tear down the noise suppression pipeline. */
export function stopNoiseSuppression() {
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
  nsDestination = null;
  if (nsContext) {
    nsContext.close().catch((err) => {
      console.warn('[NoiseSuppression] AudioContext close error:', err);
    });
    nsContext = null;
  }
}

// ─── Speaking Detection (separate from noise suppression) ────────────────────
//
// Taps into the (already processed) stream via an AnalyserNode to detect
// speaking state. This is a read-only side-chain — it doesn't alter audio.
// The gain gate (for SFU producer pause/resume) operates independently.

let sdContext: AudioContext | null = null;
let sdSource: MediaStreamAudioSourceNode | null = null;
let sdAnalyser: AnalyserNode | null = null;
let sdGainNode: GainNode | null = null;
let sdDestination: MediaStreamAudioDestinationNode | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let isSpeaking = false;
let silenceStart = 0;
let currentLevel = 0;

const SILENCE_DELAY_MS = 300;
const TICK_INTERVAL_MS = 20;
const GAIN_RAMP_SEC = 0.03;
let threshold = 0.008;
let speakingMode: 'server' | 'dm' = 'server';
let speakingChangeCallback: ((speaking: boolean) => void) | null = null;

/** When true, tick skips analyser processing (e.g. user is muted). */
let detectionPaused = false;

export function setNoiseGateThreshold(value: number) {
  threshold = value;
}

export function onSpeakingChange(cb: ((speaking: boolean) => void) | null) {
  speakingChangeCallback = cb;
}

/**
 * Pause or resume the speaking detection analyser tick.
 * When paused, the interval still fires but skips all processing — no
 * getFloatTimeDomainData, no RMS calculation, no socket emissions.
 */
export function setSpeakingDetectionPaused(paused: boolean) {
  detectionPaused = paused;
}

export function getAudioLevel(): number {
  return currentLevel;
}

/**
 * Returns the noise-gated stream for SFU producer use.
 * For SFU: the gain gate silences audio when not speaking (saves bandwidth).
 * For DM P2P: not used — DM uses the suppressed stream directly.
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
 * Start speaking detection on a stream (should be the noise-suppressed stream).
 * For SFU mode: also applies a gain gate (silence when not speaking).
 * For DM mode: gain gate bypassed — only detects speaking state.
 */
export function startSpeakingDetection(stream: MediaStream, mode: 'server' | 'dm' = 'server') {
  speakingMode = mode;
  stopSpeakingDetection();

  try {
    sdContext = new AudioContext();
    sdAnalyser = sdContext.createAnalyser();
    sdAnalyser.fftSize = 2048;

    sdGainNode = sdContext.createGain();
    // DM P2P: bypass gain gate (DM uses the suppressed stream directly, not the gated one).
    // Server SFU: gate audio to pause producer during silence (saves bandwidth).
    sdGainNode.gain.value = mode === 'dm' ? 1.0 : 0;
    sdDestination = sdContext.createMediaStreamDestination();

    sdSource = sdContext.createMediaStreamSource(stream);
  } catch (err) {
    console.warn('[SpeakingDetection] Failed to create AudioContext:', err);
    return;
  }

  if (sdContext.state === 'suspended') {
    sdContext.resume().catch((err) => {
      console.warn('[SpeakingDetection] Failed to resume AudioContext:', err);
    });
  }

  // Pipeline: source → analyser → gain → destination
  sdSource.connect(sdAnalyser);
  sdAnalyser.connect(sdGainNode);
  sdGainNode.connect(sdDestination);

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
    currentLevel = Math.min(rms / 0.15, 1);

    const now = Date.now();
    // DM: never gate (audio goes directly via suppressed stream, not through this gate)
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
  if (import.meta.env.DEV) console.log('[SpeakingDetection] Started');
}

export function stopSpeakingDetection() {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }

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
  sdDestination = null;
  currentLevel = 0;
  silenceStart = 0;
  detectionPaused = false;
}
