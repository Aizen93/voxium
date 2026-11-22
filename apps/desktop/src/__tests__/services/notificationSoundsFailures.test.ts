import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A sound that cannot play is recoverable and must say why, once per kind of
 * failure per session (never once per sound): a message sound can fire many
 * times a second and the ringtone every two seconds, so the console must not
 * flood. The warning names the sound that failed and carries the error's
 * message, never the error object.
 */

interface Behaviour {
  resume: () => Promise<void>;
  setSinkId?: (id: string) => Promise<void>;
  /** 1-based number of the resume call that throws at once (0: none) */
  throwOnResumeCall: number;
  failNode?: 'createOscillator' | 'createBufferSource';
}
let behaviour: Behaviour;
let resumeCalls: number;

const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });

class FakeContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  constructor() {
    if (behaviour.setSinkId) (this as unknown as { setSinkId: unknown }).setSinkId = behaviour.setSinkId;
  }
  resume() {
    resumeCalls++;
    if (behaviour.throwOnResumeCall === resumeCalls) throw new Error('resume threw');
    return behaviour.resume();
  }
  createGain() { return { connect: vi.fn(), gain: param() }; }
  createOscillator() {
    if (behaviour.failNode === 'createOscillator') throw new Error('bad oscillator');
    return { type: '', frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  }
  createBuffer(_c: number, size: number) { return { getChannelData: () => new Float32Array(size) }; }
  createBufferSource() {
    if (behaviour.failNode === 'createBufferSource') throw new Error('bad buffer source');
    return { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  }
  createBiquadFilter() { return { type: '', frequency: param(), Q: param(), connect: vi.fn() }; }
}

async function load(deviceId = '') {
  vi.resetModules();
  const { useSettingsStore } = await import('../../stores/settingsStore');
  useSettingsStore.setState({ audioOutputDeviceId: deviceId });
  return import('../../services/notificationSounds');
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('notificationSounds: failures are reported, once per kind', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const lines = () => warn.mock.calls.map((c: unknown[]) => c.join(' '));
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    behaviour = { resume: () => Promise.resolve(), throwOnResumeCall: 0 };
    resumeCalls = 0;
    vi.stubGlobal('AudioContext', FakeContext);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  it('says nothing when everything works, in both packs', async () => {
    const sounds = await load();
    sounds.playMessageSound();
    document.documentElement.setAttribute('data-theme', 'tactical');
    sounds.playMessageSound();
    sounds.playJoinSound();
    sounds.playLeaveSound();
    sounds.playMentionSound();
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the sound and the message when the context cannot resume, not the error object', async () => {
    behaviour.resume = () => Promise.reject(new Error('NotAllowedError: autoplay'));
    const sounds = await load();
    sounds.playMessageSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('message');
    expect(lines()[0]).toContain('NotAllowedError: autoplay');
    expect(warn.mock.calls[0].some((a: unknown) => a instanceof Error)).toBe(false);
  });

  it('logs one kind once even when two differently named sounds hit it', async () => {
    behaviour.resume = () => Promise.reject(new Error('refused'));
    const sounds = await load();
    sounds.playMessageSound();
    sounds.playJoinSound();
    sounds.playMentionSound();
    sounds.playMessageSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('message');
  });

  it('keeps the kinds apart: a resume refusal does not hide a playback failure', async () => {
    behaviour.resume = () => Promise.reject(new Error('refused'));
    behaviour.failNode = 'createOscillator';
    const sounds = await load();
    sounds.playMessageSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(lines().join('\n')).toContain('refused');
    expect(lines().join('\n')).toContain('bad oscillator');
  });

  it('names the sound when the chosen output device cannot be used, and still plays', async () => {
    behaviour.setSinkId = () => Promise.reject(new Error('device gone'));
    const sounds = await load('dev-1');
    sounds.playJoinSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('join');
    expect(lines()[0]).toContain('device gone');
  });

  // Each catch alone: the only failure of its session, so the once-guard starts empty.
  // resumeCall = which resume call of the sound's own try throws (a tactical
  // message, join and leave play a noise burst, which resumes too, before or after)
  const SOUNDS = [
    { name: 'tone', play: 'playMessageSound', tactical: false, resumeCall: 1 },
    { name: 'tactical-message', play: 'playMessageSound', tactical: true, resumeCall: 2 },
    { name: 'tactical-join', play: 'playJoinSound', tactical: true, resumeCall: 2 },
    { name: 'tactical-leave', play: 'playLeaveSound', tactical: true, resumeCall: 1 },
    { name: 'tactical-mention', play: 'playMentionSound', tactical: true, resumeCall: 1 },
  ] as const;

  it.each(SOUNDS)('$name: a throw inside its try is reported under its own name', async ({ name, play, tactical, resumeCall }) => {
    behaviour.throwOnResumeCall = resumeCall;
    const sounds = await load();
    if (tactical) document.documentElement.setAttribute('data-theme', 'tactical');
    sounds[play]();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('resume threw');
    expect(lines()[0]).toContain(name === 'tone' ? 'message' : name);
  });

  it.each(SOUNDS)('$name: a failure after the routing is reported under its own name', async ({ name, play, tactical }) => {
    behaviour.failNode = 'createOscillator';
    const sounds = await load();
    if (tactical) document.documentElement.setAttribute('data-theme', 'tactical');
    sounds[play]();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('bad oscillator');
    expect(lines()[0]).toContain(name === 'tone' ? 'message' : name);
  });

  it('the tactical call chime (the ringtone) reports a failure after the routing and a throw in its try', async () => {
    behaviour.failNode = 'createOscillator';
    let sounds = await load();
    document.documentElement.setAttribute('data-theme', 'tactical');
    sounds.startCallRingtone();
    sounds.stopCallRingtone();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('tactical-call-chime');
    expect(lines()[0]).toContain('bad oscillator');

    warn.mockClear();
    behaviour = { resume: () => Promise.resolve(), throwOnResumeCall: 1 };
    resumeCalls = 0;
    sounds = await load();
    document.documentElement.setAttribute('data-theme', 'tactical');
    sounds.startCallRingtone();
    sounds.stopCallRingtone();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('tactical-call-chime');
    expect(lines()[0]).toContain('resume threw');
  });

  it('the default call chime and the tactical noise burst name themselves', async () => {
    behaviour.failNode = 'createOscillator';
    let sounds = await load();
    sounds.startCallRingtone();
    sounds.stopCallRingtone();
    await flush();
    expect(lines()[0]).toContain('call');

    warn.mockClear();
    behaviour = { resume: () => Promise.resolve(), throwOnResumeCall: 0, failNode: 'createBufferSource' };
    sounds = await load();
    document.documentElement.setAttribute('data-theme', 'tactical');
    sounds.playMessageSound();
    await flush();
    expect(lines()[0]).toContain('tactical-noise-burst');
    expect(lines()[0]).toContain('bad buffer source');
  });

  it('warns when the context cannot even be created', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('no audio here'); } });
    const sounds = await load();
    sounds.playMessageSound();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('no audio here');
  });
});
