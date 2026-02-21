import { getSocket } from './socket';

let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let animFrameId: number | null = null;
let isSpeaking = false;
let silenceStart = 0;
let currentLevel = 0;

const SILENCE_DELAY_MS = 300;
let threshold = 0.015;

export function setNoiseGateThreshold(value: number) {
  threshold = value;
}

export function getAudioLevel(): number {
  return currentLevel;
}

export function startSpeakingDetection(stream: MediaStream) {
  stopSpeakingDetection();

  try {
    audioContext = new AudioContext();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(analyserNode);
  } catch (err) {
    console.warn('[AudioAnalyser] Failed to create AudioContext:', err);
    return;
  }

  const dataArray = new Float32Array(analyserNode.fftSize);

  function tick() {
    if (!analyserNode) return;

    analyserNode.getFloatTimeDomainData(dataArray);

    // Compute RMS
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);
    currentLevel = Math.min(rms / 0.15, 1); // normalize to 0-1 range

    const now = Date.now();
    const socket = getSocket();

    if (rms > threshold) {
      silenceStart = 0;
      if (!isSpeaking) {
        isSpeaking = true;
        socket?.emit('voice:speaking', true);
      }
    } else {
      if (isSpeaking) {
        if (silenceStart === 0) {
          silenceStart = now;
        } else if (now - silenceStart > SILENCE_DELAY_MS) {
          isSpeaking = false;
          socket?.emit('voice:speaking', false);
        }
      }
    }

    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);
  console.log('[AudioAnalyser] Speaking detection started');
}

export function stopSpeakingDetection() {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  if (isSpeaking) {
    isSpeaking = false;
    const socket = getSocket();
    socket?.emit('voice:speaking', false);
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  analyserNode = null;
  currentLevel = 0;
  silenceStart = 0;
}
