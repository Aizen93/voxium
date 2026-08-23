import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyAnnotationOps, ANNOTATION_BATCH_INTERVAL_MS, ANNOTATION_MAX_OPS_PER_BATCH, ANNOTATION_OPS_MAX, ANNOTATION_ACK_TIMEOUT_MS, ANNOTATION_HISTORY_MAX, ANNOTATION_HISTORY_BYTES_MAX, ANNOTATION_FADE_AFTER_MS, type AnnotationOp, type AnnotationObject } from '@voxium/shared';

// ─── Mocks (before importing the store) ──────────────────────────────────────

const socketEmit = vi.hoisted(() => vi.fn());
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: socketEmit }),
}));

// Minimal voiceStore stand-in with a real subscribe so the module-scope
// lifecycle guard in annotationStore can be driven by tests.
const voiceMock = vi.hoisted(() => {
  type VoiceShape = {
    activeChannelId: string | null;
    screenSharingUserId: string | null;
    isScreenSharing: boolean;
    screenStream: { getVideoTracks: () => { readyState: string }[] } | null;
    screenShareAnnotationsVersion: number;
    replaceScreenVideoTrack: (track: unknown) => Promise<void>;
    setScreenVideoProducerPaused: (paused: boolean) => void;
  };
  const base = (): VoiceShape => ({
    activeChannelId: 'chan-1',
    screenSharingUserId: null,
    isScreenSharing: false,
    screenStream: null,
    screenShareAnnotationsVersion: 2,
    replaceScreenVideoTrack: async () => {},
    setScreenVideoProducerPaused: vi.fn(),
  });
  let state = base();
  const listeners = new Set<(s: VoiceShape, p: VoiceShape) => void>();
  return {
    getState: () => state,
    setState: (partial: Partial<VoiceShape>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((l) => l(state, prev));
    },
    subscribe: (l: (s: VoiceShape, p: VoiceShape) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    _reset: () => {
      state = base();
    },
  };
});
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: voiceMock }));

const compositeMock = vi.hoisted(() => ({
  ensureComposite: vi.fn().mockResolvedValue(undefined),
  stopComposite: vi.fn().mockResolvedValue(undefined),
  teardownComposite: vi.fn(),
  isCompositing: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/screenComposite', () => compositeMock);

const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../stores/toastStore', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('../../i18n', () => ({
  default: { t: (key: string) => key },
}));

import { useAnnotationStore } from '../../stores/annotationStore';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';
import { loadAnnotationPrefs } from '../../utils/annotationPrefs';

const initialState = useAnnotationStore.getState();

function stroke(id: string): AnnotationOp {
  return { t: 'add', obj: { id, kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] } };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  voiceMock._reset();
  useAnnotationStore.setState(initialState, true);
  useAnnotationStore.getState().clearViewerScene(); // also resets the module-level op queue
  useAnnotationLiveStore.getState().clear();
  // resetQueue settles any drain left in flight by the previous test — one
  // microtask turn lets that loop observe the empty queue and exit
  await Promise.resolve();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Viewer path ────────────────────────────────────────────────────────────

describe('annotationStore — viewer path', () => {
  it('hydrate replaces the scene wholesale', () => {
    useAnnotationStore.getState().localApply([stroke('mine')]);
    const scene = { objects: [{ id: 'their', kind: 'stroke' as const, tool: 'pen' as const, color: '#00ff00', width: 0.004, points: [0, 0, 1, 1] }] };
    useAnnotationStore.getState().hydrate('chan-1', 12, scene);
    const s = useAnnotationStore.getState();
    expect(s.scene).toEqual(scene);
    expect(s.rev).toBe(12);
    expect(s.sceneChannelId).toBe('chan-1');
  });

  it('applyRemoteOps drops batches at or below the hydrated rev', () => {
    useAnnotationStore.getState().hydrate('chan-1', 10, { objects: [] });
    useAnnotationStore.getState().applyRemoteOps('chan-1', 10, [stroke('replay')]);
    useAnnotationStore.getState().applyRemoteOps('chan-1', 9, [stroke('older')]);
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(0);
    useAnnotationStore.getState().applyRemoteOps('chan-1', 11, [stroke('fresh')]);
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['fresh']);
    expect(useAnnotationStore.getState().rev).toBe(11);
  });

  it('hydrate replays buffered ops NEWER than the snapshot (join race + restart snapshot)', () => {
    // Late-join race: ops rev 5 and 6 land BEFORE the voice:join hydration
    // (applied to an empty base — the viewer transiently shows a partial scene)
    useAnnotationStore.getState().applyRemoteOps('chan-1', 5, [stroke('from-rev-5')]);
    useAnnotationStore.getState().applyRemoteOps('chan-1', 6, [stroke('from-rev-6')]);

    // The snapshot (rev 4) arrives late — it must not erase the newer ops
    useAnnotationStore.getState().hydrate('chan-1', 4, { objects: [{ id: 'base', kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.004, points: [0, 0, 1, 1] }] });

    const s = useAnnotationStore.getState();
    expect(s.scene.objects.map((o) => o.id)).toEqual(['base', 'from-rev-5', 'from-rev-6']);
    expect(s.rev).toBe(6);
  });

  it('hydrate does NOT replay batches the snapshot already includes (restart re-baseline)', () => {
    // Viewer sat at rev 40 from before a server-side scene restart
    useAnnotationStore.getState().hydrate('chan-1', 40, { objects: [] });
    // Post-restart batch rev 1 is dropped as stale (40 held) but stays buffered
    useAnnotationStore.getState().applyRemoteOps('chan-1', 1, [stroke('post-restart')]);
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(0);

    // The restart snapshot (rev 1, INCLUDES the rev-1 batch) re-baselines;
    // replaying the buffered rev-1 batch on top would double-apply it
    const postRestartObj = (stroke('post-restart') as { t: 'add'; obj: never }).obj;
    useAnnotationStore.getState().hydrate('chan-1', 1, { objects: [postRestartObj] }, true);
    const s = useAnnotationStore.getState();
    expect(s.scene.objects.map((o) => o.id)).toEqual(['post-restart']);
    expect(s.rev).toBe(1);
  });

  it('a RESTART snapshot drops the buffered batches of the previous generation instead of replaying them', () => {
    // The previous test seeded rev 40 through hydrate(), which leaves the
    // buffer empty — the real path to rev 40 is applyRemoteOps, which buffers
    // every batch. With the buffer full, a rev-1 snapshot's "replay rev > 1"
    // rebuilt the whole pre-restart scene on top of it and pinned rev at 40.
    for (let rev = 1; rev <= 40; rev++) {
      useAnnotationStore.getState().applyRemoteOps('chan-1', rev, [stroke(`old-${rev}`)]);
    }
    expect(useAnnotationStore.getState().rev).toBe(40);

    // Scene key lost server-side; the sharer draws again → rev 1, restarted
    useAnnotationStore.getState().applyRemoteOps('chan-1', 1, [stroke('new-1')]); // stale by rev, buffered
    const new1 = (stroke('new-1') as { t: 'add'; obj: never }).obj;
    useAnnotationStore.getState().hydrate('chan-1', 1, { objects: [new1] }, true);

    let s = useAnnotationStore.getState();
    expect(s.scene.objects.map((o) => o.id)).toEqual(['new-1']);
    expect(s.rev).toBe(1);

    // The sharer's resync (clear + re-adds) at rev 2, 3 must now APPLY, not be
    // dropped as stale behind the old rev 40
    useAnnotationStore.getState().applyRemoteOps('chan-1', 2, [{ t: 'clear' } as never]);
    useAnnotationStore.getState().applyRemoteOps('chan-1', 3, [stroke('resynced')]);
    s = useAnnotationStore.getState();
    expect(s.scene.objects.map((o) => o.id)).toEqual(['resynced']);
    expect(s.rev).toBe(3);
  });

  it('a restart snapshot still replays batches that arrived AFTER it in the new generation', () => {
    for (let rev = 1; rev <= 5; rev++) {
      useAnnotationStore.getState().applyRemoteOps('chan-1', rev, [stroke(`old-${rev}`)]);
    }
    // New generation: rev 1 (in the snapshot) and rev 2 land before the
    // snapshot is processed — both are dropped as stale by rev and buffered
    useAnnotationStore.getState().applyRemoteOps('chan-1', 1, [stroke('new-1')]);
    useAnnotationStore.getState().applyRemoteOps('chan-1', 2, [stroke('new-2')]);
    const new1 = (stroke('new-1') as { t: 'add'; obj: never }).obj;
    useAnnotationStore.getState().hydrate('chan-1', 1, { objects: [new1] }, true);

    // Only what arrived after the restart snapshot was taken can be recovered;
    // new-2 arrived before the snapshot was processed but belongs to the new
    // generation — it is lost with the buffer, and the sharer's next batch
    // carries on from rev 3. Pinning this documents the trade-off: a clean
    // re-baseline over a perfectly recovered buffer.
    const s = useAnnotationStore.getState();
    expect(s.scene.objects.map((o) => o.id)).toEqual(['new-1']);
    expect(s.rev).toBe(1);
    useAnnotationStore.getState().applyRemoteOps('chan-1', 3, [stroke('new-3')]);
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['new-1', 'new-3']);
  });

  it('applyRemoteOps for a different channel starts from an empty scene', () => {
    useAnnotationStore.getState().hydrate('chan-1', 3, { objects: [{ id: 'old', kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.004, points: [0, 0, 1, 1] }] });
    useAnnotationStore.getState().applyRemoteOps('chan-2', 1, [stroke('new')]);
    const s = useAnnotationStore.getState();
    expect(s.sceneChannelId).toBe('chan-2');
    expect(s.scene.objects.map((o) => o.id)).toEqual(['new']);
  });
});

// ─── Sharer path: batching ──────────────────────────────────────────────────

describe('annotationStore — op batching', () => {
  it('applies locally at once but flushes over the throttle window as one batch', () => {
    useAnnotationStore.getState().localApply([stroke('a')]);
    useAnnotationStore.getState().localApply([{ t: 'append', id: 'a', points: [0.3, 0.3] }]);

    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    expect(socketEmit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ANNOTATION_BATCH_INTERVAL_MS);
    expect(socketEmit).toHaveBeenCalledTimes(1);
    const [event, payload] = socketEmit.mock.calls[0];
    expect(event).toBe('voice:annotation:ops');
    expect(payload).toEqual({
      channelId: 'chan-1',
      ops: [stroke('a'), { t: 'append', id: 'a', points: [0.3, 0.3] }],
    });
  });

  it('flushOps sends immediately (pointerup path)', () => {
    useAnnotationStore.getState().localApply([stroke('a')]);
    useAnnotationStore.getState().flushOps();
    expect(socketEmit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ANNOTATION_BATCH_INTERVAL_MS * 2);
    expect(socketEmit).toHaveBeenCalledTimes(1); // timer was cancelled, no double send
  });

  it('splits oversized queues AND serializes chunks on their acks (server RMW is not atomic)', async () => {
    const ops = Array.from({ length: ANNOTATION_MAX_OPS_PER_BATCH + 1 }, (_, i) => stroke(`s-${i}`));
    useAnnotationStore.getState().localApply(ops);
    useAnnotationStore.getState().flushOps();

    // Chunk 2 must NOT be in flight while chunk 1 is unacked — two concurrent
    // batches would read the same stale scene server-side and clobber each other
    expect(socketEmit).toHaveBeenCalledTimes(1);
    expect(socketEmit.mock.calls[0][1].ops).toHaveLength(ANNOTATION_MAX_OPS_PER_BATCH);

    socketEmit.mock.calls[0][2]({ ok: true });
    await Promise.resolve();

    expect(socketEmit).toHaveBeenCalledTimes(2);
    expect(socketEmit.mock.calls[1][1].ops).toHaveLength(1);
  });

  it('a lost ack times out instead of wedging the queue', async () => {
    useAnnotationStore.getState().localApply([stroke('a')]);
    useAnnotationStore.getState().flushOps();
    expect(socketEmit).toHaveBeenCalledTimes(1);

    // No ack arrives; queue more ops — they must ship after the timeout
    useAnnotationStore.getState().localApply([stroke('b')]);
    await vi.advanceTimersByTimeAsync(ANNOTATION_ACK_TIMEOUT_MS + ANNOTATION_BATCH_INTERVAL_MS);
    expect(socketEmit).toHaveBeenCalledTimes(2);
  });

  it('drops queued ops when the user left voice before the flush', () => {
    useAnnotationStore.getState().localApply([stroke('a')]);
    voiceMock.setState({ activeChannelId: null });
    vi.advanceTimersByTime(ANNOTATION_BATCH_INTERVAL_MS);
    expect(socketEmit).not.toHaveBeenCalled();
  });

  it('toasts sceneFull when a batch is rejected for scene limits', () => {
    useAnnotationStore.getState().localApply([{ t: 'clear' }]);
    useAnnotationStore.getState().flushOps();
    const ackCb = socketEmit.mock.calls[0][2];
    ackCb({ ok: false, error: 'Scene limit reached' });
    expect(toastError).toHaveBeenCalledWith('voice.annotations.sceneFull');
  });

  it('EVERY rejection is visible: non-limit rejections toast syncError (silent desync guard)', () => {
    useAnnotationStore.getState().localApply([stroke('a')]);
    useAnnotationStore.getState().flushOps();
    const ackCb = socketEmit.mock.calls[0][2];
    ackCb({ ok: false, error: 'Rate limited' });
    expect(toastError).toHaveBeenCalledWith('voice.annotations.syncError');
  });

  it('chunks by SERIALIZED SIZE as well as count: big image adds go out in batches under ANNOTATION_OPS_MAX', async () => {
    // 10 images of ~1/4 of the batch cap each: by count they would all fit one
    // batch of 64; by bytes that batch is 2.5× the server's cap and rejected.
    const quarter = Math.floor(ANNOTATION_OPS_MAX / 4) - 200;
    const image = (id: string): AnnotationOp => ({
      t: 'add',
      obj: { id, kind: 'image', src: `data:image/webp;base64,${'A'.repeat(quarter)}`, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    });
    const ops = Array.from({ length: 10 }, (_, i) => image(`img-${i}`));
    useAnnotationStore.getState().localApply(ops);
    useAnnotationStore.getState().flushOps();

    const sentIds: string[] = [];
    let batches = 0;
    while (socketEmit.mock.calls.length > batches) {
      const call = socketEmit.mock.calls[batches];
      const batch = call[1].ops as AnnotationOp[];
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(ANNOTATION_OPS_MAX);
      expect(batch.length).toBeLessThanOrEqual(ANNOTATION_MAX_OPS_PER_BATCH);
      sentIds.push(...batch.map((op) => (op as { obj: { id: string } }).obj.id));
      batches++;
      call[2]({ ok: true });
      await Promise.resolve();
    }
    const perBatch = Math.floor((ANNOTATION_OPS_MAX - 2) / (JSON.stringify(ops[0]).length + 1));
    expect(perBatch).toBeLessThan(10); // the premise: count alone would have sent them all at once
    expect(batches).toBe(Math.ceil(10 / perBatch));
    expect(sentIds).toEqual(ops.map((op) => (op as { obj: { id: string } }).obj.id)); // order preserved, nothing lost
  });

  it('an op too large for ANY batch is dropped with the sceneFull toast instead of being sent and rejected', async () => {
    const huge: AnnotationOp = {
      t: 'add',
      obj: { id: 'huge', kind: 'image', src: `data:image/webp;base64,${'A'.repeat(ANNOTATION_OPS_MAX)}`, x: 0, y: 0, w: 0.1, h: 0.1 },
    };
    useAnnotationStore.getState().localApply([huge, stroke('after')]);
    useAnnotationStore.getState().flushOps();
    expect(toastError).toHaveBeenCalledWith('voice.annotations.sceneFull');
    // The queue keeps draining past it
    expect(socketEmit).toHaveBeenCalledTimes(1);
    expect(socketEmit.mock.calls[0][1].ops.map((op: { obj: { id: string } }) => op.obj.id)).toEqual(['after']);
  });

  it('consecutive translates of one object coalesce into a single summed op on the wire', () => {
    const store = useAnnotationStore.getState();
    store.localApply([stroke('s')]);
    for (let i = 0; i < 10; i++) store.localApply([{ t: 'translate', id: 's', dx: 0.01, dy: -0.005 }]);
    store.flushOps();
    const ops = socketEmit.mock.calls[0][1].ops as AnnotationOp[];
    const translates = ops.filter((op) => op.t === 'translate') as { dx: number; dy: number }[];
    expect(translates).toHaveLength(1);
    expect(translates[0].dx).toBeCloseTo(0.1);
    expect(translates[0].dy).toBeCloseTo(-0.05);
  });

  it('a restarted ack re-sends the FULL local scene (clear + adds) so viewers regain pre-loss objects', async () => {
    useAnnotationStore.getState().localApply([stroke('a'), stroke('b')]);
    useAnnotationStore.getState().flushOps();
    const ackCb = socketEmit.mock.calls[0][2];
    ackCb({ ok: true, restarted: true });
    await Promise.resolve(); // let the drain loop pick up the resync batch

    expect(socketEmit).toHaveBeenCalledTimes(2);
    const resyncOps = socketEmit.mock.calls[1][1].ops;
    expect(resyncOps[0]).toEqual({ t: 'clear' });
    expect(resyncOps.slice(1).map((op: { obj: { id: string } }) => op.obj.id)).toEqual(['a', 'b']);
  });
});

// ─── Sharer path: undo / redo history ───────────────────────────────────────

describe('annotationStore — history', () => {
  const shape = (id: string, x = 0.1): AnnotationOp => ({
    t: 'add',
    obj: { id, kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x, y: 0.1, w: 0.2, h: 0.2 },
  });

  /** Everything this client put on the wire so far, flattened. */
  function wireOps(): AnnotationOp[] {
    return socketEmit.mock.calls.filter((c) => c[0] === 'voice:annotation:ops').flatMap((c) => c[1].ops as AnnotationOp[]);
  }

  /** Ack every batch as it goes out until the queue is empty (batches are
   *  serialized on their acks, so without this only the first one ships). */
  const acked = new Set<number>();
  async function drainWire() {
    await vi.advanceTimersByTimeAsync(ANNOTATION_BATCH_INTERVAL_MS);
    for (let i = 0; i < socketEmit.mock.calls.length; i++) {
      if (acked.has(i)) continue;
      acked.add(i);
      socketEmit.mock.calls[i][2]?.({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(ANNOTATION_BATCH_INTERVAL_MS);
    }
  }
  beforeEach(() => acked.clear());

  /** A viewer that applies exactly what we sent, in order. */
  async function viewerScene() {
    await drainWire();
    return applyAnnotationOps({ objects: [] }, wireOps());
  }

  it('starts with nothing to undo or redo', () => {
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('undo reverts the last action, redo re-applies it, and the VIEWER converges on the same scene every step', async () => {
    const store = useAnnotationStore.getState();
    store.localApply([shape('a')]);
    store.localApply([shape('b')]);
    store.localApply([{ t: 'update', id: 'a', patch: { x: 0.7 } }]);
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: true, canRedo: false });

    store.undo();
    let scene = useAnnotationStore.getState().scene;
    expect(scene.objects.find((o) => o.id === 'a')).toMatchObject({ x: 0.1 });
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: true, canRedo: true });

    store.undo();
    scene = useAnnotationStore.getState().scene;
    expect(scene.objects.map((o) => o.id)).toEqual(['a']);

    store.redo();
    scene = useAnnotationStore.getState().scene;
    expect(scene.objects.map((o) => o.id)).toEqual(['a', 'b']);

    store.redo();
    expect(useAnnotationStore.getState().scene.objects.find((o) => o.id === 'a')).toMatchObject({ x: 0.7 });
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: true, canRedo: false });

    expect(await viewerScene()).toEqual(useAnnotationStore.getState().scene);
  });

  it('a gesture collapses a whole stroke (add + appends) into ONE undo step and one redo add', async () => {
    const store = useAnnotationStore.getState();
    store.beginGesture();
    store.localApply([stroke('s')]);
    for (let i = 0; i < 5; i++) store.localApply([{ t: 'append', id: 's', points: [0.3 + i / 100, 0.3] }]);
    store.endGesture();

    store.undo();
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    expect(useAnnotationStore.getState().canUndo).toBe(false);
    // ...and the wire saw a single remove for it
    await drainWire();
    const removes = wireOps().filter((op) => op.t === 'remove');
    expect(removes).toEqual([{ t: 'remove', id: 's' }]);

    store.redo();
    const redone = useAnnotationStore.getState().scene.objects[0] as { points: number[] };
    expect(redone.points).toHaveLength(4 + 10);
    expect(await viewerScene()).toEqual(useAnnotationStore.getState().scene);
    // The redo shipped ONE add of the finished stroke, not the appends again
    const addsOfS = wireOps().filter((op) => op.t === 'add' && op.obj.id === 's');
    expect(addsOfS).toHaveLength(2); // original + redo
  });

  it('a fresh action after undo discards the redo branch', () => {
    const store = useAnnotationStore.getState();
    store.localApply([shape('a')]);
    store.undo();
    expect(useAnnotationStore.getState().canRedo).toBe(true);
    store.localApply([shape('b')]);
    expect(useAnnotationStore.getState().canRedo).toBe(false);
    store.redo(); // no-op
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['b']);
  });

  it('undo of clearAll brings every object back (byte-chunked on the wire)', async () => {
    const store = useAnnotationStore.getState();
    store.localApply([shape('a'), shape('b'), stroke('s')]);
    store.clearAll();
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    store.undo();
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['a', 'b', 's']);
    expect(await viewerScene()).toEqual(useAnnotationStore.getState().scene);
  });

  it('a degenerate gesture (object added then discarded) leaves no history entry', () => {
    const store = useAnnotationStore.getState();
    store.beginGesture();
    store.localApply([shape('tmp')]);
    store.localApply([{ t: 'remove', id: 'tmp' }]);
    store.endGesture();
    expect(useAnnotationStore.getState().canUndo).toBe(false);
  });

  it('undo mid-drag ends the open gesture first', () => {
    const store = useAnnotationStore.getState();
    store.beginGesture();
    store.localApply([stroke('s')]);
    store.undo(); // no endGesture call
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });

  it('history is capped at ANNOTATION_HISTORY_MAX entries (oldest dropped)', () => {
    const store = useAnnotationStore.getState();
    for (let i = 0; i < ANNOTATION_HISTORY_MAX + 5; i++) store.localApply([shape(`o${i}`)]);
    for (let i = 0; i < ANNOTATION_HISTORY_MAX + 5; i++) store.undo();
    // The five oldest adds could not be undone
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
    expect(useAnnotationStore.getState().canUndo).toBe(false);
  });

  it('history is ALSO bounded by bytes: an undone clear full of images evicts older entries', () => {
    const store = useAnnotationStore.getState();
    const big = (id: string): AnnotationOp => ({
      t: 'add',
      obj: { id, kind: 'image', src: `data:image/webp;base64,${'A'.repeat(Math.floor(ANNOTATION_HISTORY_BYTES_MAX / 3))}`, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    });
    store.localApply([shape('first')]);
    store.localApply([big('i1')]);
    store.localApply([big('i2')]);
    store.localApply([big('i3')]); // three entries of a third each — over budget with 'first'
    // The oldest entries were evicted to stay under the budget; the newest always survives
    let undone = 0;
    while (useAnnotationStore.getState().canUndo) { store.undo(); undone++; }
    expect(undone).toBeLessThan(4);
    expect(undone).toBeGreaterThanOrEqual(1);
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toContain('first');
  });

  it('remote ops and hydration never enter the history; teardown and clearViewerScene empty it', () => {
    const store = useAnnotationStore.getState();
    store.applyRemoteOps('chan-1', 1, [shape('remote')]);
    store.hydrate('chan-1', 2, { objects: [] });
    expect(useAnnotationStore.getState().canUndo).toBe(false);

    store.localApply([shape('a')]);
    expect(useAnnotationStore.getState().canUndo).toBe(true);
    store.teardownSharerSession();
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: false, canRedo: false });

    store.localApply([shape('b')]);
    store.undo();
    store.clearViewerScene();
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('undo/redo outside a voice channel leave the stacks untouched (localApply would silently no-op)', () => {
    const store = useAnnotationStore.getState();
    store.localApply([shape('a')]);
    voiceMock.setState({ activeChannelId: null });
    store.undo();
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: true, canRedo: false });
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    voiceMock.setState({ activeChannelId: 'chan-1' });
    store.undo();
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(0);
    voiceMock.setState({ activeChannelId: null });
    store.redo();
    expect(useAnnotationStore.getState()).toMatchObject({ canUndo: false, canRedo: true });
  });

  it('undo/redo flush immediately and drop the selection', async () => {
    const store = useAnnotationStore.getState();
    store.localApply([shape('a')]);
    await drainWire(); // the add is on the wire before the undo
    vi.clearAllMocks();
    store.setSelectedObjectId('a');
    store.undo();
    // No batch interval elapsed: the inverse shipped on its own, at once
    expect(socketEmit).toHaveBeenCalledTimes(1);
    expect(socketEmit.mock.calls[0][1].ops).toEqual([{ t: 'remove', id: 'a' }]);
    expect(useAnnotationStore.getState().selectedObjectId).toBeNull();
  });
});

// ─── Vanishing ink ──────────────────────────────────────────────────────────

describe('annotationStore — vanishing ink', () => {
  const vanishing = (id: string): AnnotationOp => ({ t: 'add', obj: { id, kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.005, points: [0.1, 0.1, 0.2, 0.2], fade: true } });

  it('the sharer removes a finished vanishing stroke after ANNOTATION_FADE_AFTER_MS, not before, and ships the remove', async () => {
    const store = useAnnotationStore.getState();
    store.beginGesture();
    store.localApply([vanishing('v')]);
    vi.advanceTimersByTime(ANNOTATION_FADE_AFTER_MS * 2); // still drawing: no countdown yet
    store.localApply([{ t: 'append', id: 'v', points: [0.3, 0.3] }]);
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    store.endGesture(); // finished: countdown starts
    store.flushOps();
    socketEmit.mock.calls[0][2]({ ok: true }); // batches serialize on their acks
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOTATION_FADE_AFTER_MS - 1);
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    // Ack whatever is in flight so the queued remove reaches the wire
    for (let i = 0; i < socketEmit.mock.calls.length; i++) {
      socketEmit.mock.calls[i][2]?.({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
    }
    const last = socketEmit.mock.calls.at(-1)![1].ops as AnnotationOp[];
    expect(last).toEqual([{ t: 'remove', id: 'v' }]);
  });

  it('the scheduled remove is not a history entry, and a stroke undone before its time is simply gone', () => {
    const store = useAnnotationStore.getState();
    store.beginGesture();
    store.localApply([vanishing('v')]);
    store.endGesture();
    store.undo();
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    vi.advanceTimersByTime(ANNOTATION_FADE_AFTER_MS + 10);
    expect(useAnnotationStore.getState().canRedo).toBe(true); // the timer did not touch the history
    // Redo re-adds it outside a gesture: it is finished, so it vanishes again on schedule
    store.redo();
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    vi.advanceTimersByTime(ANNOTATION_FADE_AFTER_MS);
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });

  it('every client keeps a local clock: add/append touch it, remove/clear forget it, hydration starts it', () => {
    const live = useAnnotationLiveStore.getState();
    const store = useAnnotationStore.getState();
    store.applyRemoteOps('chan-1', 1, [vanishing('r')]);
    expect(useAnnotationLiveStore.getState().fading.get('r')).toEqual({ at: Date.now(), hidden: false });
    vi.advanceTimersByTime(500);
    store.applyRemoteOps('chan-1', 2, [{ t: 'append', id: 'r', points: [0.4, 0.4] }]);
    expect(useAnnotationLiveStore.getState().fading.get('r')!.at).toBe(Date.now());
    store.applyRemoteOps('chan-1', 3, [{ t: 'remove', id: 'r' }]);
    expect(useAnnotationLiveStore.getState().fading.has('r')).toBe(false);

    const objOf = (op: AnnotationOp) => (op as { obj: AnnotationObject }).obj;
    store.hydrate('chan-1', 10, { objects: [objOf(vanishing('h')), objOf(stroke('plain'))] });
    expect(useAnnotationLiveStore.getState().fading.has('h')).toBe(true);
    expect(useAnnotationLiveStore.getState().fading.has('plain')).toBe(false);
    store.applyRemoteOps('chan-1', 11, [{ t: 'clear' }]);
    expect(useAnnotationLiveStore.getState().fading.size).toBe(0);
    expect(live).toBeDefined();
  });

  it('teardown cancels pending countdowns', () => {
    const store = useAnnotationStore.getState();
    store.beginGesture();
    store.localApply([vanishing('v')]);
    store.endGesture();
    store.teardownSharerSession();
    socketEmit.mockClear();
    vi.advanceTimersByTime(ANNOTATION_FADE_AFTER_MS + 10);
    expect(socketEmit).not.toHaveBeenCalled();
  });

  it('ink mode is a device preference: set, persisted, reloaded', () => {
    useAnnotationStore.getState().setInkMode('vanishing');
    expect(useAnnotationStore.getState().inkMode).toBe('vanishing');
    expect(JSON.parse(localStorage.getItem('vox:annotations:prefs')!)).toMatchObject({ inkMode: 'vanishing' });
    expect(loadAnnotationPrefs().inkMode).toBe('vanishing');
    localStorage.setItem('vox:annotations:prefs', '{"inkMode":"weird"}');
    expect(loadAnnotationPrefs()).toEqual({ inkMode: 'persistent', textSize: 0.045, recentColors: [] });
    localStorage.setItem('vox:annotations:prefs', 'not json');
    expect(loadAnnotationPrefs()).toEqual({ inkMode: 'persistent', textSize: 0.045, recentColors: [] });
    localStorage.removeItem('vox:annotations:prefs');
    useAnnotationStore.getState().setInkMode('persistent');
  });
});

// ─── Colour and text size ───────────────────────────────────────────────────

describe('annotationStore — colour and text size', () => {
  const shape = (id: string): AnnotationOp => ({ t: 'add', obj: { id, kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  const caption = (id: string): AnnotationOp => ({ t: 'add', obj: { id, kind: 'text', text: 'hi', color: '#00ff00', size: 0.045, x: 0.1, y: 0.1 } });
  const image = (id: string): AnnotationOp => ({ t: 'add', obj: { id, kind: 'image', src: 'data:image/webp;base64,AAAA', x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });

  afterEach(() => { localStorage.removeItem('vox:annotations:prefs'); });

  it('setColor changes the default, and with a selection recolours that object as its own undo step', () => {
    const store = useAnnotationStore.getState();
    store.localApply([shape('s')]);
    store.setColor('#0a84ff');
    expect(useAnnotationStore.getState().color).toBe('#0a84ff');
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ color: '#00ff00' }); // nothing selected: untouched
    store.setSelectedObjectId('s');
    store.setColor('#ff3b30');
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ color: '#ff3b30' });
    store.undo();
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ color: '#00ff00' });
    expect(useAnnotationStore.getState().color).toBe('#ff3b30'); // the default keeps the pick
  });

  it('setColor leaves a selected object whose kind has no colour (an image) alone', () => {
    const store = useAnnotationStore.getState();
    store.localApply([image('i')]);
    store.setSelectedObjectId('i');
    store.setColor('#ff3b30');
    expect(useAnnotationStore.getState().canUndo).toBe(true); // only the add
    store.undo();
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });

  it('recents: opt-in per pick, most recent first, de-duplicated, capped at 6, persisted', () => {
    const store = useAnnotationStore.getState();
    store.setColor('#111111'); // quick swatch: not a recent
    expect(useAnnotationStore.getState().recentColors).toEqual([]);
    for (const c of ['#aa0000', '#bb0000', '#cc0000', '#dd0000', '#ee0000', '#ff0001', '#aa0000', '#123456']) store.setColor(c, { recent: true });
    expect(useAnnotationStore.getState().recentColors).toEqual(['#123456', '#aa0000', '#ff0001', '#ee0000', '#dd0000', '#cc0000']);
    expect(loadAnnotationPrefs().recentColors).toEqual(['#123456', '#aa0000', '#ff0001', '#ee0000', '#dd0000', '#cc0000']);
  });

  it('setStrokeWidth follows a selected stroke/shape/arrow on a v2 server only', () => {
    const store = useAnnotationStore.getState();
    store.localApply([stroke('s')]);
    store.setSelectedObjectId('s');
    store.setStrokeWidth(0.008);
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ width: 0.008 });
    expect(useAnnotationStore.getState().strokeWidth).toBe(0.008);
    store.undo();
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ width: 0.005 });

    voiceMock.setState({ screenShareAnnotationsVersion: 1 });
    store.setStrokeWidth(0.002);
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ width: 0.005 }); // `width` is a v2 patch key
    expect(useAnnotationStore.getState().strokeWidth).toBe(0.002);
    voiceMock.setState({ screenShareAnnotationsVersion: 2 });
  });

  it('setTextSize clamps, persists, and resizes a selected caption or badge', () => {
    const store = useAnnotationStore.getState();
    store.localApply([caption('t')]);
    store.setTextSize(0.07);
    expect(useAnnotationStore.getState().textSize).toBe(0.07);
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ size: 0.045 });
    store.setSelectedObjectId('t');
    store.setTextSize(5); // clamped to the wire cap
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ size: 0.2 });
    expect(loadAnnotationPrefs().textSize).toBe(0.2);
    store.undo();
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ size: 0.045 });
  });
});

// ─── Sharer path: editing actions ───────────────────────────────────────────

describe('annotationStore — editing actions', () => {
  it('undo reverts the most recent ACTION and flushes immediately', async () => {
    // Two separate actions (one localApply call = one history entry)
    useAnnotationStore.getState().localApply([stroke('first')]);
    useAnnotationStore.getState().localApply([stroke('second')]);
    useAnnotationStore.getState().flushOps();
    socketEmit.mock.calls[0][2]({ ok: true }); // free the drain loop
    await Promise.resolve();
    socketEmit.mockClear();

    useAnnotationStore.getState().undo();
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['first']);
    expect(socketEmit).toHaveBeenCalledTimes(1);
    expect(socketEmit.mock.calls[0][1].ops).toEqual([{ t: 'remove', id: 'second' }]);
  });

  it('clearAll empties the scene and ships a clear op', () => {
    useAnnotationStore.getState().localApply([stroke('a')]);
    useAnnotationStore.getState().clearAll();
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(0);
    const lastCall = socketEmit.mock.calls[socketEmit.mock.calls.length - 1];
    expect(lastCall[1].ops[lastCall[1].ops.length - 1]).toEqual({ t: 'clear' });
  });

  it('masks stay local: mask CRUD never enqueues ops', () => {
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    useAnnotationStore.getState().updateMask('m1', { x: 0.3 });
    useAnnotationStore.getState().removeMask('m1');
    vi.advanceTimersByTime(ANNOTATION_BATCH_INTERVAL_MS * 2);
    expect(socketEmit).not.toHaveBeenCalled();
  });

  it('mask CRUD updates local mask state immutably', () => {
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const before = useAnnotationStore.getState().masks;
    useAnnotationStore.getState().updateMask('m1', { w: 0.5 });
    expect(useAnnotationStore.getState().masks).not.toBe(before);
    expect(useAnnotationStore.getState().masks[0]).toEqual({ id: 'm1', x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
  });
});

// ─── Lifecycle guard ────────────────────────────────────────────────────────

describe('annotationStore — screen-share lifecycle guard', () => {
  it('clears the scene when the sharer changes or the share ends', () => {
    voiceMock.setState({ screenSharingUserId: 'sharer-1' });
    useAnnotationStore.getState().hydrate('chan-1', 5, { objects: [{ id: 'x', kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.004, points: [0, 0, 1, 1] }] });

    voiceMock.setState({ screenSharingUserId: null }); // share stopped
    const s = useAnnotationStore.getState();
    expect(s.scene.objects).toHaveLength(0);
    expect(s.rev).toBe(0);
    expect(s.sceneChannelId).toBeNull();
  });

  it('a sharer handoff (A→B) also clears — the new share rebuilds via hydration', () => {
    voiceMock.setState({ screenSharingUserId: 'user-a' });
    useAnnotationStore.getState().hydrate('chan-1', 5, { objects: [{ id: 'x', kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.004, points: [0, 0, 1, 1] }] });
    voiceMock.setState({ screenSharingUserId: 'user-b' });
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(0);
  });

  it('tears down the sharer session (masks, editing, queue) when our own share ends', () => {
    voiceMock.setState({ screenSharingUserId: 'me', isScreenSharing: true });
    useAnnotationStore.getState().setIsEditing(true);
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0, y: 0, w: 0.1, h: 0.1 });
    useAnnotationStore.getState().localApply([stroke('pending')]);
    socketEmit.mockClear();

    voiceMock.setState({ screenSharingUserId: null, isScreenSharing: false });

    const s = useAnnotationStore.getState();
    expect(s.isEditing).toBe(false);
    expect(s.masks).toEqual([]);
    // Queued ops must NOT ship after the share ended
    vi.advanceTimersByTime(ANNOTATION_BATCH_INTERVAL_MS * 2);
    expect(socketEmit).not.toHaveBeenCalled();
    // The compositor draw loop dies too — this path also covers teardowns
    // that bypass stopScreenShare (socket reconnect clears state directly)
    expect(compositeMock.teardownComposite).toHaveBeenCalled();
  });
});

// ─── Mask → compositor transitions ──────────────────────────────────────────

describe('annotationStore — compositor wiring', () => {
  function startOwnShare() {
    voiceMock.setState({
      screenSharingUserId: 'me',
      isScreenSharing: true,
      screenStream: { getVideoTracks: () => [{ readyState: 'live' }] },
    });
  }

  it('first mask starts the compositor with live handles AND gates the producer synchronously', () => {
    startOwnShare();
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(compositeMock.ensureComposite).toHaveBeenCalledTimes(1);
    // The privacy gate must land at dispatch time, not when the transition
    // queue gets around to ensureComposite
    expect(voiceMock.getState().setScreenVideoProducerPaused).toHaveBeenCalledWith(true);
    const handles = compositeMock.ensureComposite.mock.calls[0][0];
    expect(handles.rawTrack).toEqual({ readyState: 'live' });
    // getMasks reads LIVE store state, not a snapshot
    useAnnotationStore.getState().updateMask('m1', { x: 0.5 });
    expect(handles.getMasks()).toEqual([{ id: 'm1', x: 0.5, y: 0.1, w: 0.2, h: 0.2 }]);
  });

  it('wires the fail-closed gate: pause/resume reach the producer, onFatal toasts', () => {
    startOwnShare();
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const handles = compositeMock.ensureComposite.mock.calls[0][0];

    handles.pauseProducer();
    expect(voiceMock.getState().setScreenVideoProducerPaused).toHaveBeenCalledWith(true);
    handles.resumeProducer();
    expect(voiceMock.getState().setScreenVideoProducerPaused).toHaveBeenCalledWith(false);

    handles.onFatal();
    expect(toastError).toHaveBeenCalledWith('voice.annotations.maskFailed');
  });

  it('removing the last mask stops the compositor (raw track restored)', () => {
    startOwnShare();
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    useAnnotationStore.getState().addMask({ id: 'm2', x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    compositeMock.stopComposite.mockClear();

    useAnnotationStore.getState().removeMask('m1');
    expect(compositeMock.stopComposite).not.toHaveBeenCalled(); // one mask still active
    useAnnotationStore.getState().removeMask('m2');
    expect(compositeMock.stopComposite).toHaveBeenCalledTimes(1);
  });

  it('clearMasks stops the compositor', () => {
    startOwnShare();
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    useAnnotationStore.getState().clearMasks();
    expect(compositeMock.stopComposite).toHaveBeenCalled();
  });

  it('does not pause a share whose compositor is already live (second mask add)', () => {
    startOwnShare();
    compositeMock.isCompositing.mockReturnValueOnce(true);
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(voiceMock.getState().setScreenVideoProducerPaused).not.toHaveBeenCalled();
  });

  it('geometry updates do not restart the compositor (sampled per frame)', () => {
    startOwnShare();
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    compositeMock.ensureComposite.mockClear();
    useAnnotationStore.getState().updateMask('m1', { w: 0.6 });
    expect(compositeMock.ensureComposite).not.toHaveBeenCalled();
  });

  it('mask actions while NOT sharing never touch the compositor', () => {
    useAnnotationStore.getState().addMask({ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    useAnnotationStore.getState().clearMasks();
    expect(compositeMock.ensureComposite).not.toHaveBeenCalled();
    expect(compositeMock.stopComposite).not.toHaveBeenCalled();
  });
});
