import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MaskRect } from '../../stores/annotationStore';

// ─── Controllable voiceStore / annotationStore stand-ins ────────────────────

// Built inside vi.hoisted: the store module subscribes to both stores at
// IMPORT time, so the stand-ins must exist before the import runs.
const mocks = vi.hoisted(() => {
  type Listener<S> = (state: S, prev: S) => void;
  function observable<S>(base: () => S) {
    let state = base();
    const listeners = new Set<Listener<S>>();
    return {
      getState: () => state,
      setState: (partial: Partial<S>) => {
        const prev = state;
        state = { ...state, ...partial };
        listeners.forEach((l) => l(state, prev));
      },
      subscribe: (l: Listener<S>) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      _reset: () => { state = base(); },
    };
  }
  interface Mask { id: string; x: number; y: number; w: number; h: number; style?: string; src?: string }
  const voice = observable(() => ({ isScreenSharing: false, localUserId: 'alice' as string | null, screenShareSourceKey: null as string | null, pendingShare: null as { sourceKey: string | null } | null }));
  const ann = observable(() => ({ masks: [] as Mask[] }));
  const annotation = Object.assign(ann, {
    addMask: (m: Mask) => ann.setState({ masks: [...ann.getState().masks, m] }),
    removeMask: (id: string) => ann.setState({ masks: ann.getState().masks.filter((x) => x.id !== id) }),
  });
  return { voice, annotation };
});
const voiceMock = { get current() { return mocks.voice; } };
const annotationMock = { get current() { return mocks.annotation; } };

// The factories run hoisted, before any top-level const — reference `mocks` only
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: {
    getState: () => mocks.voice.getState(),
    setState: (p: never) => mocks.voice.setState(p),
    subscribe: (l: never) => mocks.voice.subscribe(l),
  },
}));
vi.mock('../../stores/annotationStore', () => ({
  useAnnotationStore: {
    getState: () => ({ ...mocks.annotation.getState(), addMask: mocks.annotation.addMask, removeMask: mocks.annotation.removeMask }),
    setState: (p: never) => mocks.annotation.setState(p),
    subscribe: (l: never) => mocks.annotation.subscribe(l),
  },
}));

import { useMaskLayoutStore, resetMaskLayoutModuleState } from '../../stores/maskLayoutStore';
import { loadMaskLayouts, saveMaskLayouts, upsertMaskLayout, MASK_LAYOUT_MASKS_MAX } from '../../utils/maskLayouts';

const mask = (id: string, overrides: Partial<MaskRect> = {}): MaskRect => ({ id, x: 0.2, y: 0.2, w: 0.3, h: 0.2, ...overrides });
const KEY = 'window:1280x720';

function startShare(sourceKey: string | null = KEY) {
  voiceMock.current.setState({ screenShareSourceKey: sourceKey, isScreenSharing: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetMaskLayoutModuleState();
  // The subscriptions registered at import stay live: reset state, not wiring
  mocks.voice.setState({ isScreenSharing: false, localUserId: 'alice', screenShareSourceKey: null, pendingShare: null });
  mocks.annotation.setState({ masks: [] });
  useMaskLayoutStore.setState({ appliedLayout: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('maskLayoutStore — applying on share start', () => {
  it('applies the remembered layout with FRESH ids, shows the banner, and bumps lastUsed', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('stored-1', { style: 'pixelate' }), mask('stored-2', { x: 0.6 })], 5));
    startShare();
    const masks = annotationMock.current.getState().masks;
    expect(masks).toHaveLength(2);
    expect(masks.map((m) => m.id)).not.toContain('stored-1'); // fresh ids per application
    expect(masks[0]).toMatchObject({ x: 0.2 });
    expect(masks[0].style).toBeUndefined(); // styles are per-session choices, never remembered
    expect(useMaskLayoutStore.getState().appliedLayout).toMatchObject({ key: KEY, count: 2 });
    expect(loadMaskLayouts('alice')[0].lastUsed).toBe(Date.now());
  });

  it('does nothing without a stored layout, a source key, or a user', () => {
    startShare();
    expect(annotationMock.current.getState().masks).toEqual([]);
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();

    voiceMock.current.setState({ isScreenSharing: false });
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('m')], 5));
    startShare(null); // settings gave no size
    expect(annotationMock.current.getState().masks).toEqual([]);

    voiceMock.current.setState({ isScreenSharing: false, localUserId: null });
    startShare();
    expect(annotationMock.current.getState().masks).toEqual([]);
  });

  it('a layout stored by another user is not applied', () => {
    saveMaskLayouts('bob', upsertMaskLayout([], KEY, [mask('bobs')], 5));
    startShare();
    expect(annotationMock.current.getState().masks).toEqual([]);
  });

  it('start fresh removes exactly the applied masks and keeps hand-placed ones; Keep only dismisses', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s1'), mask('s2')], 5));
    startShare();
    annotationMock.current.addMask(mask('hand-made', { x: 0.8 }));
    vi.advanceTimersByTime(2_000); // let the hand-add's save land

    useMaskLayoutStore.getState().startFresh();
    expect(annotationMock.current.getState().masks.map((m) => m.id)).toEqual(['hand-made']);
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();

    // Keep: banner gone, masks untouched
    useMaskLayoutStore.setState({ appliedLayout: { key: KEY, count: 1, ids: ['hand-made'] } });
    useMaskLayoutStore.getState().keepApplied();
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();
    expect(annotationMock.current.getState().masks).toHaveLength(1);
  });
});

describe('maskLayoutStore — the pre-flight', () => {
  it('applies when the pre-flight opens, and does NOT apply again when the share then starts', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s1'), mask('s2')], 5));
    voiceMock.current.setState({ pendingShare: { sourceKey: KEY } });
    expect(annotationMock.current.getState().masks).toHaveLength(2);
    expect(useMaskLayoutStore.getState().appliedLayout).toMatchObject({ count: 2 });

    // Go live: confirm stamps the source key as it clears pendingShare
    voiceMock.current.setState({ pendingShare: null, screenShareSourceKey: KEY });
    voiceMock.current.setState({ isScreenSharing: true });
    expect(annotationMock.current.getState().masks).toHaveLength(2); // not four
    expect(useMaskLayoutStore.getState().appliedLayout).toMatchObject({ count: 2 }); // banner survives going live
  });

  it('a cancelled pre-flight (no source key stamped) drops the banner, and the NEXT capture applies again', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s1')], 5));
    voiceMock.current.setState({ pendingShare: { sourceKey: KEY } });
    expect(useMaskLayoutStore.getState().appliedLayout).not.toBeNull();

    voiceMock.current.setState({ pendingShare: null }); // cancel: no key stamped
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();

    annotationMock.current.setState({ masks: [] }); // voiceStore's hook clears them in production
    voiceMock.current.setState({ pendingShare: { sourceKey: KEY } });
    expect(annotationMock.current.getState().masks).toHaveLength(1); // applied fresh
  });

  it('the skip-pre-flight path (share start with no earlier apply) still applies once', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s1')], 5));
    // skip path in production also opens pendingShare then confirms at once —
    // the apply happens on the pendingShare edge
    voiceMock.current.setState({ pendingShare: { sourceKey: KEY } });
    voiceMock.current.setState({ pendingShare: null, screenShareSourceKey: KEY });
    voiceMock.current.setState({ isScreenSharing: true });
    expect(annotationMock.current.getState().masks).toHaveLength(1);
  });
});

describe('maskLayoutStore — failure and rejection paths', () => {
  it('a failed activation (key cleared, share never started) resets the banner and the latch', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s1')], 5));
    voiceMock.current.setState({ pendingShare: { sourceKey: KEY } });
    expect(useMaskLayoutStore.getState().appliedLayout).not.toBeNull();

    // Confirm stamps the key as it clears pendingShare…
    voiceMock.current.setState({ pendingShare: null, screenShareSourceKey: KEY });
    // …then activation fails: voiceStore clears the key with no share started
    voiceMock.current.setState({ screenShareSourceKey: null });
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();

    // The once-per-capture latch reset too: the next capture applies fresh
    annotationMock.current.setState({ masks: [] });
    voiceMock.current.setState({ pendingShare: { sourceKey: KEY } });
    expect(annotationMock.current.getState().masks).toHaveLength(1);
  });

  it('Start fresh in the PRE-FLIGHT forgets the remembered layout, not just this capture', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s1')], 5));
    voiceMock.current.setState({ pendingShare: { sourceKey: KEY } }); // applies + banner
    expect(annotationMock.current.getState().masks).toHaveLength(1);

    useMaskLayoutStore.getState().startFresh();
    expect(annotationMock.current.getState().masks).toEqual([]);
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();
    // The identical click on the LIVE banner deletes the entry via the save
    // subscription; the pre-flight (not sharing yet) must reach the same state
    expect(loadMaskLayouts('alice')).toEqual([]);
  });

  it('a mask edit within the debounce window of a stop is flushed, not lost', () => {
    startShare();
    annotationMock.current.setState({ masks: [mask('late')] }); // < 1s before the stop
    // stopScreenShare clears the flag and the key in ONE update
    voiceMock.current.setState({ isScreenSharing: false, screenShareSourceKey: null });
    const saved = loadMaskLayouts('alice');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ key: KEY });
    expect(saved[0].masks).toHaveLength(1);
  });
});

describe('maskLayouts sanitization', () => {
  it('drops degenerate masks, caps the per-entry count, and never stores a style', () => {
    const stored = upsertMaskLayout([], KEY, [mask('zero', { w: 0 }), mask('thin', { h: 0.001 }), mask('ok', { style: 'blur' })], 5);
    expect(stored[0].masks.map((m) => m.id)).toEqual(['ok']);
    expect(stored[0].masks[0].style).toBeUndefined();

    const many = Array.from({ length: MASK_LAYOUT_MASKS_MAX + 20 }, (_, i) => mask(`m${i}`));
    expect(upsertMaskLayout([], KEY, many, 5)[0].masks).toHaveLength(MASK_LAYOUT_MASKS_MAX);
  });
});

describe('maskLayoutStore — saving while sharing', () => {
  it('debounces mask edits into one save for the current source', () => {
    startShare();
    annotationMock.current.addMask(mask('a'));
    vi.advanceTimersByTime(500);
    annotationMock.current.addMask(mask('b'));
    expect(loadMaskLayouts('alice')).toEqual([]); // not yet
    vi.advanceTimersByTime(1_000);
    const [entry] = loadMaskLayouts('alice');
    expect(entry.key).toBe(KEY);
    expect(entry.masks.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('the auto-apply itself does not re-save (no write loop), and edits after the share ends are not saved', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s')], 5));
    startShare();
    expect(annotationMock.current.getState().masks).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(loadMaskLayouts('alice')[0].masks[0].id).toBe('s'); // lastUsed bumped, masks untouched

    // (An edit made WHILE sharing that the stop cuts off is FLUSHED, not
    // lost — pinned by the failure-paths suite.) Edits after the share
    // ends must not be saved:
    voiceMock.current.setState({ isScreenSharing: false, screenShareSourceKey: null });
    annotationMock.current.addMask(mask('post'));
    vi.advanceTimersByTime(2_000);
    expect(loadMaskLayouts('alice')[0].masks.map((m) => m.id)).toEqual(['s']);
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull(); // banner died with the share
  });

  it('removing every mask while sharing deletes the entry — deliberate emptiness is a memory too', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], KEY, [mask('s')], 5));
    startShare();
    annotationMock.current.removeMask(annotationMock.current.getState().masks[0].id);
    vi.advanceTimersByTime(1_500);
    expect(loadMaskLayouts('alice')).toEqual([]);
  });

  it('mask edits while NOT sharing never write', () => {
    annotationMock.current.addMask(mask('preflight'));
    vi.advanceTimersByTime(2_000);
    expect(loadMaskLayouts('alice')).toEqual([]);
  });
});
