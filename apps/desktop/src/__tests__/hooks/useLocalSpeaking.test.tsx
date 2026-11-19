import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Whether the local microphone is above the speaking level, for the DM call
 * panels' ring. The level changes every 20 ms; the hook reads it once a frame
 * and sets state only when the answer flips, and runs no frame loop at all
 * while disabled.
 */

const audio = vi.hoisted(() => ({ level: 0 }));
vi.mock('../../services/audioAnalyser', () => ({ getAudioLevel: () => audio.level }));

import { useLocalSpeaking, LOCAL_SPEAKING_LEVEL } from '../../hooks/useLocalSpeaking';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const requestFrame = vi.fn((cb: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, cb); return id; });
const cancelFrame = vi.fn((id: number) => { frames.delete(id); });
vi.stubGlobal('requestAnimationFrame', requestFrame);
vi.stubGlobal('cancelAnimationFrame', cancelFrame);

function playFrames(count: number, levels: (i: number) => number) {
  for (let i = 0; i < count; i++) {
    audio.level = levels(i);
    act(() => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(i * 16);
    });
  }
}

let renders = 0;
let latest: boolean | undefined;
function Probe({ enabled }: { enabled: boolean }) {
  renders++;
  latest = useLocalSpeaking(enabled);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const render = (enabled: boolean) => act(() => { root.render(<Probe enabled={enabled} />); });

beforeEach(() => {
  frames.clear();
  requestFrame.mockClear();
  cancelFrame.mockClear();
  renders = 0;
  latest = undefined;
  audio.level = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useLocalSpeaking', () => {
  it('the threshold is the one the panels used (a level above 0.05 lights the ring)', () => {
    expect(LOCAL_SPEAKING_LEVEL).toBe(0.05);
  });

  it('disabled: no frame loop and false, whatever the level does', () => {
    render(false);
    playFrames(30, () => 0.9);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(latest).toBe(false);
    expect(renders).toBe(1);
  });

  it('enabled: true above the level, false below, rendering only on each flip', () => {
    render(true);
    expect(latest).toBe(false);
    playFrames(40, (i) => 0.06 + (i % 7) / 100);
    expect(latest).toBe(true);
    expect(renders).toBe(2);
    playFrames(40, (i) => (i % 5) / 1000);
    expect(latest).toBe(false);
    expect(renders).toBe(3);
    playFrames(1, () => LOCAL_SPEAKING_LEVEL); // exactly the level is not above it
    expect(latest).toBe(false);
  });

  it('disabling while speaking: the loop is cancelled and it answers false', () => {
    render(true);
    playFrames(3, () => 0.5);
    expect(latest).toBe(true);
    render(false);
    expect(frames.size).toBe(0);
    expect(cancelFrame).toHaveBeenCalled();
    expect(latest).toBe(false);
    requestFrame.mockClear();
    playFrames(5, () => 0.5);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('enabled again after a pause starts from silence, not from the last answer', () => {
    render(true);
    playFrames(3, () => 0.5);
    render(false);
    audio.level = 0;
    render(true);
    expect(latest).toBe(false);
    playFrames(2, () => 0.5);
    expect(latest).toBe(true);
  });
});
