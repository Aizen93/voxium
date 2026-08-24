import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The live store pulls voiceStore at import (sendLive) — stub the graph
vi.mock('../../services/socket', () => ({ getSocket: () => null }));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ activeChannelId: null }), subscribe: () => () => {} },
  registerShareMaskHooks: vi.fn(),
}));

import { LIMITS, type AnnotationScene } from '@voxium/shared';
import { composeSnapshotCanvas, encodeSnapshot, encodeSnapshotPng, SNAPSHOT_MAX_EDGE } from '../../utils/shareSnapshot';

const EMPTY_SCENE: AnnotationScene = { objects: [] };

type Call = { canvas: string; op: string; args: unknown[] };
let calls: Call[];

function recordingCtx(name: string) {
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    imageSmoothingEnabled: true,
    globalAlpha: 1,
  };
  for (const op of ['clearRect', 'fillRect', 'drawImage', 'save', 'restore', 'beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'stroke', 'fill', 'ellipse', 'fillText', 'setTransform']) {
    ctx[op] = (...args: unknown[]) => calls.push({ canvas: name, op, args });
  }
  return ctx as unknown as CanvasRenderingContext2D;
}

let canvasSeq: number;

beforeEach(() => {
  calls = [];
  canvasSeq = 0;
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = Object.getPrototypeOf(document).constructor.prototype // fall through to real impl
      ? Document.prototype.createElement.call(document, tag)
      : null;
    if (tag === 'canvas') {
      const name = `canvas${canvasSeq++}`;
      const canvas = el as HTMLCanvasElement;
      Object.assign(canvas, {
        getContext: () => recordingCtx(name),
      });
      (canvas as unknown as { __name: string }).__name = name;
    }
    return el as HTMLElement;
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fakeVideo = (w = 1920, h = 1080) =>
  ({ videoWidth: w, videoHeight: h, clientWidth: 800, clientHeight: 450 }) as unknown as HTMLVideoElement;

describe('composeSnapshotCanvas', () => {
  it('composes video first, then the overlay (masks + scene) over it', () => {
    const mask = { id: 'm1', x: 0.25, y: 0.25, w: 0.5, h: 0.25 };
    const canvas = composeSnapshotCanvas(fakeVideo(), EMPTY_SCENE, [mask], new Map());
    expect(canvas).not.toBeNull();
    expect(canvas!.width).toBe(1920);
    expect(canvas!.height).toBe(1080);

    // canvas0 = base, canvas1 = overlay (drawScene clears IT, not the frame)
    const base = calls.filter((c) => c.canvas === 'canvas0');
    const overlay = calls.filter((c) => c.canvas === 'canvas1');
    expect(base[0].op).toBe('drawImage'); // the video frame lands first
    expect(overlay.some((c) => c.op === 'clearRect')).toBe(true); // scene pass clears its OWN surface
    // The mask painted at source resolution on the overlay
    const maskFill = overlay.find((c) => c.op === 'fillRect');
    expect(maskFill).toBeDefined();
    expect((maskFill!.args[0] as number)).toBeCloseTo(0.25 * 1920, 0);
    // …and the overlay is composited back over the frame LAST
    expect(base[base.length - 1].op).toBe('drawImage');
    expect(base.length).toBeGreaterThanOrEqual(2);
  });

  it('with no masks (a viewer: their stream has masks baked in) the overlay paints no cover', () => {
    composeSnapshotCanvas(fakeVideo(), EMPTY_SCENE, [], new Map());
    const overlay = calls.filter((c) => c.canvas === 'canvas1');
    expect(overlay.some((c) => c.op === 'fillRect')).toBe(false);
  });

  it('refuses a frameless video', () => {
    expect(composeSnapshotCanvas(fakeVideo(0, 0), EMPTY_SCENE, [], new Map())).toBeNull();
  });
});

describe('encodeSnapshot', () => {
  function canvasWithBlobSequence(w: number, h: number, sizes: number[]) {
    let call = 0;
    const encoded: { type?: string; quality?: number }[] = [];
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.width = w;
    canvas.height = h;
    const impl = (cb: (b: Blob | null) => void, type?: string, quality?: number) => {
      encoded.push({ type, quality });
      const size = sizes[Math.min(call++, sizes.length - 1)];
      cb({ size, type } as Blob);
    };
    // Both the original and any downscale canvas share this prototype patch
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', { value: impl, configurable: true });
    return { canvas, encoded };
  }

  it('encodes WebP at q=0.92 and returns it when under the cap', async () => {
    const { canvas, encoded } = canvasWithBlobSequence(1920, 1080, [100_000]);
    const blob = await encodeSnapshot(canvas);
    expect(blob!.size).toBe(100_000);
    expect(encoded[0]).toEqual({ type: 'image/webp', quality: 0.92 });
  });

  it('over the cap with a big source: downscales the longest edge to 2560 and re-encodes', async () => {
    const { canvas, encoded } = canvasWithBlobSequence(5120, 2880, [LIMITS.MAX_ATTACHMENT_SIZE + 1, 500_000]);
    const blob = await encodeSnapshot(canvas);
    expect(blob!.size).toBe(500_000);
    expect(encoded).toHaveLength(2);
    // The re-encode drew onto a canvas scaled to the max edge
    const scaled = calls.filter((c) => c.op === 'drawImage').at(-1)!;
    expect(scaled.args[3]).toBe(SNAPSHOT_MAX_EDGE); // width of a 16:9 landscape downscale
  });

  it('still over the cap after the downscale (or a small source): null — the caller toasts', async () => {
    const big = canvasWithBlobSequence(5120, 2880, [LIMITS.MAX_ATTACHMENT_SIZE + 1, LIMITS.MAX_ATTACHMENT_SIZE + 1]);
    expect(await encodeSnapshot(big.canvas)).toBeNull();
    const small = canvasWithBlobSequence(1920, 1080, [LIMITS.MAX_ATTACHMENT_SIZE + 1]);
    expect(await encodeSnapshot(small.canvas)).toBeNull(); // nothing to downscale
  });

  it('the clipboard encode is PNG (ClipboardItem WebP support is not universal)', async () => {
    const { canvas, encoded } = canvasWithBlobSequence(100, 100, [5_000]);
    await encodeSnapshotPng(canvas);
    expect(encoded[0].type).toBe('image/png');
  });
});
