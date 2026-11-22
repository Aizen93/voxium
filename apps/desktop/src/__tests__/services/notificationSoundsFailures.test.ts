import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A sound that cannot play is recoverable and must say why, once per kind of
 * failure per session: a message sound can fire many times a second and the
 * ringtone every two seconds, so the console must not flood.
 */

type Behaviour = { resume: () => Promise<void>; setSinkId?: (id: string) => Promise<void> };
let behaviour: Behaviour;

class FakeContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  constructor() {
    if (behaviour.setSinkId) (this as unknown as { setSinkId: unknown }).setSinkId = behaviour.setSinkId;
  }
  resume() { return behaviour.resume(); }
  createGain() {
    return { connect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } };
  }
  createOscillator() {
    return { type: '', frequency: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  }
}

async function load(deviceId = '') {
  vi.resetModules();
  const { useSettingsStore } = await import('../../stores/settingsStore');
  useSettingsStore.setState({ audioOutputDeviceId: deviceId });
  return import('../../services/notificationSounds');
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('notificationSounds: failures are reported, once per kind', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    behaviour = { resume: () => Promise.resolve() };
    vi.stubGlobal('AudioContext', FakeContext);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  it('says nothing when everything works', async () => {
    const sounds = await load();
    sounds.playMessageSound();
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the message and the sound when the context cannot resume', async () => {
    behaviour.resume = () => Promise.reject(new Error('NotAllowedError: autoplay'));
    const sounds = await load();
    sounds.playMessageSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain('tone');
    expect(line).toContain('NotAllowedError: autoplay');
    expect(warn.mock.calls[0].some((a: unknown) => a instanceof Error)).toBe(false);
  });

  it('logs a repeated failure once, not once per sound', async () => {
    behaviour.resume = () => Promise.reject(new Error('refused'));
    const sounds = await load();
    for (let i = 0; i < 5; i++) sounds.playMessageSound();
    sounds.playJoinSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns when the chosen output device cannot be used and still plays', async () => {
    behaviour.setSinkId = () => Promise.reject(new Error('device gone'));
    const sounds = await load('dev-1');
    sounds.playMessageSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('device gone');
  });

  it('warns when the context cannot even be created', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('no audio here'); } });
    const sounds = await load();
    sounds.playMessageSound();
    document.documentElement.setAttribute('data-theme', 'tactical');
    sounds.playMentionSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('no audio here');
  });

  it('reports a playback that fails after the routing (a node that throws)', async () => {
    document.documentElement.setAttribute('data-theme', 'tactical');
    class Broken extends FakeContext {
      createOscillator(): never { throw new Error('bad oscillator'); }
    }
    vi.stubGlobal('AudioContext', Broken);
    const sounds = await load();
    sounds.playMentionSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('bad oscillator');
  });
});
