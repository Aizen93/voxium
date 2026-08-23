import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyAnnotationOps,
  translateAnnotationObject,
  patchableKeysFor,
  ANNOTATION_CALLOUT_MAX,
  type AnnotationObject,
  type AnnotationOp,
  type AnnotationScene,
} from '@voxium/shared';

// Wire v2: arrow / callout / spotlight kinds, stroke.fade, the translate op,
// width/n/x1.. patch keys, server-stamped ownership, and the annotations_v2
// flag that turns all of it off again.

const mockRedis = vi.hoisted(() => ({
  mGet: vi.fn().mockResolvedValue([null, null]),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue(1),
}));
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

const flags = vi.hoisted(() => ({ annotations_v2: true }));
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn((name: string) => (name in flags ? flags[name as keyof typeof flags] : true)),
}));

import { handleAnnotationEvents, annotationsWireVersion } from '../../websocket/annotationHandler';

const CHANNEL = 'chan-1';
const SHARER = 'user-1';

function setup(userId = SHARER) {
  const handlers = new Map<string, Function>();
  const toEmit = vi.fn();
  const socket = {
    id: 'socket-1',
    data: { userId },
    on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler); }),
    to: vi.fn().mockReturnValue({ emit: toEmit }),
    emit: vi.fn(),
  };
  handleAnnotationEvents({} as never, socket as never);
  return { socket, opsHandler: handlers.get('voice:annotation:ops')!, toEmit };
}

function seedRedis(sharer: string | null, stored: { rev: number; sharerUserId: string; scene: AnnotationScene } | null) {
  mockRedis.mGet.mockResolvedValue([sharer, stored ? JSON.stringify(stored) : null]);
}

async function send(opsHandler: Function, ops: unknown) {
  const ack = vi.fn();
  await opsHandler({ channelId: CHANNEL, ops }, ack);
  return ack;
}

function writtenScene(): AnnotationScene {
  const args = mockRedis.eval.mock.calls[0]?.[1] as { arguments: string[] };
  return (JSON.parse(args.arguments[1]) as { scene: AnnotationScene }).scene;
}

const arrow = (o: Partial<Record<string, unknown>> = {}) => ({ id: 'a1', kind: 'arrow', color: '#00ff00', width: 0.004, x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, ...o });
const callout = (o: Partial<Record<string, unknown>> = {}) => ({ id: 'c1', kind: 'callout', color: '#00ff00', size: 0.05, x: 0.2, y: 0.2, n: 1, ...o });
const spotlight = (o: Partial<Record<string, unknown>> = {}) => ({ id: 's1', kind: 'spotlight', x: 0.2, y: 0.2, w: 0.3, h: 0.3, ...o });
const stroke = (o: Partial<Record<string, unknown>> = {}) => ({ id: 'st1', kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.005, points: [0.1, 0.1, 0.2, 0.2], ...o });

beforeEach(() => {
  vi.clearAllMocks();
  flags.annotations_v2 = true;
  mockRedis.mGet.mockResolvedValue([SHARER, null]);
  mockRedis.eval.mockResolvedValue(1);
});

// ─── New kinds ──────────────────────────────────────────────────────────────

describe('wire v2 — new object kinds', () => {
  it('accepts an arrow at the bounds and rejects one unit past', async () => {
    const { opsHandler } = setup();
    expect((await send(opsHandler, [{ t: 'add', obj: arrow({ x1: -0.1, y1: 1.1, heads: 'both' }) }])).mock.calls[0][0]).toEqual({ ok: true, restarted: true });
    for (const bad of [
      arrow({ x1: 1.11 }), arrow({ y2: -0.11 }), arrow({ width: 0.051 }), arrow({ width: 0 }),
      arrow({ heads: 'start' }), arrow({ color: 'red' }), arrow({ x2: 'x' }),
    ]) {
      const ack = await send(opsHandler, [{ t: 'add', obj: bad }]);
      expect(ack.mock.calls[0][0]).toEqual({ ok: false, error: 'Invalid payload' });
    }
  });

  it('accepts a callout numbered 1..ANNOTATION_CALLOUT_MAX and rejects 0, max+1, non-integers', async () => {
    const { opsHandler } = setup();
    expect((await send(opsHandler, [{ t: 'add', obj: callout({ n: ANNOTATION_CALLOUT_MAX }) }])).mock.calls[0][0].ok).toBe(true);
    for (const bad of [callout({ n: 0 }), callout({ n: ANNOTATION_CALLOUT_MAX + 1 }), callout({ n: 1.5 }), callout({ n: '3' }), callout({ size: 0.21 }), callout({ size: 0 })]) {
      expect((await send(opsHandler, [{ t: 'add', obj: bad }])).mock.calls[0][0].ok).toBe(false);
    }
  });

  it('accepts a spotlight (rect or ellipse) and rejects other shapes or bad geometry', async () => {
    const { opsHandler } = setup();
    expect((await send(opsHandler, [{ t: 'add', obj: spotlight({ shape: 'ellipse' }) }])).mock.calls[0][0].ok).toBe(true);
    expect((await send(opsHandler, [{ t: 'add', obj: spotlight() }])).mock.calls[0][0].ok).toBe(true);
    for (const bad of [spotlight({ shape: 'triangle' }), spotlight({ w: 1.2 }), spotlight({ h: NaN })]) {
      expect((await send(opsHandler, [{ t: 'add', obj: bad }])).mock.calls[0][0].ok).toBe(false);
    }
  });

  it('accepts stroke.fade === true and nothing else', async () => {
    const { opsHandler } = setup();
    expect((await send(opsHandler, [{ t: 'add', obj: stroke({ fade: true }) }])).mock.calls[0][0].ok).toBe(true);
    expect((await send(opsHandler, [{ t: 'add', obj: stroke({ fade: false }) }])).mock.calls[0][0].ok).toBe(false);
    expect((await send(opsHandler, [{ t: 'add', obj: stroke({ fade: 1 }) }])).mock.calls[0][0].ok).toBe(false);
  });

  it('still rejects unknown kinds', async () => {
    const { opsHandler } = setup();
    expect((await send(opsHandler, [{ t: 'add', obj: { id: 'x', kind: 'sticker', x: 0, y: 0 } }])).mock.calls[0][0].ok).toBe(false);
  });
});

// ─── Patches and translate ──────────────────────────────────────────────────

describe('wire v2 — patches and translate', () => {
  it('accepts width / n / x1..y2 patch keys within bounds', async () => {
    const { opsHandler } = setup();
    const ack = await send(opsHandler, [
      { t: 'update', id: 'st1', patch: { width: 0.01 } },
      { t: 'update', id: 'c1', patch: { n: 7 } },
      { t: 'update', id: 'a1', patch: { x1: 0.3, y1: 0.3, x2: 0.9, y2: 0.9 } },
    ]);
    expect(ack.mock.calls[0][0].ok).toBe(true);
    for (const bad of [{ width: 0.06 }, { n: 0 }, { x1: 1.2 }, { heads: 'both' }]) {
      expect((await send(opsHandler, [{ t: 'update', id: 'a1', patch: bad }])).mock.calls[0][0].ok).toBe(false);
    }
  });

  it('translate moves every kind and is applied by the shared reducer', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, {
      rev: 3,
      sharerUserId: SHARER,
      scene: { objects: [stroke() as AnnotationObject, arrow() as AnnotationObject, callout() as AnnotationObject] },
    });
    const ack = await send(opsHandler, [
      { t: 'translate', id: 'st1', dx: 0.1, dy: -0.05 },
      { t: 'translate', id: 'a1', dx: 0.1, dy: 0.1 },
      { t: 'translate', id: 'c1', dx: -0.1, dy: 0 },
      { t: 'translate', id: 'missing', dx: 0.5, dy: 0.5 }, // no-op, not an error
    ]);
    expect(ack.mock.calls[0][0]).toEqual({ ok: true });
    const scene = writtenScene();
    const st = scene.objects.find((o) => o.id === 'st1') as { points: number[] };
    expect(st.points.map((v) => Number(v.toFixed(3)))).toEqual([0.2, 0.05, 0.3, 0.15]);
    const a = scene.objects.find((o) => o.id === 'a1') as { x1: number; y2: number };
    expect(a.x1).toBeCloseTo(0.2);
    expect(a.y2).toBeCloseTo(0.6);
    const c = scene.objects.find((o) => o.id === 'c1') as { x: number };
    expect(c.x).toBeCloseTo(0.1);
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:ops', expect.objectContaining({ rev: 4 }));
  });

  it('rejects a translate whose RESULT leaves the wire bounds, even though the delta alone is legal', async () => {
    const { opsHandler } = setup();
    seedRedis(SHARER, { rev: 1, sharerUserId: SHARER, scene: { objects: [stroke({ points: [1.0, 0.5, 1.05, 0.5] }) as AnnotationObject] } });
    const ack = await send(opsHandler, [{ t: 'translate', id: 'st1', dx: 0.1, dy: 0 }]);
    expect(ack.mock.calls[0][0]).toEqual({ ok: false, error: 'Invalid payload' });
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('rejects non-finite or oversized deltas and malformed ids', async () => {
    const { opsHandler } = setup();
    for (const bad of [
      { t: 'translate', id: 'st1', dx: NaN, dy: 0 },
      { t: 'translate', id: 'st1', dx: 1.3, dy: 0 },
      { t: 'translate', id: 'bad id!', dx: 0.1, dy: 0 },
      { t: 'translate', id: 'st1', dx: '0.1', dy: 0 },
    ]) {
      expect((await send(opsHandler, [bad])).mock.calls[0][0].ok).toBe(false);
    }
  });
});

// ─── Ownership ──────────────────────────────────────────────────────────────

describe('wire v2 — server-stamped ownership', () => {
  it('stamps by = the authenticated user on every add, overwriting whatever the client sent', async () => {
    const { opsHandler, toEmit } = setup();
    await send(opsHandler, [
      { t: 'add', obj: stroke({ by: 'someone-else' }) },
      { t: 'add', obj: arrow() },
    ]);
    const scene = writtenScene();
    expect(scene.objects.map((o) => o.by)).toEqual([SHARER, SHARER]);
    // Viewers receive the STAMPED ops, not the client's
    const broadcast = toEmit.mock.calls.find((c) => c[0] === 'voice:annotation:ops')![1] as { ops: AnnotationOp[] };
    const added = broadcast.ops.filter((op): op is { t: 'add'; obj: AnnotationObject } => op.t === 'add');
    expect(added.map((op) => op.obj.by)).toEqual([SHARER, SHARER]);
  });

  it('keeps by through updates and translates (reducer spreads it)', () => {
    const scene = applyAnnotationOps({ objects: [] }, [
      { t: 'add', obj: { ...(stroke() as AnnotationObject), by: 'u9' } },
      { t: 'update', id: 'st1', patch: { color: '#0000ff' } },
      { t: 'translate', id: 'st1', dx: 0.01, dy: 0.01 },
    ]);
    expect(scene.objects[0].by).toBe('u9');
  });
});

// ─── The flag ───────────────────────────────────────────────────────────────

describe('wire v2 — annotations_v2 flag off', () => {
  beforeEach(() => { flags.annotations_v2 = false; });

  it('reports wire version 1', () => {
    expect(annotationsWireVersion()).toBe(1);
    flags.annotations_v2 = true;
    expect(annotationsWireVersion()).toBe(2);
  });

  it('rejects every v2 construct exactly like an unknown one, while v1 ops still pass', async () => {
    const { opsHandler } = setup();
    for (const bad of [
      [{ t: 'add', obj: arrow() }],
      [{ t: 'add', obj: callout() }],
      [{ t: 'add', obj: spotlight() }],
      [{ t: 'add', obj: stroke({ fade: true }) }],
      [{ t: 'translate', id: 'st1', dx: 0.1, dy: 0 }],
      [{ t: 'update', id: 'st1', patch: { width: 0.01 } }],
      [{ t: 'update', id: 'c1', patch: { n: 2 } }],
      [{ t: 'update', id: 'a1', patch: { x1: 0.2 } }],
    ]) {
      expect((await send(opsHandler, bad)).mock.calls[0][0]).toEqual({ ok: false, error: 'Invalid payload' });
    }
    expect((await send(opsHandler, [{ t: 'add', obj: stroke() }, { t: 'update', id: 'st1', patch: { color: '#00ff00' } }])).mock.calls[0][0].ok).toBe(true);
  });
});

// ─── Shared reducer pieces ──────────────────────────────────────────────────

describe('shared reducer — v2', () => {
  it('translateAnnotationObject is pure and kind-aware', () => {
    const st = stroke() as AnnotationObject;
    const moved = translateAnnotationObject(st, 0.1, 0.2) as { points: number[] };
    expect(moved.points.map((v) => Number(v.toFixed(3)))).toEqual([0.2, 0.3, 0.3, 0.4]);
    expect((st as { points: number[] }).points).toEqual([0.1, 0.1, 0.2, 0.2]);
    expect(translateAnnotationObject(spotlight() as AnnotationObject, 0.05, 0.05)).toMatchObject({ x: 0.25, y: 0.25, w: 0.3, h: 0.3 });
    // Unknown kinds (a future wire version) pass through untouched
    const alien = { id: 'z', kind: 'alien', q: 1 } as unknown as AnnotationObject;
    expect(translateAnnotationObject(alien, 1, 1)).toBe(alien);
  });

  it('patchableKeysFor lists the v2 keys and answers [] for unknown kinds', () => {
    expect(patchableKeysFor('arrow')).toEqual(['x1', 'y1', 'x2', 'y2', 'color', 'width']);
    expect(patchableKeysFor('callout')).toContain('n');
    expect(patchableKeysFor('stroke')).toEqual(['color', 'width']);
    expect(patchableKeysFor('alien' as never)).toEqual([]);
  });

  it('mixed fleet: an old scene plus v2 objects round-trips through add/update/remove without throwing', () => {
    let scene: AnnotationScene = { objects: [stroke() as AnnotationObject] };
    scene = applyAnnotationOps(scene, [
      { t: 'add', obj: arrow() as AnnotationObject },
      { t: 'add', obj: spotlight() as AnnotationObject },
      { t: 'update', id: 's1', patch: { w: 0.5, color: '#123456' } }, // color is not patchable on a spotlight → dropped
      { t: 'remove', id: 'a1' },
    ]);
    expect(scene.objects.map((o) => o.id)).toEqual(['st1', 's1']);
    expect(scene.objects[1]).toMatchObject({ w: 0.5 });
    expect((scene.objects[1] as { color?: string }).color).toBeUndefined();
  });
});
