import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ANNOTATION_LIVE_POINTER_FADE_MS } from '@voxium/shared';

vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: {
    getState: () => ({ activeChannelId: 'chan-1', screenSharingUserId: 'sharer', isScreenSharing: false, screenStream: null, localUserId: 'me' }),
    subscribe: () => () => {},
  },
}));
vi.mock('../../services/screenComposite', () => ({
  ensureComposite: vi.fn(), stopComposite: vi.fn(), teardownComposite: vi.fn(), isCompositing: () => false,
}));

import { useLiveScheduler } from '../../components/voice/AnnotationCanvas';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A controllable requestAnimationFrame: frames run only when we say so
let frameQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextFrameId = 1;
function runFrames(n: number) {
  for (let i = 0; i < n; i++) {
    const batch = frameQueue;
    frameQueue = [];
    act(() => { batch.forEach((f) => f.cb(performance.now())); });
  }
}

function Harness({ draw }: { draw: () => void }) {
  useLiveScheduler(draw);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const draw = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
  frameQueue = [];
  draw.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextFrameId++; frameQueue.push({ id, cb }); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frameQueue = frameQueue.filter((f) => f.id !== id); });
  useAnnotationLiveStore.getState().clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<Harness draw={draw} />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useLiveScheduler', () => {
  it('is idle while nothing live exists — no frame is ever requested', () => {
    expect(frameQueue).toHaveLength(0);
    runFrames(3);
    expect(draw).not.toHaveBeenCalled();
  });

  it('starts on the first live event, redraws every frame, and STOPS itself once the pointer has faded', () => {
    act(() => { useAnnotationLiveStore.getState().receive('sharer', { k: 'pointer', x: 0.5, y: 0.5 }); });
    expect(frameQueue).toHaveLength(1);

    runFrames(3);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(frameQueue).toHaveLength(1); // still scheduled: the pointer is alive

    // Past the fade window the tick prunes the pointer and does not re-arm
    vi.advanceTimersByTime(ANNOTATION_LIVE_POINTER_FADE_MS + 1);
    runFrames(1);
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
    expect(frameQueue).toHaveLength(0);
    const drawsSoFar = draw.mock.calls.length;
    runFrames(2);
    expect(draw).toHaveBeenCalledTimes(drawsSoFar); // nothing runs while idle
  });

  it('never double-schedules under a burst of events', () => {
    act(() => {
      for (let i = 0; i < 10; i++) useAnnotationLiveStore.getState().receive('sharer', { k: 'pointer', x: i / 10, y: 0.5 });
    });
    expect(frameQueue).toHaveLength(1);
  });

  it('restarts on a fresh event after going idle', () => {
    act(() => { useAnnotationLiveStore.getState().receive('sharer', { k: 'pointer', x: 0.5, y: 0.5 }); });
    act(() => { useAnnotationLiveStore.getState().receive('sharer', { k: 'pointer-off' }); });
    runFrames(1); // the tick sees no activity and stops
    expect(frameQueue).toHaveLength(0);
    act(() => { useAnnotationLiveStore.getState().receive('u2', { k: 'reaction', e: 0 }); });
    expect(frameQueue).toHaveLength(1);
  });

  it('cancels the pending frame on unmount', () => {
    act(() => { useAnnotationLiveStore.getState().receive('sharer', { k: 'pointer', x: 0.5, y: 0.5 }); });
    expect(frameQueue).toHaveLength(1);
    act(() => root.unmount());
    expect(frameQueue).toHaveLength(0);
    // Re-render something so afterEach's unmount stays valid
    root = createRoot(container);
    act(() => { root.render(<Harness draw={draw} />); });
  });
});
