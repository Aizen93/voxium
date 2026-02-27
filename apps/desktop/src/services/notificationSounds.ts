import { useSettingsStore } from '../stores/settingsStore';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

async function routeToOutputDevice(ctx: AudioContext): Promise<AudioNode> {
  const deviceId = useSettingsStore.getState().audioOutputDeviceId;
  if (deviceId && 'setSinkId' in ctx) {
    try {
      await (ctx as any).setSinkId(deviceId);
    } catch {
      // fall back to default output
    }
  }
  return ctx.destination;
}

function playTone(
  frequencies: Array<{ freq: number; duration: number }>,
  gain: number,
): void {
  try {
    const ctx = getAudioContext();
    ctx.resume();

    routeToOutputDevice(ctx).then((destination) => {
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
    });
  } catch {
    // ignore audio errors
  }
}

/** Ascending two-tone: 440Hz → 587Hz */
export function playJoinSound(): void {
  playTone(
    [
      { freq: 440, duration: 0.08 },
      { freq: 587, duration: 0.1 },
    ],
    0.3,
  );
}

/** Descending two-tone: 587Hz → 440Hz */
export function playLeaveSound(): void {
  playTone(
    [
      { freq: 587, duration: 0.08 },
      { freq: 440, duration: 0.1 },
    ],
    0.3,
  );
}

/** Single chime: 880Hz */
export function playMessageSound(): void {
  playTone([{ freq: 880, duration: 0.15 }], 0.2);
}

/** Ringtone: repeating ascending pattern */
export function playCallSound(): void {
  playTone(
    [
      { freq: 523, duration: 0.12 },
      { freq: 659, duration: 0.12 },
      { freq: 784, duration: 0.15 },
    ],
    0.35,
  );
}
