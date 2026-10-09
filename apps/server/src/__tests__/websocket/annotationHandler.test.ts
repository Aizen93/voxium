import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyAnnotationOps,
  ANNOTATION_MAX_OPS_PER_BATCH,
  ANNOTATION_MAX_OBJECTS,
  ANNOTATION_STROKE_MAX_POINTS,
  ANNOTATION_TEXT_MAX,
  ANNOTATION_RATE_PER_MIN,
  ANNOTATION_BYTES_PER_MIN,
  type AnnotationObject,
  type AnnotationScene,
} from '@voxium/shared';

// Mock Redis (shared by annotationHandler and utils/annotationState)
const mockRedis = vi.hoisted(() => ({
  mGet: vi.fn().mockResolvedValue([null, null]),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  // The scene write is a Lua compare-and-set (1 = won, 0 = lost the race)
  eval: vi.fn().mockResolvedValue(1),
}));
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
}));

// Mock rate limiter — always allow (overridden per-test)
vi.mock('../../middleware/rateLimiter', () => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

import { handleAnnotationEvents } from '../../websocket/annotationHandler';
import { annotationKey, getAnnotationState, ANNOTATION_STATE_TTL_SECONDS } from '../../utils/annotationState';
import { socketRateLimit } from '../../middleware/rateLimiter';

// ─── Helpers ────────────────────────────────────────────────────────────────

const CHANNEL = 'chan-1';
const SHARER = 'user-1';

function createMockSocket(userId = SHARER, socketId = 'socket-1') {
  const handlers = new Map<string, Function>();
  const toEmit = vi.fn();
  const socket = {
    id: socketId,
    data: { userId },
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    to: vi.fn().mockReturnValue({ emit: toEmit }),
    emit: vi.fn(),
  };
  return { socket, handlers, toEmit };
}

function setup(userId = SHARER) {
  const { socket, handlers, toEmit } = createMockSocket(userId);
  handleAnnotationEvents({} as never, socket as never);
  const opsHandler = handlers.get('voice:annotation:ops')!;
  return { socket, opsHandler, toEmit };
}

/** Seed the Redis mGet result: [sharer of the channel, stored scene JSON]. */
function seedRedis(sharer: string | null, stored: { rev: number; sharerUserId: string; scene: AnnotationScene } | null) {
  mockRedis.mGet.mockResolvedValue([sharer, stored ? JSON.stringify(stored) : null]);
}

function stroke(id = 'stroke-1', overrides: Partial<AnnotationObject & { points: number[] }> = {}): AnnotationObject {
  return { id, kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.005, points: [0.1, 0.1, 0.2, 0.2], ...overrides } as AnnotationObject;
}

/** Minimal VALID lossless-WebP data URL declaring the given pixel dimensions. */
function webpDataUrl(width: number, height: number): string {
  const w = width - 1, h = height - 1;
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  b[21] = w & 0xff;
  b[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  b[23] = (h >> 2) & 0xff;
  b[24] = (h >> 10) & 0x0f;
  return `data:image/webp;base64,${b.toString('base64')}`;
}

async function send(opsHandler: Function, ops: unknown, channelId: string = CHANNEL) {
  const ack = vi.fn();
  await opsHandler({ channelId, ops }, ack);
  return ack;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(socketRateLimit).mockReturnValue(true);
  mockRedis.mGet.mockResolvedValue([null, null]);
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.get.mockResolvedValue(null);
  mockRedis.eval.mockResolvedValue(1);
});

/** The state JSON the CAS was asked to write, or undefined if it never ran. */
function writtenState(call = 0): string | undefined {
  const args = mockRedis.eval.mock.calls[call]?.[1] as { arguments: string[] } | undefined;
  return args?.arguments[1];
}

/** The rev the CAS was told to EXPECT — i.e. what it believes is in Redis. */
function casExpectedRev(call = 0): string | undefined {
  const args = mockRedis.eval.mock.calls[call]?.[1] as { arguments: string[] } | undefined;
  return args?.arguments[0];
}

/**
 * Drive `mockRedis.eval` with the REAL script's semantics against a seeded
 * value: write only if the caller's expected rev matches the rev actually
 * stored AND the sharer slot still belongs to them.
 *
 * The blanket `mockResolvedValue(1)` in `beforeEach` is fine for tests about
 * what gets written, but it makes any assertion about the DISCARD paths
 * vacuous: the handler used to expect rev 0 against a stored rev of 7, which
 * loses every attempt in production while the stub cheerfully said yes.
 */
function evalLikeTheRealScript(storedRaw: string | null, sharer: string | null) {
  mockRedis.eval.mockImplementation((_script: unknown, opts: unknown) => {
    const { arguments: args } = opts as { arguments: string[] };
    const [expectedRev, , sharerArg] = args;
    if (sharer !== sharerArg) return Promise.resolve(0);
    const m = storedRaw ? /^\{"rev":(\d+)/.exec(storedRaw) : null;
    const currentRev = m ? Number(m[1]) : 0;
    return Promise.resolve(currentRev === Number(expectedRev) ? 1 : 0);
  });
}

// ─── Authorization ──────────────────────────────────────────────────────────

describe('annotationHandler — authorization', () => {
  it('rejects when no screen share is active (no voice:screen key)', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(null, null);
    const ack = await send(opsHandler, [{ t: 'add', obj: stroke() }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Not the active sharer' });
    expect(toEmit).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('rejects a non-sharer even while someone else is sharing', async () => {
    const { opsHandler, toEmit } = setup('user-2');
    seedRedis(SHARER, null);
    const ack = await send(opsHandler, [{ t: 'add', obj: stroke() }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Not the active sharer' });
    expect(toEmit).not.toHaveBeenCalled();
  });

  it('rejects the sharer of a DIFFERENT channel (secure-channel scenario included: those never get a voice:screen key)', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(null, null); // channel-B has no sharer, even though user-1 shares in channel-A
    const ack = await send(opsHandler, [{ t: 'add', obj: stroke() }], 'chan-B');
    expect(mockRedis.mGet).toHaveBeenCalledWith(['voice:screen:chan-B', annotationKey('chan-B')]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Not the active sharer' });
    expect(toEmit).not.toHaveBeenCalled();
  });

  it('accepts the active sharer: applies ops, persists with TTL, broadcasts to voice:{id} excluding sender', async () => {
    const { socket, opsHandler, toEmit } = setup();
    seedRedis(SHARER, null);
    const sent = stroke();
    const ack = await send(opsHandler, [{ t: 'add', obj: sent }]);

    // Stored AND broadcast objects carry the server-stamped owner
    const obj = { ...sent, by: SHARER };
    expect(writtenState()).toBe(
      JSON.stringify({ rev: 1, sharerUserId: SHARER, scene: { objects: [obj] } }),
    );
    // CAS keyed on the scene AND the sharer slot, with the expected rev and TTL
    expect(mockRedis.eval.mock.calls[0][1]).toMatchObject({
      keys: [annotationKey(CHANNEL), `voice:screen:${CHANNEL}`],
      arguments: [String(0), expect.any(String), SHARER, String(ANNOTATION_STATE_TTL_SECONDS)],
    });
    expect(socket.to).toHaveBeenCalledWith(`voice:${CHANNEL}`);
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:ops', {
      channelId: CHANNEL,
      userId: SHARER,
      rev: 1,
      ops: [{ t: 'add', obj }],
    });
    // First batch of a share = scene restart from the server's perspective
    expect(ack).toHaveBeenCalledWith({ ok: true, restarted: true });
  });

  it('a claim-time SEED (rev 0, empty, ours) makes the first batch a normal increment — no restart resync', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, { rev: 0, sharerUserId: SHARER, scene: { objects: [] } });
    const ack = await send(opsHandler, [{ t: 'add', obj: stroke() }]);
    expect(ack).toHaveBeenCalledWith({ ok: true }); // NOT restarted: drafts are never double-sent
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:ops', expect.objectContaining({ rev: 1 }));
    expect(toEmit).not.toHaveBeenCalledWith('voice:annotation:state', expect.anything());
  });

  it('increments rev from the stored scene', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, { rev: 5, sharerUserId: SHARER, scene: { objects: [stroke('old')] } });
    await send(opsHandler, [{ t: 'remove', id: 'old' }]);
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:ops', expect.objectContaining({ rev: 6 }));
  });

  it('recovers from corrupt stored state by starting a fresh scene (and tells the sharer)', async () => {
    const { opsHandler, toEmit } = setup();
    mockRedis.mGet.mockResolvedValue([SHARER, '{not json']);
    const ack = await send(opsHandler, [{ t: 'add', obj: stroke() }]);
    expect(ack).toHaveBeenCalledWith({ ok: true, restarted: true });
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:ops', expect.objectContaining({ rev: 1 }));
  });
});

// ─── Payload validation ─────────────────────────────────────────────────────

describe('annotationHandler — validation', () => {
  async function expectInvalid(ops: unknown, error = 'Invalid payload') {
    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, null);
    const ack = await send(opsHandler, ops);
    expect(ack).toHaveBeenCalledWith({ ok: false, error });
    expect(toEmit).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  }

  it('rejects a non-object payload', async () => {
    const { opsHandler } = setup();
    const ack = vi.fn();
    await opsHandler(null, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Invalid payload' });
  });

  it('does not throw when the callback is missing', async () => {
    const { opsHandler } = setup();
    await expect(opsHandler(null, undefined)).resolves.toBeUndefined();
  });

  it('rejects a non-string channelId', async () => {
    const { opsHandler } = setup();
    const ack = vi.fn();
    await opsHandler({ channelId: 42, ops: [{ t: 'clear' }] }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Invalid payload' });
  });

  it('rejects non-array, empty, and oversized ops batches', async () => {
    await expectInvalid('nope');
    await expectInvalid([]);
    await expectInvalid(Array.from({ length: ANNOTATION_MAX_OPS_PER_BATCH + 1 }, () => ({ t: 'clear' })));
  });

  it('rejects a serialized batch above ANNOTATION_OPS_MAX', async () => {
    const giant = stroke('big', { points: [0.1, 0.1] });
    (giant as { id: string }).id = 'big';
    // A single valid-shaped op inflated past the byte cap via a huge text field
    const ops = [{ t: 'add', obj: { id: 'x', kind: 'text', text: 'a'.repeat(500_000), color: '#ffffff', size: 0.05, x: 0.5, y: 0.5 } }];
    await expectInvalid(ops, 'Payload too large');
  });

  it('rejects unknown op types', async () => {
    await expectInvalid([{ t: 'nuke' }]);
  });

  it('rejects out-of-range and non-finite coordinates', async () => {
    await expectInvalid([{ t: 'add', obj: stroke('s', { points: [0.1, 1.5] }) }]);
    await expectInvalid([{ t: 'add', obj: stroke('s', { points: [NaN, 0.5] }) }]);
    await expectInvalid([{ t: 'append', id: 's', points: [0.1, 0.2, 0.3] }]); // odd length
  });

  it('rejects a single append op above the per-stroke point cap (before any reducer work)', async () => {
    const oversized = Array.from({ length: ANNOTATION_STROKE_MAX_POINTS * 2 + 2 }, () => 0.5);
    await expectInvalid([{ t: 'append', id: 's', points: oversized }]);
  });

  it('rejects bad colors', async () => {
    await expectInvalid([{ t: 'add', obj: stroke('s', { color: 'red' } as never) }]);
    await expectInvalid([{ t: 'add', obj: stroke('s', { color: '#ff00' } as never) }]);
  });

  it('rejects invalid stroke widths', async () => {
    await expectInvalid([{ t: 'add', obj: stroke('s', { width: 0 } as never) }]);
    await expectInvalid([{ t: 'add', obj: stroke('s', { width: 0.5 } as never) }]);
  });

  it('rejects oversize and control-character text', async () => {
    const base = { id: 't1', kind: 'text', color: '#ffffff', size: 0.05, x: 0.5, y: 0.5 };
    await expectInvalid([{ t: 'add', obj: { ...base, text: 'a'.repeat(ANNOTATION_TEXT_MAX + 1) } }]);
    await expectInvalid([{ t: 'add', obj: { ...base, text: 'bad text' } }]);
    await expectInvalid([{ t: 'add', obj: { ...base, text: '' } }]);
  });

  it('rejects non-raster and malformed image data-URLs', async () => {
    const base = { id: 'i1', kind: 'image', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    await expectInvalid([{ t: 'add', obj: { ...base, src: 'data:image/svg+xml;base64,PHN2Zz4=' } }]);
    await expectInvalid([{ t: 'add', obj: { ...base, src: 'https://evil.example/x.png' } }]);
    await expectInvalid([{ t: 'add', obj: { ...base, src: 'data:image/webp;base64,!!!' } }]);
  });

  it('accepts an image within the decoded-dimension cap, rejects bombs and unparseable headers', async () => {
    const base = { id: 'i1', kind: 'image', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, null);
    const ack = await send(opsHandler, [{ t: 'add', obj: { ...base, src: webpDataUrl(512, 512) } }]);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(toEmit).toHaveBeenCalled();
    mockRedis.eval.mockClear(); // expectInvalid asserts no writes — isolate from the accepted batch above

    // Small BYTES, enormous declared pixel grid — the classic image bomb
    await expectInvalid([{ t: 'add', obj: { ...base, src: webpDataUrl(8192, 8192) } }]);
    // Valid base64 charset but no recognizable container header — fail closed
    await expectInvalid([{ t: 'add', obj: { ...base, src: 'data:image/webp;base64,AAAA' } }]);
  });

  it('rejects invalid update patches', async () => {
    await expectInvalid([{ t: 'update', id: 's', patch: {} }]);
    await expectInvalid([{ t: 'update', id: 's', patch: { evil: true } }]);
    await expectInvalid([{ t: 'update', id: 's', patch: { x: 99 } }]);
  });

  it('rejects malformed ids', async () => {
    await expectInvalid([{ t: 'remove', id: 'a'.repeat(41) }]);
    await expectInvalid([{ t: 'remove', id: 'bad id!' }]);
  });
});

// ─── Scene caps ─────────────────────────────────────────────────────────────

describe('annotationHandler — scene caps', () => {
  it('rejects a batch that would exceed ANNOTATION_MAX_OBJECTS (no SET, no broadcast)', async () => {
    const { opsHandler, toEmit } = setup();
    const objects = Array.from({ length: ANNOTATION_MAX_OBJECTS }, (_, i) => stroke(`s-${i}`));
    seedRedis(SHARER, { rev: 10, sharerUserId: SHARER, scene: { objects } });
    const ack = await send(opsHandler, [{ t: 'add', obj: stroke('one-too-many') }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Scene limit reached' });
    expect(mockRedis.eval).not.toHaveBeenCalled();
    expect(toEmit).not.toHaveBeenCalled();
  });

  it('rejects appends that push a stroke past ANNOTATION_STROKE_MAX_POINTS', async () => {
    const { opsHandler } = setup();
    const maxPoints = Array.from({ length: ANNOTATION_STROKE_MAX_POINTS * 2 }, () => 0.5);
    seedRedis(SHARER, { rev: 1, sharerUserId: SHARER, scene: { objects: [stroke('full', { points: maxPoints })] } });
    const ack = await send(opsHandler, [{ t: 'append', id: 'full', points: [0.1, 0.1] }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Scene limit reached' });
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('rejects a batch that would exceed the serialized scene cap', async () => {
    const { opsHandler } = setup();
    const bloated = { id: 'img', kind: 'image' as const, src: `data:image/webp;base64,${'A'.repeat(797_000)}`, x: 0, y: 0, w: 0.5, h: 0.5 };
    seedRedis(SHARER, { rev: 1, sharerUserId: SHARER, scene: { objects: [bloated] } });
    const ack = await send(opsHandler, [{ t: 'add', obj: stroke('extra', { points: Array.from({ length: 2000 }, () => 0.5) }) }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Scene limit reached' });
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});

// ─── Rate limiting & errors ─────────────────────────────────────────────────

describe('annotationHandler — rate limiting and errors', () => {
  it('consults socketRateLimit with the annotation bucket and rate', async () => {
    const { socket, opsHandler } = setup();
    seedRedis(SHARER, null);
    await send(opsHandler, [{ t: 'clear' }]);
    expect(socketRateLimit).toHaveBeenCalledWith(socket, 'voice:annotation:ops', ANNOTATION_RATE_PER_MIN);
  });

  it('acks a rate-limit rejection without touching Redis', async () => {
    const { opsHandler, toEmit } = setup();
    vi.mocked(socketRateLimit).mockReturnValueOnce(false);
    const ack = await send(opsHandler, [{ t: 'clear' }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Rate limited' });
    expect(mockRedis.mGet).not.toHaveBeenCalled();
    expect(toEmit).not.toHaveBeenCalled();
  });

  it('acks an internal error when Redis fails (never throws)', async () => {
    const { opsHandler } = setup();
    mockRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
    const ack = await send(opsHandler, [{ t: 'clear' }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Internal error' });
  });

  it('enforces the per-minute byte budget across batches (Redis write amplification guard)', async () => {
    const { opsHandler } = setup();
    seedRedis(SHARER, null);
    // Ten same-id max-point strokes (adds REPLACE, so the scene stays inside
    // the object/point budgets) — each batch burns ~160K serialized chars.
    const maxPoints = Array.from({ length: ANNOTATION_STROKE_MAX_POINTS * 2 }, () => 0.5);
    const batch = Array.from({ length: 10 }, (_, i) => ({ t: 'add', obj: stroke(`s-${i}`, { points: maxPoints }) }));
    const batchChars = JSON.stringify(batch).length;
    const fitting = Math.floor(ANNOTATION_BYTES_PER_MIN / batchChars);
    expect(fitting).toBeGreaterThan(2); // sanity: the loop below actually exercises multiple accepted batches

    for (let i = 0; i < fitting; i++) {
      const ack = await send(opsHandler, batch);
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    }
    const rejected = await send(opsHandler, batch);
    expect(rejected).toHaveBeenCalledWith({ ok: false, error: 'Rate limited' });
  });

  it('enforces the scene-wide stroke point budget (viewer redraw DoS guard)', async () => {
    const { opsHandler } = setup();
    const maxPoints = Array.from({ length: ANNOTATION_STROKE_MAX_POINTS * 2 }, () => 0.5);
    // Seeded at exactly the budget: 10 max-length strokes
    const objects = Array.from({ length: 10 }, (_, i) => stroke(`s-${i}`, { points: maxPoints }));
    seedRedis(SHARER, { rev: 3, sharerUserId: SHARER, scene: { objects } });
    const ack = await send(opsHandler, [{ t: 'append', id: 's-0', points: [0.1, 0.1] }]);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Scene limit reached' });
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('rejects bidi-override and zero-width characters in text (spoofing guard)', async () => {
    const base = { id: 't1', kind: 'text', color: '#ffffff', size: 0.05, x: 0.5, y: 0.5 };
    const { opsHandler } = setup();
    seedRedis(SHARER, null);
    for (const evil of ['safe‮live', 'zero​width', 'iso⁦late', 'bom﻿']) {
      const ack = await send(opsHandler, [{ t: 'add', obj: { ...base, text: evil } }]);
      expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Invalid payload' });
    }
  });
});

// ─── Scene-restart re-baseline (rev reset) ──────────────────────────────────

describe('annotationHandler — scene-restart snapshot', () => {
  it('broadcasts a full voice:annotation:state alongside ops when the stored scene was missing', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, null); // no stored scene — fresh share OR mid-session Redis loss
    const obj = stroke();
    await send(opsHandler, [{ t: 'add', obj }]);

    expect(toEmit).toHaveBeenCalledWith('voice:annotation:ops', expect.objectContaining({ rev: 1 }));
    // `restarted` is how a viewer tells this snapshot from a join-race one:
    // revs cannot. Without it a viewer at rev 60 replayed its buffered
    // pre-restart batches over the rev-1 snapshot and pinned itself at 60,
    // dropping the sharer's resync (rev 2, 3, …) as stale for the rest of
    // the share.
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:state', {
      channelId: CHANNEL,
      sharingUserId: SHARER,
      rev: 1,
      scene: { objects: [{ ...obj, by: SHARER }] },
      restarted: true,
    });
  });

  it('broadcasts the snapshot when the stored scene was corrupt (rev restarted invisibly)', async () => {
    const { opsHandler, toEmit } = setup();
    mockRedis.mGet.mockResolvedValue([SHARER, '{not json']);
    await send(opsHandler, [{ t: 'add', obj: stroke() }]);
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:state', expect.objectContaining({ rev: 1, restarted: true }));
  });

  it('does NOT broadcast a snapshot (nor flag restarted) on a normal incremental batch', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, { rev: 5, sharerUserId: SHARER, scene: { objects: [stroke('old')] } });
    const ack = await send(opsHandler, [{ t: 'remove', id: 'old' }]);
    const stateEmits = toEmit.mock.calls.filter(([event]) => event === 'voice:annotation:state');
    expect(stateEmits).toHaveLength(0);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });
});

// ─── annotationState utils ──────────────────────────────────────────────────

describe('annotationState', () => {
  it('parses stored state and rejects malformed payloads', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ rev: 3, sharerUserId: SHARER, scene: { objects: [] } }));
    expect(await getAnnotationState(CHANNEL)).toEqual({ rev: 3, sharerUserId: SHARER, scene: { objects: [] } });

    mockRedis.get.mockResolvedValueOnce('{broken');
    expect(await getAnnotationState(CHANNEL)).toBeNull();

    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ rev: 'x', scene: {} }));
    expect(await getAnnotationState(CHANNEL)).toBeNull();

    mockRedis.get.mockResolvedValueOnce(null);
    expect(await getAnnotationState(CHANNEL)).toBeNull();
  });
});

// ─── Shared reducer semantics ───────────────────────────────────────────────

describe('applyAnnotationOps (shared reducer)', () => {
  const empty: AnnotationScene = { objects: [] };

  it('adds, replaces same-id adds, and never mutates the input', () => {
    const s1 = applyAnnotationOps(empty, [{ t: 'add', obj: stroke('a') }]);
    expect(empty.objects).toHaveLength(0);
    expect(s1.objects).toHaveLength(1);
    const replacement = stroke('a', { color: '#00ff00' } as never);
    const s2 = applyAnnotationOps(s1, [{ t: 'add', obj: replacement }]);
    expect(s2.objects).toHaveLength(1);
    expect((s2.objects[0] as { color: string }).color).toBe('#00ff00');
  });

  it('appends points to strokes and no-ops on missing or non-stroke ids', () => {
    const text: AnnotationObject = { id: 'txt', kind: 'text', text: 'hi', color: '#ffffff', size: 0.05, x: 0.1, y: 0.1 };
    const base = applyAnnotationOps(empty, [{ t: 'add', obj: stroke('a') }, { t: 'add', obj: text }]);
    const appended = applyAnnotationOps(base, [
      { t: 'append', id: 'a', points: [0.3, 0.3] },
      { t: 'append', id: 'missing', points: [0.4, 0.4] },
      { t: 'append', id: 'txt', points: [0.5, 0.5] },
    ]);
    expect((appended.objects[0] as { points: number[] }).points).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
    expect(appended.objects[1]).toEqual(text);
  });

  it('applies only kind-appropriate patch keys on update', () => {
    const img: AnnotationObject = { id: 'img', kind: 'image', src: 'data:image/webp;base64,AA==', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const base = applyAnnotationOps(empty, [{ t: 'add', obj: img }]);
    const updated = applyAnnotationOps(base, [{ t: 'update', id: 'img', patch: { x: 0.4, text: 'ignored', color: '#123456' } }]);
    const obj = updated.objects[0] as Record<string, unknown>;
    expect(obj.x).toBe(0.4);
    expect(obj.text).toBeUndefined();
    expect(obj.color).toBeUndefined();
  });

  it('removes by id and clears everything', () => {
    const base = applyAnnotationOps(empty, [{ t: 'add', obj: stroke('a') }, { t: 'add', obj: stroke('b') }]);
    expect(applyAnnotationOps(base, [{ t: 'remove', id: 'a' }]).objects.map((o) => o.id)).toEqual(['b']);
    expect(applyAnnotationOps(base, [{ t: 'clear' }]).objects).toHaveLength(0);
  });
});

// ─── Scene write is a compare-and-set (F8) ──────────────────────────────────
//
// The read-modify-write was single-writer only because the CLIENT promises to
// serialize its batches on their acks. A modified client can pipeline freely,
// and a server stall between the read and the write is enough on its own —
// either way one batch silently clobbers the other's ops.

describe('annotationHandler — concurrent scene writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(socketRateLimit).mockReturnValue(true);
    mockRedis.eval.mockResolvedValue(1);
  });

  it('re-reads and RE-APPLIES the ops when it loses the race, instead of clobbering', async () => {
    const { opsHandler, toEmit } = setup();
    const mine = stroke('mine');
    const theirs = stroke('theirs');

    // First attempt reads an empty scene and loses; the retry sees the scene
    // the winner wrote and applies our ops on top of it.
    mockRedis.mGet
      .mockResolvedValueOnce([SHARER, null])
      .mockResolvedValueOnce([SHARER, JSON.stringify({ rev: 1, sharerUserId: SHARER, scene: { objects: [theirs] } })]);
    mockRedis.eval.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const ack = await send(opsHandler, [{ t: 'add', obj: mine }]);

    expect(mockRedis.eval).toHaveBeenCalledTimes(2);
    // The winner's object survives, ours is added, and the rev follows theirs
    expect(writtenState(1)).toBe(
      JSON.stringify({ rev: 2, sharerUserId: SHARER, scene: { objects: [theirs, { ...mine, by: SHARER }] } }),
    );
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:ops', expect.objectContaining({ rev: 2 }));
    // Contention is invisible to the sharer — no error, no spurious restart
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it('refuses rather than clobbering when it keeps losing', async () => {
    const { opsHandler, toEmit } = setup();
    seedRedis(SHARER, null);
    mockRedis.eval.mockResolvedValue(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ack = await send(opsHandler, [{ t: 'add', obj: stroke() }]);

    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Scene is being modified concurrently' });
    expect(toEmit).not.toHaveBeenCalled(); // never announce ops that were not stored
    warn.mockRestore();
  });

  it('does NOT inherit a scene left by the PREVIOUS sharer', async () => {
    // The release-side scene delete is fire-and-forget, so a fast first batch
    // from the new sharer can still read the old one's objects. Extending it
    // would ship someone else's annotations under this sharer's name.
    const { opsHandler } = setup();
    const theirs = stroke('previous-sharers-drawing');
    const mine = stroke('mine');
    const stored = JSON.stringify({ rev: 7, sharerUserId: 'someone-else', scene: { objects: [theirs] } });
    mockRedis.mGet.mockResolvedValue([SHARER, stored]);
    // Real CAS semantics: expecting the wrong rev here loses, as it would live.
    evalLikeTheRealScript(stored, SHARER);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ack = await send(opsHandler, [{ t: 'add', obj: mine }]);

    // The EXPECTATION describes what is in Redis (7), not the empty scene we
    // chose to build on. Passing 0 here loses all three attempts and wedges
    // annotations for the rest of the share, since nothing rewrites the key.
    expect(casExpectedRev()).toBe('7');
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    // Their objects are gone; the counter continues rather than going backwards
    // under viewers who already hydrated the discarded scene.
    expect(writtenState()).toBe(
      JSON.stringify({ rev: 8, sharerUserId: SHARER, scene: { objects: [{ ...mine, by: SHARER }] } }),
    );
    // A fresh scene from the server's perspective — the sharer must re-send
    expect(ack).toHaveBeenCalledWith({ ok: true, restarted: true });
    warn.mockRestore();
  });

  it('writes over a structurally invalid scene of its OWN instead of losing to it', async () => {
    // `rev` is a number so the Lua's prefix match reads 9, but `scene.objects`
    // is not an array so the handler cannot adopt it — the same divergence as
    // the previous-sharer case, reached without any handoff.
    const { opsHandler } = setup();
    const mine = stroke('mine');
    const stored = '{"rev":9,"sharerUserId":"' + SHARER + '","scene":{"objects":"truncated"}}';
    mockRedis.mGet.mockResolvedValue([SHARER, stored]);
    evalLikeTheRealScript(stored, SHARER);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ack = await send(opsHandler, [{ t: 'add', obj: mine }]);

    expect(casExpectedRev()).toBe('9');
    expect(writtenState()).toBe(
      JSON.stringify({ rev: 10, sharerUserId: SHARER, scene: { objects: [{ ...mine, by: SHARER }] } }),
    );
    expect(ack).toHaveBeenCalledWith({ ok: true, restarted: true });
    warn.mockRestore();
  });

  it('still expects rev 0 when the stored value is corrupt beyond the rev prefix', async () => {
    // The script reads an unmatched value as rev 0, so the handler must too —
    // deriving the expectation the same way is what keeps them in agreement.
    const { opsHandler } = setup();
    mockRedis.mGet.mockResolvedValue([SHARER, '{not json']);
    evalLikeTheRealScript('{not json', SHARER);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ack = await send(opsHandler, [{ t: 'add', obj: stroke('mine') }]);

    expect(casExpectedRev()).toBe('0');
    expect(ack).toHaveBeenCalledWith({ ok: true, restarted: true });
    warn.mockRestore();
  });
});
