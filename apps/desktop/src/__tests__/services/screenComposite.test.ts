import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderCompositeFrame, ensureComposite, stopComposite, teardownComposite, type CompositeHandles } from '../../services/screenComposite';
import type { MaskRect } from '../../stores/annotationStore';

/**
 * Pure-logic coverage of the privacy compositor's per-frame render. The DOM
 * pipeline around it (video element, captureStream, replaceTrack) is
 * dependency-injected and validated manually on WebView2/Firefox — what these
 * tests pin is the privacy contract: masks are ALWAYS painted, painted last,
 * and fail closed to black.
 */

function mockCtx() {
  const calls: string[] = [];
  return {
    calls,
    drawImage: vi.fn((..._args: unknown[]) => { calls.push('drawImage'); }),
    fillRect: vi.fn((..._args: unknown[]) => { calls.push('fillRect'); }),
    fillStyle: '' as string,
  };
}

const video = { videoWidth: 1920, videoHeight: 1080 };
const noImage = () => null;

function mask(id: string, overrides: Partial<MaskRect> = {}): MaskRect {
  return { id, x: 0.25, y: 0.25, w: 0.5, h: 0.25, ...overrides };
}

let canvas: { width: number; height: number };

beforeEach(() => {
  canvas = { width: 1920, height: 1080 };
});

describe('renderCompositeFrame', () => {
  it('draws the raw frame first, then every mask on top', () => {
    const ctx = mockCtx();
    renderCompositeFrame(ctx, video, canvas, [mask('a'), mask('b', { x: 0 })], noImage);
    expect(ctx.calls).toEqual(['drawImage', 'fillRect', 'fillRect']);
    // Frame fills the whole canvas
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
  });

  it('pads the black box past the mask bounds (encode-bleed guard)', () => {
    const ctx = mockCtx();
    renderCompositeFrame(ctx, video, canvas, [mask('a')], noImage);
    const [x, y, w, h] = ctx.fillRect.mock.calls[0] as unknown as number[];
    expect(x).toBe(0.25 * 1920 - 1);
    expect(y).toBe(0.25 * 1080 - 1);
    expect(w).toBe(0.5 * 1920 + 2);
    expect(h).toBe(0.25 * 1080 + 2);
    expect(ctx.fillStyle).toBe('#000000');
  });

  it('draws the cover image when it is decoded', () => {
    const ctx = mockCtx();
    const img = { fake: 'image' } as unknown as CanvasImageSource;
    renderCompositeFrame(ctx, video, canvas, [mask('a', { src: 'data:image/webp;base64,AA==' })], () => img);
    expect(ctx.calls).toEqual(['drawImage', 'drawImage']);
    expect(ctx.drawImage.mock.calls[1][0]).toBe(img);
  });

  it('fails CLOSED: a mask with an undecoded cover image is painted black, never bare', () => {
    const ctx = mockCtx();
    renderCompositeFrame(ctx, video, canvas, [mask('a', { src: 'data:image/webp;base64,AA==' })], noImage);
    expect(ctx.calls).toEqual(['drawImage', 'fillRect']);
  });

  it('follows a source resolution change: resizes the canvas and reports it', () => {
    const ctx = mockCtx();
    const changed = renderCompositeFrame(ctx, { videoWidth: 1280, videoHeight: 720 }, canvas, [mask('a')], noImage);
    expect(changed).toBe(true);
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    // Frame + mask drawn at the NEW size
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 720);
  });

  it('reports no resize when dimensions already match, and ignores a not-ready source (0x0)', () => {
    const ctx = mockCtx();
    expect(renderCompositeFrame(ctx, video, canvas, [], noImage)).toBe(false);
    expect(renderCompositeFrame(ctx, { videoWidth: 0, videoHeight: 0 }, canvas, [], noImage)).toBe(false);
    expect(canvas.width).toBe(1920);
  });

  it('with no masks, only the raw frame is drawn (compositor about to be torn down)', () => {
    const ctx = mockCtx();
    renderCompositeFrame(ctx, video, canvas, [], noImage);
    expect(ctx.calls).toEqual(['drawImage']);
  });
});

// ─── Fail-closed contract ───────────────────────────────────────────────────
// jsdom cannot run the media pipeline (no MediaStream / captureStream / 2D
// context), so every ensureComposite here fails during setup — which is
// exactly the contract under test: on ANY setup failure the producer must be
// paused first, stay paused, and report via onFatal; removing the masks
// (stopComposite) resumes; teardown clears without resuming.

function failClosedHandles(masks: MaskRect[] = [mask('m1')]) {
  const live = { masks };
  return {
    live,
    rawTrack: { readyState: 'live', getSettings: () => ({}) } as unknown as MediaStreamTrack,
    getMasks: () => live.masks,
    replaceTrack: vi.fn(async (_track: MediaStreamTrack) => {}),
    pauseProducer: vi.fn<() => void>(),
    resumeProducer: vi.fn<() => void>(),
    onFatal: vi.fn<() => void>(),
  } satisfies CompositeHandles & { live: { masks: MaskRect[] } };
}

describe('ensureComposite/stopComposite — fail-closed producer gate', () => {
  beforeEach(async () => {
    teardownComposite(); // clear any state a previous test left behind
    await stopComposite();
    vi.clearAllMocks();
  });

  it('pauses before setup, stays paused + onFatal on failure, resumes only when masks go away', async () => {
    const handles = failClosedHandles();
    await ensureComposite(handles);

    expect(handles.pauseProducer).toHaveBeenCalledTimes(1);
    expect(handles.onFatal).toHaveBeenCalledTimes(1);
    expect(handles.resumeProducer).not.toHaveBeenCalled(); // NEVER fall open to raw

    handles.live.masks = []; // last mask removed
    await stopComposite();
    expect(handles.resumeProducer).toHaveBeenCalledTimes(1);
  });

  it('holds the gate when a mask was re-added before a queued stop ran (1→0→1 race)', async () => {
    const handles = failClosedHandles();
    await ensureComposite(handles);
    // Masks are non-empty again by the time stopComposite gets its turn —
    // resuming would ship raw frames with a mask present
    await stopComposite();
    expect(handles.resumeProducer).not.toHaveBeenCalled();

    handles.live.masks = [];
    await stopComposite();
    expect(handles.resumeProducer).toHaveBeenCalledTimes(1);
  });

  it('a retry (second mask action) re-attempts setup while still gated', async () => {
    const first = failClosedHandles();
    await ensureComposite(first);
    const second = failClosedHandles();
    await ensureComposite(second);
    expect(second.pauseProducer).toHaveBeenCalled();
    expect(second.onFatal).toHaveBeenCalled();
    second.live.masks = [];
    await stopComposite();
    expect(second.resumeProducer).toHaveBeenCalled();
  });

  it('teardownComposite clears the gate WITHOUT resuming (share is over, producers are closing)', async () => {
    const handles = failClosedHandles();
    await ensureComposite(handles);
    teardownComposite();
    await stopComposite();
    expect(handles.resumeProducer).not.toHaveBeenCalled();
  });
});
