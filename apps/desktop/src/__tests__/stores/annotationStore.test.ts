import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ANNOTATION_BATCH_INTERVAL_MS, ANNOTATION_MAX_OPS_PER_BATCH, ANNOTATION_ACK_TIMEOUT_MS, type AnnotationOp } from '@voxium/shared';

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
    replaceScreenVideoTrack: (track: unknown) => Promise<void>;
    setScreenVideoProducerPaused: (paused: boolean) => void;
  };
  const base = (): VoiceShape => ({
    activeChannelId: 'chan-1',
    screenSharingUserId: null,
    isScreenSharing: false,
    screenStream: null,
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

// ─── Sharer path: editing actions ───────────────────────────────────────────

describe('annotationStore — editing actions', () => {
  it('undo removes the most recent object and flushes immediately', async () => {
    useAnnotationStore.getState().localApply([stroke('first'), stroke('second')]);
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
