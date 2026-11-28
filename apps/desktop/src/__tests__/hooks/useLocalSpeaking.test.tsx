import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Whether the local user is speaking, for the DM call panels' ring: the
 * speaking detector's own decision (what the other person is told), read
 * once a frame, state set only when it flips, and no frame loop at all while
 * disabled.
 */

const detector = vi.hoisted(() => ({ speaking: false }));
vi.mock('../../services/audioAnalyser', () => ({ isSpeechDetected: () => detector.speaking }));

import { useLocalSpeaking } from '../../hooks/useLocalSpeaking';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const requestFrame = vi.fn((cb: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, cb); return id; });
const cancelFrame = vi.fn((id: number) => { frames.delete(id); });
vi.stubGlobal('requestAnimationFrame', requestFrame);
vi.stubGlobal('cancelAnimationFrame', cancelFrame);

/** Run `count` frames, the detector answering `answers(i)` before each. */
function playFrames(count: number, answers: (i: number) => boolean) {
  for (let i = 0; i < count; i++) {
    detector.speaking = answers(i);
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
  detector.speaking = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useLocalSpeaking', () => {
  it('disabled: no frame loop and false, whatever the detector says', () => {
    render(false);
    playFrames(30, () => true);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(latest).toBe(false);
    expect(renders).toBe(1);
  });

  it('enabled: the detector\'s answer, rendering only on each flip', () => {
    render(true);
    expect(latest).toBe(false);
    playFrames(40, () => true);
    expect(latest).toBe(true);
    expect(renders).toBe(2);
    playFrames(40, () => false);
    expect(latest).toBe(false);
    expect(renders).toBe(3);
    playFrames(6, (i) => i % 2 === 0);
    expect(renders).toBe(9);
  });

  it('disabling while speaking: the loop is cancelled and it answers false', () => {
    render(true);
    playFrames(3, () => true);
    expect(latest).toBe(true);
    render(false);
    expect(frames.size).toBe(0);
    expect(cancelFrame).toHaveBeenCalled();
    expect(latest).toBe(false);
    requestFrame.mockClear();
    playFrames(5, () => true);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('enabled again after a pause starts from silence, not from the last answer', () => {
    render(true);
    playFrames(3, () => true);
    render(false);
    detector.speaking = false;
    render(true);
    expect(latest).toBe(false);
    playFrames(2, () => true);
    expect(latest).toBe(true);
  });
});
