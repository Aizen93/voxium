import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ANNOTATION_LIVE_POINTER_INTERVAL_MS, ANNOTATION_LIVE_POINTER_FADE_MS, ANNOTATION_REACTIONS } from '@voxium/shared';

const socketEmit = vi.hoisted(() => vi.fn());
const socketRef = vi.hoisted(() => ({ current: { emit: socketEmit } as { emit: typeof socketEmit } | null }));
vi.mock('../../services/socket', () => ({
  getSocket: () => socketRef.current,
}));

const voiceMock = vi.hoisted(() => ({
  state: { activeChannelId: 'chan-1' as string | null, localUserId: 'me' as string | null },
  getState() { return this.state; },
  subscribe: () => () => {},
}));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: voiceMock }));

import {
  useAnnotationLiveStore,
  hasLiveActivity,
  fadeAlpha,
  LIVE_POINTER_TRAIL_MAX,
  LIVE_REACTIONS_MAX_IN_FLIGHT,
  LIVE_REACTION_TTL_MS,
} from '../../stores/annotationLiveStore';
import { ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS } from '@voxium/shared';

const initial = useAnnotationLiveStore.getState();
// A fresh clock base per test keeps the fake timers deterministic; the
// throttle's own clock is reset by clear() in beforeEach.
let clockBase = Date.parse('2026-08-23T12:00:00Z');

function sent() {
  return socketEmit.mock.calls.filter((c) => c[0] === 'voice:annotation:live').map((c) => c[1]);
}

beforeEach(() => {
  vi.useFakeTimers();
  clockBase += 60_000;
  vi.setSystemTime(new Date(clockBase));
  vi.clearAllMocks();
  socketRef.current = { emit: socketEmit };
  voiceMock.state = { activeChannelId: 'chan-1', localUserId: 'me' };
  useAnnotationLiveStore.getState().clear();
  useAnnotationLiveStore.setState(initial, true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('annotationLiveStore — receiving', () => {
  it('a remote pointer records position, local time and a capped trail', () => {
    const store = useAnnotationLiveStore.getState();
    for (let i = 0; i <= LIVE_POINTER_TRAIL_MAX + 3; i++) {
      store.receive('sharer', { k: 'pointer', x: i / 20, y: 0.5 });
      vi.advanceTimersByTime(10);
    }
    const p = useAnnotationLiveStore.getState().pointer!;
    expect(p.x).toBeCloseTo((LIVE_POINTER_TRAIL_MAX + 3) / 20);
    expect(p.at).toBe(Date.now() - 10); // stamped on receipt, on the LOCAL clock
    expect(p.trail).toHaveLength(LIVE_POINTER_TRAIL_MAX);
    // Oldest dropped first, newest last
    expect(p.trail[p.trail.length - 1].x).toBeCloseTo((LIVE_POINTER_TRAIL_MAX + 2) / 20);
  });

  it('pointer-off clears the dot', () => {
    const store = useAnnotationLiveStore.getState();
    store.receive('sharer', { k: 'pointer', x: 0.1, y: 0.1 });
    store.receive('sharer', { k: 'pointer-off' });
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
  });

  it('reactions are appended with the sender and capped in flight (oldest dropped)', () => {
    const store = useAnnotationLiveStore.getState();
    for (let i = 0; i < LIVE_REACTIONS_MAX_IN_FLIGHT + 5; i++) {
      store.receive(`u${i}`, { k: 'reaction', e: i % ANNOTATION_REACTIONS.length });
    }
    const reactions = useAnnotationLiveStore.getState().reactions;
    expect(reactions).toHaveLength(LIVE_REACTIONS_MAX_IN_FLIGHT);
    expect(reactions[0].userId).toBe('u5');
    expect(new Set(reactions.map((r) => r.id)).size).toBe(LIVE_REACTIONS_MAX_IN_FLIGHT);
  });

  it('an out-of-range reaction index is ignored even if the server let it through', () => {
    const store = useAnnotationLiveStore.getState();
    store.receive('u1', { k: 'reaction', e: ANNOTATION_REACTIONS.length });
    store.receive('u1', { k: 'reaction', e: -1 });
    expect(useAnnotationLiveStore.getState().reactions).toEqual([]);
  });

  it('a snapshot notice records who and when', () => {
    useAnnotationLiveStore.getState().receive('u7', { k: 'snapshot' });
    expect(useAnnotationLiveStore.getState().snapshotNotice).toEqual({ userId: 'u7', at: Date.now() });
  });
});

describe('annotationLiveStore — sharer pointer send throttle', () => {
  it('sends the first position at once and local-echoes it', () => {
    useAnnotationLiveStore.getState().pointTo(0.3, 0.4);
    expect(sent()).toEqual([{ channelId: 'chan-1', ev: { k: 'pointer', x: 0.3, y: 0.4 } }]);
    expect(useAnnotationLiveStore.getState().pointer).toMatchObject({ x: 0.3, y: 0.4 });
  });

  it('coalesces a burst to one send per interval and ALWAYS sends the last position', () => {
    const store = useAnnotationLiveStore.getState();
    store.pointTo(0.1, 0.1);          // leading send
    for (let i = 2; i <= 6; i++) {    // 5 moves inside the window
      vi.advanceTimersByTime(5);
      store.pointTo(i / 10, i / 10);
    }
    expect(sent()).toHaveLength(1);
    // Local echo is immediate regardless
    expect(useAnnotationLiveStore.getState().pointer).toMatchObject({ x: 0.6, y: 0.6 });
    vi.advanceTimersByTime(ANNOTATION_LIVE_POINTER_INTERVAL_MS);
    expect(sent()).toHaveLength(2);
    expect(sent()[1].ev).toEqual({ k: 'pointer', x: 0.6, y: 0.6 });
  });

  it('keeps to ≤ one send per interval under a 60 Hz move stream', () => {
    const store = useAnnotationLiveStore.getState();
    for (let i = 0; i < 60; i++) {
      store.pointTo(i / 60, 0.5);
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(ANNOTATION_LIVE_POINTER_INTERVAL_MS);
    const total = 60 * 16;
    expect(sent().length).toBeLessThanOrEqual(Math.ceil(total / ANNOTATION_LIVE_POINTER_INTERVAL_MS) + 1);
    expect(sent().length).toBeGreaterThan(10);
  });

  it('clamps the position to the frame before sending', () => {
    useAnnotationLiveStore.getState().pointTo(-0.4, 1.7);
    expect(sent()[0].ev).toEqual({ k: 'pointer', x: 0, y: 1 });
  });

  it('pointerOff cancels a pending trailing send and sends pointer-off once', () => {
    const store = useAnnotationLiveStore.getState();
    store.pointTo(0.1, 0.1);
    vi.advanceTimersByTime(5);
    store.pointTo(0.2, 0.2); // pending
    store.pointerOff();
    vi.advanceTimersByTime(ANNOTATION_LIVE_POINTER_INTERVAL_MS * 2);
    expect(sent().map((m) => m.ev)).toEqual([{ k: 'pointer', x: 0.1, y: 0.1 }, { k: 'pointer-off' }]);
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
  });

  it('pointerOff with nothing live sends nothing (tool switches are frequent)', () => {
    useAnnotationLiveStore.getState().pointerOff();
    expect(sent()).toEqual([]);
  });

  it('a wall clock stepping BACKWARDS does not stall the pointer (NTP correction)', () => {
    const store = useAnnotationLiveStore.getState();
    store.pointTo(0.1, 0.1);
    vi.setSystemTime(new Date(Date.now() - 3_600_000)); // clock jumps back an hour
    store.pointTo(0.2, 0.2);
    expect(sent()).toHaveLength(2); // treated as an elapsed window, sent at once
    vi.advanceTimersByTime(5);
    store.pointTo(0.3, 0.3);
    vi.advanceTimersByTime(ANNOTATION_LIVE_POINTER_INTERVAL_MS);
    expect(sent()).toHaveLength(3); // and the trailing send still fires within one interval
  });

  it('sends nothing without a voice channel or a socket, but still local-echoes', () => {
    voiceMock.state = { activeChannelId: null, localUserId: 'me' };
    useAnnotationLiveStore.getState().pointTo(0.5, 0.5);
    voiceMock.state = { activeChannelId: 'chan-1', localUserId: 'me' };
    socketRef.current = null;
    vi.advanceTimersByTime(ANNOTATION_LIVE_POINTER_INTERVAL_MS);
    useAnnotationLiveStore.getState().pointTo(0.6, 0.6);
    expect(sent()).toEqual([]);
    expect(useAnnotationLiveStore.getState().pointer).toMatchObject({ x: 0.6, y: 0.6 });
  });
});

describe('annotationLiveStore — reactions and notices from this client', () => {
  it('react local-echoes under our own id and sends the index', () => {
    useAnnotationLiveStore.getState().react(3);
    expect(useAnnotationLiveStore.getState().reactions).toEqual([expect.objectContaining({ userId: 'me', e: 3 })]);
    expect(sent()).toEqual([{ channelId: 'chan-1', ev: { k: 'reaction', e: 3 } }]);
  });

  it('react refuses an index outside the allowlist', () => {
    useAnnotationLiveStore.getState().react(ANNOTATION_REACTIONS.length);
    expect(sent()).toEqual([]);
    expect(useAnnotationLiveStore.getState().reactions).toEqual([]);
  });

  it('notifySnapshot sends the courtesy event', () => {
    useAnnotationLiveStore.getState().notifySnapshot();
    expect(sent()).toEqual([{ channelId: 'chan-1', ev: { k: 'snapshot' } }]);
  });
});

describe('annotationLiveStore — vanishing-ink clocks', () => {
  it('touchFading starts or restarts a stroke clock; forgetFading drops it', () => {
    const store = useAnnotationLiveStore.getState();
    store.touchFading('s1');
    expect(useAnnotationLiveStore.getState().fading.get('s1')).toEqual({ at: Date.now(), hidden: false });
    vi.advanceTimersByTime(1000);
    store.touchFading('s1'); // an append restarts the clock
    expect(useAnnotationLiveStore.getState().fading.get('s1')!.at).toBe(Date.now());
    store.forgetFading(['s1', 'never-there']);
    expect(useAnnotationLiveStore.getState().fading.size).toBe(0);
  });

  it('rapid retouches of a live clock are coalesced (~100 ms granularity, no state churn per mousemove)', () => {
    const store = useAnnotationLiveStore.getState();
    store.touchFading('s1');
    const before = useAnnotationLiveStore.getState();
    vi.advanceTimersByTime(50);
    store.touchFading('s1'); // within the granularity window: nothing changes
    expect(useAnnotationLiveStore.getState()).toBe(before);
    vi.advanceTimersByTime(60);
    store.touchFading('s1'); // past it: the clock restarts
    expect(useAnnotationLiveStore.getState().fading.get('s1')!.at).toBe(Date.now());
    // A hidden clock always restarts (the stroke reappears legitimately, e.g. redo)
    store.prune(Date.now() + 10_000);
    vi.advanceTimersByTime(10);
    store.touchFading('s1');
    expect(useAnnotationLiveStore.getState().fading.get('s1')!.hidden).toBe(false);
  });

  it('prune flips an expired clock to hidden (the stroke stays invisible) and the loop goes idle', () => {
    const store = useAnnotationLiveStore.getState();
    store.touchFading('s1');
    expect(hasLiveActivity(useAnnotationLiveStore.getState())).toBe(true);
    store.prune(Date.now() + ANNOTATION_FADE_AFTER_MS - 1);
    expect(useAnnotationLiveStore.getState().fading.get('s1')!.hidden).toBe(false);
    store.prune(Date.now() + ANNOTATION_FADE_AFTER_MS);
    expect(useAnnotationLiveStore.getState().fading.get('s1')).toEqual({ at: Date.now(), hidden: true });
    expect(hasLiveActivity(useAnnotationLiveStore.getState())).toBe(false);
    expect(useAnnotationLiveStore.getState().fading.size).toBe(1); // kept until the scene drops it
  });

  it('fadeAlpha: full, then a linear ramp over the fade-out window, then gone', () => {
    const at = 10_000;
    const clock = { at, hidden: false };
    expect(fadeAlpha(clock, at, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS)).toBe(1);
    expect(fadeAlpha(clock, at + ANNOTATION_FADE_AFTER_MS - ANNOTATION_FADE_OUT_MS, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS)).toBe(1);
    expect(fadeAlpha(clock, at + ANNOTATION_FADE_AFTER_MS - ANNOTATION_FADE_OUT_MS / 2, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS)).toBeCloseTo(0.5);
    expect(fadeAlpha(clock, at + ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS)).toBe(0);
    expect(fadeAlpha({ at, hidden: true }, at, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS)).toBe(0);
    expect(fadeAlpha(undefined, at, ANNOTATION_FADE_AFTER_MS, ANNOTATION_FADE_OUT_MS)).toBe(1); // no clock: not vanishing
  });
});

describe('annotationLiveStore — pruning and lifecycle', () => {
  it('prune drops a faded pointer, expired reactions and an old notice — and is a no-op otherwise', () => {
    const store = useAnnotationLiveStore.getState();
    store.receive('s', { k: 'pointer', x: 0.1, y: 0.1 });
    store.receive('u1', { k: 'reaction', e: 0 });
    store.receive('u2', { k: 'snapshot' });
    const before = useAnnotationLiveStore.getState();
    store.prune(Date.now() + 10);
    expect(useAnnotationLiveStore.getState()).toBe(before); // untouched reference: no re-render

    store.prune(Date.now() + ANNOTATION_LIVE_POINTER_FADE_MS + 1);
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
    expect(useAnnotationLiveStore.getState().reactions).toHaveLength(1);

    store.prune(Date.now() + LIVE_REACTION_TTL_MS + 1);
    expect(useAnnotationLiveStore.getState().reactions).toEqual([]);
    store.prune(Date.now() + 4_001);
    expect(useAnnotationLiveStore.getState().snapshotNotice).toBeNull();
  });

  it('hasLiveActivity answers whether the scheduler still has work', () => {
    expect(hasLiveActivity(useAnnotationLiveStore.getState())).toBe(false);
    useAnnotationLiveStore.getState().receive('s', { k: 'pointer', x: 0.1, y: 0.1 });
    expect(hasLiveActivity(useAnnotationLiveStore.getState())).toBe(true);
  });

  it('clear forgets the throttle clock: the next share sends its first move at once', () => {
    const store = useAnnotationLiveStore.getState();
    store.pointTo(0.1, 0.1); // leading send
    store.clear();           // share ends
    store.pointTo(0.2, 0.2); // a new share, within the old window
    expect(sent().map((m) => m.ev)).toEqual([{ k: 'pointer', x: 0.1, y: 0.1 }, { k: 'pointer', x: 0.2, y: 0.2 }]);
  });

  it('clear wipes everything and cancels a pending send', () => {
    const store = useAnnotationLiveStore.getState();
    store.pointTo(0.1, 0.1);
    vi.advanceTimersByTime(5);
    store.pointTo(0.2, 0.2);
    store.receive('u1', { k: 'reaction', e: 0 });
    store.clear();
    vi.advanceTimersByTime(ANNOTATION_LIVE_POINTER_INTERVAL_MS * 2);
    expect(sent()).toHaveLength(1);
    expect(useAnnotationLiveStore.getState()).toMatchObject({ pointer: null, reactions: [], snapshotNotice: null });
  });
});
