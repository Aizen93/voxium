import { getSocket } from './socket';
import { NoiseSuppressorWorklet_Name } from '@timephy/rnnoise-wasm';
import NoiseSuppressorWorkletUrl from '@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url';

let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let gainNode: GainNode | null = null;
let destinationNode: MediaStreamAudioDestinationNode | null = null;
let rnnoiseNode: AudioWorkletNode | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let isSpeaking = false;
let silenceStart = 0;
let currentLevel = 0;

const SILENCE_DELAY_MS = 300;
const TICK_INTERVAL_MS = 20; // 50 checks/sec — won't be throttled in background like rAF
let threshold = 0.008;
let speakingMode: 'server' | 'dm' = 'server';

function emitSpeaking(speaking: boolean) {
  const socket = getSocket();
  if (!socket) return;
  if (speakingMode === 'dm') {
    socket.emit('dm:voice:speaking', speaking);
  } else {
    socket.emit('voice:speaking', speaking);
  }
}

let noiseSuppEnabled = true;
let speakingChangeCallback: ((speaking: boolean) => void) | null = null;

export function setNoiseGateThreshold(value: number) {
  threshold = value;
}

/** Register a callback invoked whenever local speaking state changes (for producer pause/resume). */
export function onSpeakingChange(cb: ((speaking: boolean) => void) | null) {
  speakingChangeCallback = cb;
}

export function getAudioLevel(): number {
  return currentLevel;
}

/**
 * Returns the noise-suppressed + noise-gated MediaStream for WebRTC.
 * Pipeline: mic → [RNNoise ML] → analyser → gain gate → destination
 */
export function getGatedStream(): MediaStream | null {
  return destinationNode?.stream ?? null;
}

/** Rebuild the audio graph connections based on current noise suppression state. */
function rebuildPipeline() {
  if (!sourceNode || !analyserNode || !gainNode || !destinationNode) return;

  // Disconnect all nodes from their outputs
  try { sourceNode.disconnect(); } catch { /* already disconnected */ }
  if (rnnoiseNode) {
    try { rnnoiseNode.disconnect(); } catch { /* already disconnected */ }
  }
  try { analyserNode.disconnect(); } catch { /* already disconnected */ }
  try { gainNode.disconnect(); } catch { /* already disconnected */ }

  // Rebuild pipeline
  if (noiseSuppEnabled && rnnoiseNode) {
    // ML pipeline: source → RNNoise → analyser → gain → destination
    sourceNode.connect(rnnoiseNode);
    rnnoiseNode.connect(analyserNode);
  } else {
    // Basic pipeline: source → analyser → gain → destination
    sourceNode.connect(analyserNode);
  }
  analyserNode.connect(gainNode);
  gainNode.connect(destinationNode);
}

/** Toggle ML noise suppression on/off while the pipeline is running. */
export function setNoiseSuppression(enabled: boolean) {
  noiseSuppEnabled = enabled;

  if (!sourceNode || !analyserNode || !audioContext) return;

  if (enabled && !rnnoiseNode) {
    // Need to load the worklet first
    loadRNNoiseWorklet(audioContext).then((node) => {
      if (node && sourceNode && analyserNode) {
        rnnoiseNode = node;
        rebuildPipeline();
        if (import.meta.env.DEV) console.log('[AudioAnalyser] RNNoise enabled (late load)');
      }
    });
    return;
  }

  rebuildPipeline();
  if (import.meta.env.DEV) console.log(`[AudioAnalyser] Noise suppression ${enabled ? 'enabled' : 'disabled'}`);
}

/** Load the RNNoise AudioWorklet module into the given AudioContext. */
async function loadRNNoiseWorklet(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  try {
    await ctx.audioWorklet.addModule(NoiseSuppressorWorkletUrl);
    const node = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name);
    if (import.meta.env.DEV) console.log('[AudioAnalyser] RNNoise WASM worklet loaded');
    return node;
  } catch (err) {
    console.warn('[AudioAnalyser] Failed to load RNNoise worklet — falling back to basic noise gate:', err);
    return null;
  }
}

export function startSpeakingDetection(stream: MediaStream, mode: 'server' | 'dm' = 'server') {
  speakingMode = mode;
  stopSpeakingDetection();

  try {
    audioContext = new AudioContext();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;

    gainNode = audioContext.createGain();
    gainNode.gain.value = 0; // start gated (silent) until speech detected
    destinationNode = audioContext.createMediaStreamDestination();

    sourceNode = audioContext.createMediaStreamSource(stream);
  } catch (err) {
    console.warn('[AudioAnalyser] Failed to create AudioContext:', err);
    return;
  }

  // Build the initial pipeline (source → analyser → gain → destination)
  // RNNoise will be inserted asynchronously once the worklet loads
  rebuildPipeline();

  // Asynchronously load and insert RNNoise ML noise suppression
  if (noiseSuppEnabled) {
    const ctx = audioContext; // capture reference
    loadRNNoiseWorklet(ctx).then((node) => {
      // Verify the pipeline is still alive (user may have left the call)
      if (node && sourceNode && analyserNode && audioContext === ctx) {
        rnnoiseNode = node;
        rebuildPipeline();
      } else if (node) {
        // Pipeline was torn down while loading — clean up the orphaned node
        try { node.disconnect(); } catch { /* noop */ }
      }
    });
  }

  const dataArray = new Float32Array(analyserNode.fftSize);

  function tick() {
    if (!analyserNode || !gainNode) return;

    analyserNode.getFloatTimeDomainData(dataArray);

    // Compute RMS
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);
    currentLevel = Math.min(rms / 0.15, 1); // normalize to 0-1 range

    const now = Date.now();

    if (rms > threshold) {
      silenceStart = 0;
      // Open the noise gate — let audio through
      gainNode.gain.value = 1;
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
          // Close the noise gate — send silence
          gainNode.gain.value = 0;
          isSpeaking = false;
          emitSpeaking(false);
          speakingChangeCallback?.(false);
        }
        // While debouncing, keep gate open so speech tail isn't clipped
      }
    }
  }

  // Use setInterval instead of requestAnimationFrame so it runs even when
  // the tab/window is in the background (rAF is throttled/paused)
  tickInterval = setInterval(tick, TICK_INTERVAL_MS);
  if (import.meta.env.DEV) console.log('[AudioAnalyser] Speaking detection started');
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

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (rnnoiseNode) {
    try { rnnoiseNode.disconnect(); } catch { /* noop */ }
    rnnoiseNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  analyserNode = null;
  gainNode = null;
  destinationNode = null;
  currentLevel = 0;
  silenceStart = 0;
}
