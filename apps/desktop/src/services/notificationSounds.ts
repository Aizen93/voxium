import { useSettingsStore } from '../stores/settingsStore';

let audioCtx: AudioContext | null = null;

/**
 * A sound that cannot play is recoverable (an autoplay refusal before the
 * first interaction, a missing output device), and a message or a ringtone
 * can fire many times a second or every two seconds: one warning per kind
 * of failure per session, naming the first sound it hit, never the error
 * object.
 */
type SoundFailureKind = 'resume' | 'output-device' | 'playback';
const reportedFailures = new Set<SoundFailureKind>();

function reportSoundError(kind: SoundFailureKind, sound: string, err: unknown): void {
  if (reportedFailures.has(kind)) return;
  reportedFailures.add(kind);
  const reason = kind === 'resume'
    ? 'the audio context could not be resumed'
    : kind === 'output-device'
      ? 'the chosen output device could not be used, the default output plays instead'
      : 'the sound could not be played';
  console.warn(
    `[Sounds] ${sound}: ${reason} (further failures of this kind are not logged):`,
    err instanceof Error ? err.message : String(err),
  );
}

/** Fire-and-forget: resume rejects when the user has not interacted yet. */
function resumeContext(ctx: AudioContext, sound: string): void {
  ctx.resume().catch((err: unknown) => reportSoundError('resume', sound, err));
}

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function isTacticalTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'tactical';
}

async function routeToOutputDevice(ctx: AudioContext, sound: string): Promise<AudioNode> {
  const deviceId = useSettingsStore.getState().audioOutputDeviceId;
  if (deviceId && 'setSinkId' in ctx) {
    try {
      await (ctx as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
    } catch (err) {
      // fall back to the default output
      reportSoundError('output-device', sound, err);
    }
  }
  return ctx.destination;
}

function playTone(
  frequencies: Array<{ freq: number; duration: number }>,
  gain: number,
  sound: string,
): void {
  try {
    const ctx = getAudioContext();
    // Fire-and-forget: resume may reject if user hasn't interacted yet
    resumeContext(ctx, sound);

    routeToOutputDevice(ctx, sound).then((destination) => {
      const gainNode = ctx.createGain();
      gainNode.connect(destination);

      let offset = ctx.currentTime;
      const totalDuration = frequencies.reduce((sum, f) => sum + f.duration, 0);

      for (const { freq, duration } of frequencies) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gainNode);
        osc.start(offset);
        osc.stop(offset + duration);
        offset += duration;
      }

      gainNode.gain.setValueAtTime(gain, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + totalDuration);
    }).catch((err) => reportSoundError('playback', sound, err));
  } catch (err) {
    reportSoundError('playback', sound, err);
  }
}

// ─── Tactical Sound Pack ─────────────────────────────────────────────────────
// Military/radio-inspired sounds using square waves, white noise bursts,
// and sharp envelopes for a walkie-talkie feel.

/** Short white noise burst — radio static click */
function playTacticalNoiseBurst(durationMs: number, gain: number): void {
  try {
    const ctx = getAudioContext();
    resumeContext(ctx, 'tactical-noise-burst');

    routeToOutputDevice(ctx, 'tactical-noise-burst').then((destination) => {
      const duration = durationMs / 1000;
      const bufferSize = Math.ceil(ctx.sampleRate * duration);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1);
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      // Bandpass filter to shape the noise into a radio-like burst
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 2000;
      filter.Q.value = 1.5;

      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(gain, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

      source.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(destination);
      source.start(ctx.currentTime);
      source.stop(ctx.currentTime + duration);
    }).catch((err) => reportSoundError('playback', 'tactical-noise-burst', err));
  } catch (err) {
    reportSoundError('playback', 'tactical-noise-burst', err);
  }
}

/** Tactical message: short radio click (noise burst + quick square-wave pip) */
function playTacticalMessageSound(): void {
  playTacticalNoiseBurst(40, 0.08);
  try {
    const ctx = getAudioContext();
    resumeContext(ctx, 'tactical-message');

    routeToOutputDevice(ctx, 'tactical-message').then((destination) => {
      const gainNode = ctx.createGain();
      gainNode.connect(destination);

      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 1200;
      osc.connect(gainNode);

      const now = ctx.currentTime;
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.12, now + 0.005);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

      osc.start(now + 0.02);
      osc.stop(now + 0.08);
    }).catch((err) => reportSoundError('playback', 'tactical-message', err));
  } catch (err) {
    reportSoundError('playback', 'tactical-message', err);
  }
}

/** Tactical join: radio-on chirp (ascending square-wave sweep) */
function playTacticalJoinSound(): void {
  playTacticalNoiseBurst(30, 0.06);
  try {
    const ctx = getAudioContext();
    resumeContext(ctx, 'tactical-join');

    routeToOutputDevice(ctx, 'tactical-join').then((destination) => {
      const gainNode = ctx.createGain();
      gainNode.connect(destination);

      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.connect(gainNode);

      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(600, now + 0.015);
      osc.frequency.linearRampToValueAtTime(1400, now + 0.09);

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.15, now + 0.02);
      gainNode.gain.setValueAtTime(0.15, now + 0.07);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.start(now + 0.015);
      osc.stop(now + 0.13);
    }).catch((err) => reportSoundError('playback', 'tactical-join', err));
  } catch (err) {
    reportSoundError('playback', 'tactical-join', err);
  }
}

/** Tactical leave: radio-off tone (descending square-wave sweep) */
function playTacticalLeaveSound(): void {
  try {
    const ctx = getAudioContext();
    resumeContext(ctx, 'tactical-leave');

    routeToOutputDevice(ctx, 'tactical-leave').then((destination) => {
      const gainNode = ctx.createGain();
      gainNode.connect(destination);

      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.connect(gainNode);

      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(1200, now);
      osc.frequency.linearRampToValueAtTime(400, now + 0.1);

      gainNode.gain.setValueAtTime(0.15, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.start(now);
      osc.stop(now + 0.13);
    }).catch((err) => reportSoundError('playback', 'tactical-leave', err));
  } catch (err) {
    reportSoundError('playback', 'tactical-leave', err);
  }
  playTacticalNoiseBurst(25, 0.05);
}

/** Tactical mention: two rapid priority beeps (urgent alert) */
function playTacticalMentionSound(): void {
  try {
    const ctx = getAudioContext();
    resumeContext(ctx, 'tactical-mention');

    routeToOutputDevice(ctx, 'tactical-mention').then((destination) => {
      const gainNode = ctx.createGain();
      gainNode.connect(destination);

      const now = ctx.currentTime;

      // First beep
      const osc1 = ctx.createOscillator();
      osc1.type = 'square';
      osc1.frequency.value = 1500;
      osc1.connect(gainNode);
      osc1.start(now);
      osc1.stop(now + 0.06);

      // Second beep (slightly higher)
      const osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = 1800;
      osc2.connect(gainNode);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.18);

      gainNode.gain.setValueAtTime(0.18, now);
      gainNode.gain.setValueAtTime(0.001, now + 0.065);
      gainNode.gain.setValueAtTime(0.2, now + 0.1);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    }).catch((err) => reportSoundError('playback', 'tactical-mention', err));
  } catch (err) {
    reportSoundError('playback', 'tactical-mention', err);
  }
}

/** Tactical call chime: urgent repeating alert (three staccato beeps) */
function playTacticalCallChime(): void {
  try {
    const ctx = getAudioContext();
    resumeContext(ctx, 'tactical-call-chime');

    routeToOutputDevice(ctx, 'tactical-call-chime').then((destination) => {
      const gainNode = ctx.createGain();
      gainNode.connect(destination);

      const now = ctx.currentTime;
      const beeps = [
        { freq: 1000, start: 0, end: 0.06 },
        { freq: 1000, start: 0.1, end: 0.16 },
        { freq: 1400, start: 0.2, end: 0.3 },
      ];

      for (const beep of beeps) {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = beep.freq;
        osc.connect(gainNode);
        osc.start(now + beep.start);
        osc.stop(now + beep.end);
      }

      gainNode.gain.setValueAtTime(0.18, now);
      gainNode.gain.setValueAtTime(0.001, now + 0.065);
      gainNode.gain.setValueAtTime(0.18, now + 0.1);
      gainNode.gain.setValueAtTime(0.001, now + 0.165);
      gainNode.gain.setValueAtTime(0.2, now + 0.2);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    }).catch((err) => reportSoundError('playback', 'tactical-call-chime', err));
  } catch (err) {
    reportSoundError('playback', 'tactical-call-chime', err);
  }
}

// ─── Public Sound API ────────────────────────────────────────────────────────
// Each function checks the active theme and dispatches to the matching sound pack.

/** Ascending two-tone: 440Hz → 587Hz (default) | Radio-on chirp (tactical) */
export function playJoinSound(): void {
  if (isTacticalTheme()) {
    playTacticalJoinSound();
    return;
  }
  playTone(
    [
      { freq: 440, duration: 0.08 },
      { freq: 587, duration: 0.1 },
    ], 0.3, 'join');
}

/** Descending two-tone: 587Hz → 440Hz (default) | Radio-off sweep (tactical) */
export function playLeaveSound(): void {
  if (isTacticalTheme()) {
    playTacticalLeaveSound();
    return;
  }
  playTone(
    [
      { freq: 587, duration: 0.08 },
      { freq: 440, duration: 0.1 },
    ], 0.3, 'leave');
}

/** Single chime: 880Hz (default) | Radio click (tactical) */
export function playMessageSound(): void {
  if (isTacticalTheme()) {
    playTacticalMessageSound();
    return;
  }
  playTone([{ freq: 880, duration: 0.15 }], 0.2, 'message');
}

/** Double-chime for @mention (default) | Two rapid priority beeps (tactical) */
export function playMentionSound(): void {
  if (isTacticalTheme()) {
    playTacticalMentionSound();
    return;
  }
  playTone(
    [
      { freq: 880, duration: 0.1 },
      { freq: 1047, duration: 0.15 },
    ], 0.35, 'mention');
}

/** Single call chime (used internally by the ringtone loop) */
function playCallChime(): void {
  if (isTacticalTheme()) {
    playTacticalCallChime();
    return;
  }
  playTone(
    [
      { freq: 523, duration: 0.12 },
      { freq: 659, duration: 0.12 },
      { freq: 784, duration: 0.15 },
    ], 0.35, 'call');
}

let callRingtoneInterval: ReturnType<typeof setInterval> | null = null;

/** Start a looping ringtone that plays until stopCallRingtone() is called */
export function startCallRingtone(): void {
  stopCallRingtone();
  playCallChime();
  callRingtoneInterval = setInterval(playCallChime, 2000);
}

/** Stop the looping ringtone */
export function stopCallRingtone(): void {
  if (callRingtoneInterval !== null) {
    clearInterval(callRingtoneInterval);
    callRingtoneInterval = null;
  }
}
