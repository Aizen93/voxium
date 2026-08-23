import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderCompositeFrame, ensureComposite, stopComposite, teardownComposite, type CompositeHandles } from '../../services/screenComposite';
import type { MaskRect } from '../../stores/annotationStore';
import { PIXELATE_BLOCK_SRC_PX, type ScratchCanvas } from '../../utils/maskStyles';

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
    save: vi.fn(() => { calls.push('save'); }),
    restore: vi.fn(() => { calls.push('restore'); }),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(() => { calls.push('clip'); }),
    fillStyle: '' as string,
    imageSmoothingEnabled: true,
    filter: 'none' as string,
  };
}

function mockSurface() {
  const canvas = { width: 0, height: 0 };
  const calls: string[] = [];
  const fills: string[] = [];
  const ctx = {
    calls,
    fills,
    drawImage: vi.fn((..._args: unknown[]) => { calls.push('drawImage'); }),
    fillRect: vi.fn((..._args: unknown[]) => { calls.push('fillRect'); fills.push(String(ctx.fillStyle)); }),
    fillStyle: '' as string,
    imageSmoothingEnabled: true,
  };
  return { canvas, ctx };
}

function mockScratch() {
  return { a: mockSurface(), b: mockSurface() } as unknown as ScratchCanvas & { a: ReturnType<typeof mockSurface>; b: ReturnType<typeof mockSurface> };
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

  // mask('a') at 1920×1080: padded dst/src = (479, 269, 962, 272). The 32 px
  // lattice covering it, clamped to the source: x 448..1472 (1024 = 32 blocks),
  // y 256..544 (288 = 9 blocks).
  const CELLS = { x: 448, y: 256, w: 1024, h: 288, blocksW: 32, blocksH: 9 };

  it('a pixelate mask paints TRUE block means (a chain of 2× halvings), lattice-anchored, over a black backstop', () => {
    const ctx = mockCtx();
    const scratch = mockScratch();
    renderCompositeFrame(ctx, video, canvas, [mask('a', { style: 'pixelate' })], noImage, scratch);
    // Frame, then inside save/clip: the opaque backstop FIRST, then the blocks
    expect(ctx.calls).toEqual(['drawImage', 'save', 'clip', 'fillRect', 'drawImage', 'restore']);
    // Five halvings ping-pong a→b→a→b→a, each pre-filled black (edge cells can
    // only darken) and drawn with smoothing ON (bilinear 2× = exact box mean)
    expect(scratch.a.ctx.drawImage).toHaveBeenCalledTimes(3);
    expect(scratch.b.ctx.drawImage).toHaveBeenCalledTimes(2);
    // Each surface is pre-filled BLACK, and always BEFORE its draw — that is
    // what makes an edge cell darken instead of leak
    expect(scratch.a.ctx.calls).toEqual(['fillRect', 'drawImage', 'fillRect', 'drawImage', 'fillRect', 'drawImage']);
    expect(scratch.b.ctx.calls).toEqual(['fillRect', 'drawImage', 'fillRect', 'drawImage']);
    expect(scratch.a.ctx.fills).toEqual(['#000000', '#000000', '#000000']);
    expect(scratch.b.ctx.fills).toEqual(['#000000', '#000000']);
    expect(scratch.a.ctx.imageSmoothingEnabled).toBe(true);
    // First halving samples the SOURCE-ALIGNED cell range, not the mask rect
    expect(scratch.a.ctx.drawImage.mock.calls[0].slice(1, 5)).toEqual([CELLS.x, CELLS.y, CELLS.w, CELLS.h]);
    // The final surface is one pixel per 32 px block
    expect(scratch.a.canvas.width).toBe(CELLS.blocksW);
    expect(scratch.a.canvas.height).toBe(CELLS.blocksH);
    // Painted back at the lattice's own position, unsmoothed, clipped to the mask
    const up = ctx.drawImage.mock.calls[1] as unknown as number[];
    expect(up.slice(1, 5)).toEqual([0, 0, CELLS.blocksW, CELLS.blocksH]);
    expect(up.slice(5, 9)).toEqual([CELLS.x, CELLS.y, CELLS.w, CELLS.h]);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    // The backstop covers the (padded) mask rect
    expect(ctx.fillRect.mock.calls[0]).toEqual([479, 269, 962, 272]);
    expect(ctx.fillStyle).toBe('#000000');
  });

  it('a mask overhanging a non-multiple-of-32 source clamps its sample to real pixels; the rest is the black backstop', () => {
    // Source 1000×700: the lattice rounds up to 1024×704, but sampling must
    // stop at the source edge — the overhang darkens, never wraps or leaks
    const smallVideo = { videoWidth: 1000, videoHeight: 700 };
    const smallCanvas = { width: 1000, height: 700 };
    const ctx = mockCtx();
    const scratch = mockScratch();
    // mask at x 0.9, w 0.2 of 1000 → padded src x 899, w 202 (ends at 1101, past the edge)
    renderCompositeFrame(ctx, smallVideo, smallCanvas, [mask('a', { style: 'pixelate', x: 0.9, y: 0.5, w: 0.2, h: 0.2 })], noImage, scratch);
    const first = scratch.a.ctx.drawImage.mock.calls[0] as unknown as number[];
    // Cells x 896..1024 (the lattice), but the SAMPLE is clamped to 1000
    expect(first.slice(1, 3)).toEqual([896, 320]); // padded y 349 floors to cell 320
    expect(first[3]).toBe(1000 - 896); // sample width stops at the source edge
    // …and lands proportionally in the half-size target so blocks stay aligned
    expect(first[7]).toBeCloseTo((1000 - 896) / 2);
    // The upscale still covers the full lattice span; the backstop covered the rest
    const up = ctx.drawImage.mock.calls[1] as unknown as number[];
    expect(up.slice(5, 7)).toEqual([896, 320]);
    expect(ctx.calls).toEqual(['drawImage', 'save', 'clip', 'fillRect', 'drawImage', 'restore']);
  });

  it('the lattice is anchored to the SOURCE grid: a nudge within a cell samples the very same cells, and every range is grid-aligned', () => {
    // Two positions inside the same 32 px cells (padded x: 459 and 464 both
    // live in cell 14; the right edges both round up to 1440)
    const s1 = mockScratch();
    renderCompositeFrame(mockCtx(), video, canvas, [mask('a', { style: 'pixelate', x: 460 / 1920 })], noImage, s1);
    const s2 = mockScratch();
    renderCompositeFrame(mockCtx(), video, canvas, [mask('a', { style: 'pixelate', x: 465 / 1920 })], noImage, s2);
    expect(s2.a.ctx.drawImage.mock.calls[0].slice(1, 5)).toEqual(s1.a.ctx.drawImage.mock.calls[0].slice(1, 5));
    // A larger move may add or drop whole cells, but the grid never shifts:
    // starts and spans stay multiples of the block size
    const s3 = mockScratch();
    renderCompositeFrame(mockCtx(), video, canvas, [mask('a', { style: 'pixelate', x: 0.25 + 5 / 1920 })], noImage, s3);
    const [, x0, y0, w0, h0] = s3.a.ctx.drawImage.mock.calls[0] as unknown as number[];
    for (const v of [x0, y0, w0, h0]) expect(v % PIXELATE_BLOCK_SRC_PX).toBe(0);
  });

  it('a blur mask paints the pixelated pass first, then a blurred pass over it — never a translucent edge alone', () => {
    const ctx = mockCtx();
    const filters: string[] = [];
    Object.defineProperty(ctx, 'filter', { get: () => filters[filters.length - 1] ?? 'none', set: (v: string) => { filters.push(v); } });
    renderCompositeFrame(ctx, video, canvas, [mask('a', { style: 'blur' })], noImage, mockScratch());
    expect(ctx.calls).toEqual(['drawImage', 'save', 'clip', 'fillRect', 'drawImage', 'drawImage', 'restore']);
    expect(filters[0]).toMatch(/^blur\(\d+px\)$/);
    expect(filters[filters.length - 1]).toBe('none');
  });

  it('fails CLOSED: a styled mask without a scratch canvas, or with a drawing failure, paints black', () => {
    const ctx = mockCtx();
    renderCompositeFrame(ctx, video, canvas, [mask('a', { style: 'blur' })], noImage, null);
    expect(ctx.calls).toEqual(['drawImage', 'fillRect']);
    expect(ctx.fillStyle).toBe('#000000');

    const failing = mockScratch();
    failing.a.ctx.drawImage.mockImplementation(() => { throw new Error('tainted'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx2 = mockCtx();
    renderCompositeFrame(ctx2, video, canvas, [mask('a', { style: 'pixelate' })], noImage, failing);
    expect(ctx2.calls.at(-1)).toBe('fillRect');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a cover image wins over a style; an absent style is the black box', () => {
    const ctx = mockCtx();
    const img = { fake: 'image' } as unknown as CanvasImageSource;
    renderCompositeFrame(ctx, video, canvas, [mask('a', { style: 'blur', src: 'data:image/webp;base64,AA==' }), mask('b')], () => img, mockScratch());
    expect(ctx.calls).toEqual(['drawImage', 'drawImage', 'fillRect']);
  });

  it('an UNDECODED cover image on a styled mask is black — the fallback must be in the safe direction', () => {
    const ctx = mockCtx();
    renderCompositeFrame(ctx, video, canvas, [mask('a', { style: 'pixelate', src: 'data:image/webp;base64,AA==' })], noImage, mockScratch());
    expect(ctx.calls).toEqual(['drawImage', 'fillRect']);
    expect(ctx.fillStyle).toBe('#000000');
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

// ─── Live session: restoring the raw track (F10) ────────────────────────────
//
// The fail-closed suite above deliberately lets setup fail (jsdom has no media
// pipeline). These tests stub just enough of it — MediaStream, video.play,
// getContext, captureStream — for ensureComposite to install a REAL session,
// which is the only way to reach stopComposite's restore branch.

function fakeTrack(label: string) {
  return {
    label,
    readyState: 'live' as MediaStreamTrackState,
    stop: vi.fn(function (this: { readyState: string }) { this.readyState = 'ended'; }),
    getSettings: () => ({ width: 640, height: 480 }),
    clone: vi.fn(() => fakeTrack(`${label}-clone`)),
  } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

function installMediaPipeline() {
  const compositeTrack = fakeTrack('composite');
  vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '',
  } as unknown as CanvasRenderingContext2D);
  (HTMLCanvasElement.prototype as unknown as { captureStream: () => MediaStream }).captureStream =
    () => ({ getVideoTracks: () => [compositeTrack] }) as unknown as MediaStream;
  return { compositeTrack };
}

function liveHandles(masks: MaskRect[] = [mask('m1')]) {
  const live = { masks };
  return {
    live,
    rawTrack: fakeTrack('raw'),
    getMasks: () => live.masks,
    replaceTrack: vi.fn(async (_track: MediaStreamTrack) => {}),
    pauseProducer: vi.fn<() => void>(),
    resumeProducer: vi.fn<() => void>(),
    onFatal: vi.fn<() => void>(),
    onRestoreFailed: vi.fn<() => void>(),
  } satisfies CompositeHandles & { live: { masks: MaskRect[] } };
}

describe('stopComposite — restoring the raw track on a LIVE session', () => {
  let compositeTrack: MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    teardownComposite();
    await stopComposite();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    compositeTrack = installMediaPipeline().compositeTrack as typeof compositeTrack;
  });

  it('installs a live session, then swaps the raw track back and tears down on success', async () => {
    const handles = liveHandles();
    await ensureComposite(handles);
    expect(handles.onFatal).not.toHaveBeenCalled(); // the pipeline stub worked

    handles.live.masks = [];
    await stopComposite();

    expect(handles.replaceTrack).toHaveBeenLastCalledWith(handles.rawTrack);
    expect(handles.onRestoreFailed).not.toHaveBeenCalled();
    expect(compositeTrack.stop).toHaveBeenCalled(); // torn down, CPU released
  });

  it('KEEPS the session and warns when the swap back fails, instead of blackening the share', async () => {
    // F10: session/blockedHandles were nulled before the attempt and the catch
    // fell through to destroySession, which stops the very track the producer
    // still holds — a frozen black frame for the rest of the share, with the
    // state already cleared so nothing could recover it, and no toast.
    const handles = liveHandles();
    await ensureComposite(handles);

    handles.live.masks = [];
    handles.replaceTrack.mockRejectedValueOnce(new Error('producer closed mid-swap'));
    await stopComposite();

    expect(handles.onRestoreFailed).toHaveBeenCalledTimes(1);
    // The producer's track must stay LIVE — with masks empty the compositor is
    // a plain passthrough, so viewers keep seeing the real screen
    expect(compositeTrack.stop).not.toHaveBeenCalled();
  });

  it('retries the swap on the next mask add/remove, and succeeds', async () => {
    const handles = liveHandles();
    await ensureComposite(handles);

    handles.live.masks = [];
    handles.replaceTrack.mockRejectedValueOnce(new Error('transport hiccup'));
    await stopComposite();
    expect(compositeTrack.stop).not.toHaveBeenCalled();

    await stopComposite(); // the session survived, so the retry has something to restore
    expect(handles.replaceTrack).toHaveBeenLastCalledWith(handles.rawTrack);
    expect(compositeTrack.stop).toHaveBeenCalled();
  });

  it('stays quiet when the share ended under the failing swap', async () => {
    // teardownComposite is synchronous and unqueued, so it can land mid-await;
    // a toast then would be noise about a share that no longer exists
    const handles = liveHandles();
    await ensureComposite(handles);

    handles.live.masks = [];
    handles.replaceTrack.mockImplementationOnce(async () => {
      teardownComposite();
      throw new Error('producer closed');
    });
    await stopComposite();

    expect(handles.onRestoreFailed).not.toHaveBeenCalled();
  });
});

// ─── Fail-closed across the restore await ───────────────────────────────────

describe('stopComposite — a mask added DURING the swap back', () => {
  beforeEach(async () => {
    teardownComposite();
    await stopComposite();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    installMediaPipeline();
  });

  it('re-gates the producer when a mask reappears while the raw track is being restored', async () => {
    // The session stays non-null across the await (so a failed restore can keep
    // the share alive), which means annotationStore's synchronous
    // `if (!isCompositing()) pauseProducer()` does NOT fire for a mask added in
    // that window. Without a second check here the raw track goes live with a
    // mask present — the one thing this module exists to prevent.
    const handles = liveHandles();
    await ensureComposite(handles);
    // ensureComposite resumes once its own setup lands — start from clean
    handles.pauseProducer.mockClear();
    handles.resumeProducer.mockClear();

    handles.live.masks = [];
    handles.replaceTrack.mockImplementationOnce(async () => {
      handles.live.masks = [mask('m2')]; // user re-masks mid-swap
    });
    await stopComposite();

    expect(handles.pauseProducer).toHaveBeenCalled();
    expect(handles.resumeProducer).not.toHaveBeenCalled();
  });

  it('leaves the producer running when no mask came back', async () => {
    const handles = liveHandles();
    await ensureComposite(handles);
    handles.pauseProducer.mockClear();

    handles.live.masks = [];
    await stopComposite();

    expect(handles.pauseProducer).not.toHaveBeenCalled();
  });
});

// ─── Pre-produce mode (the pre-flight) ──────────────────────────────────────

import { prepareComposite, attachCompositeProducerHandles, isCompositing as compositing } from '../../services/screenComposite';

describe('prepareComposite / attachCompositeProducerHandles', () => {
  beforeEach(async () => {
    teardownComposite();
    await stopComposite();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    installMediaPipeline();
  });

  afterEach(async () => {
    teardownComposite();
    await stopComposite();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function preflightHandles(masks: MaskRect[] = [mask('m1')]) {
    const live = { masks };
    return {
      live,
      rawTrack: fakeTrack('raw'),
      getMasks: () => live.masks,
      onFatal: vi.fn<() => void>(),
      onRestoreFailed: vi.fn<() => void>(),
    };
  }

  it('builds the session and returns the composited track WITHOUT any producer involvement', async () => {
    const handles = preflightHandles();
    const track = await prepareComposite(handles);
    expect(track).not.toBeNull();
    expect((track as { label?: string })?.label).toBe('composite');
    expect(compositing()).toBe(true);
    expect(handles.onFatal).not.toHaveBeenCalled();
  });

  it('after attach, removing the last mask restores the raw track through the attached handle', async () => {
    const handles = preflightHandles();
    await prepareComposite(handles);
    const producer = {
      replaceTrack: vi.fn(async (_t: MediaStreamTrack) => {}),
      pauseProducer: vi.fn<() => void>(),
      resumeProducer: vi.fn<() => void>(),
    };
    attachCompositeProducerHandles(producer);
    handles.live.masks = [];
    await stopComposite();
    expect(producer.replaceTrack).toHaveBeenCalledWith(handles.rawTrack);
    expect(compositing()).toBe(false);
  });

  it('a stop that races in BEFORE attach fails the restore and keeps the session (never bare frames)', async () => {
    const handles = preflightHandles();
    await prepareComposite(handles);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handles.live.masks = [];
    await stopComposite(); // stub replaceTrack throws → keep-composited path
    errSpy.mockRestore();
    expect(compositing()).toBe(true);
    expect(handles.onRestoreFailed).toHaveBeenCalled();
  });

  it('returns null on setup failure (fail closed: the caller must not share) and reports it', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handles = preflightHandles();
    const track = await prepareComposite(handles);
    errSpy.mockRestore();
    expect(track).toBeNull();
    expect(compositing()).toBe(false);
    expect(handles.onFatal).toHaveBeenCalled();
  });

  it('returns null when the share ended mid-setup or the track is already dead, without the fatal toast', async () => {
    const handles = preflightHandles();
    (handles.rawTrack as { readyState: string }).readyState = 'ended';
    expect(await prepareComposite(handles)).toBeNull();
    expect(handles.onFatal).not.toHaveBeenCalled();
    expect(compositing()).toBe(false);
  });

  it('refuses while a session is already live (returns null, session untouched)', async () => {
    const first = preflightHandles();
    await prepareComposite(first);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await prepareComposite(preflightHandles());
    warn.mockRestore();
    expect(second).toBeNull();
    expect(compositing()).toBe(true);
  });
});

// ─── Source-change guard (the hold) ─────────────────────────────────────────
// Uses the same minimal media pipeline as the live-session suites, plus a
// controllable requestAnimationFrame so each flush is one compositor frame,
// and a captured <video> whose intrinsic size the test can change.

import { isSourceHeld, resumeSourceHold } from '../../services/screenComposite';

describe('source-change guard', () => {
  let rafQueue: FrameRequestCallback[] = [];
  const runFrame = () => {
    const batch = rafQueue;
    rafQueue = [];
    batch.forEach((cb) => cb(0));
  };

  let order: string[];
  let capturedVideo: HTMLVideoElement | null;

  const setVideoSize = (w: number, h: number) => {
    Object.defineProperty(capturedVideo!, 'videoWidth', { value: w, configurable: true });
    Object.defineProperty(capturedVideo!, 'videoHeight', { value: h, configurable: true });
  };

  function holdHandles(masks: () => MaskRect[]) {
    // getSettings must agree with the video's intrinsic size, as it does in
    // production — otherwise the very first frame reads as a resize
    const rawTrack = Object.assign(fakeTrack('raw'), { getSettings: () => ({ width: 1920, height: 1080 }) });
    return {
      rawTrack,
      getMasks: masks,
      replaceTrack: vi.fn(async (_track: MediaStreamTrack) => {}),
      pauseProducer: vi.fn(() => { order.push('paused'); }),
      resumeProducer: vi.fn(() => { order.push('resumed'); }),
      onFatal: vi.fn<() => void>(),
      onRestoreFailed: vi.fn<() => void>(),
      onSourceResize: vi.fn(() => { order.push('resizeToast'); }),
      onSourceHold: vi.fn((change: { fromW: number; fromH: number; toW: number; toH: number }) => {
        order.push(`hold:${change.fromW}x${change.fromH}->${change.toW}x${change.toH}`);
      }),
    } satisfies CompositeHandles;
  }

  beforeEach(async () => {
    teardownComposite();
    await stopComposite();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    order = [];
    capturedVideo = null;
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(() => { order.push('frameDrawn'); }),
      fillRect: vi.fn(), fillStyle: '', save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), imageSmoothingEnabled: true,
    } as unknown as CanvasRenderingContext2D);
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => MediaStream }).captureStream =
      () => ({ getVideoTracks: () => [fakeTrack('composite')] }) as unknown as MediaStream;
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'video') capturedVideo = el as HTMLVideoElement;
      return el;
    }) as typeof document.createElement);
  });

  afterEach(async () => {
    teardownComposite();
    await stopComposite();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function installHeld(masks: () => MaskRect[]) {
    const handles = holdHandles(masks);
    await ensureComposite(handles);
    expect(handles.onFatal).not.toHaveBeenCalled();
    setVideoSize(1920, 1080);
    runFrame(); // canvas follows the source at its original size — no hold
    expect(isSourceHeld()).toBe(false);
    order.length = 0;
    return handles;
  }

  it('a source resize with masks pauses the producer BEFORE the resized frame is drawn, and holds', async () => {
    await installHeld(() => [mask('m')]);
    setVideoSize(1280, 720); // window switch
    runFrame();
    expect(order[0]).toBe('paused');                        // pause first…
    expect(order[1]).toBe('hold:1920x1080->1280x720');      // …announce…
    expect(order.indexOf('frameDrawn')).toBeGreaterThan(1); // …THEN the resized frame is drawn (masked)
    expect(isSourceHeld()).toBe(true);
    expect(order).not.toContain('resizeToast'); // the misalign toast is the no-mask path

    // Further frames and even a second resize keep the single hold
    order.length = 0;
    runFrame();
    setVideoSize(800, 600);
    runFrame();
    expect(order.filter((x) => x === 'paused')).toHaveLength(0);
    expect(isSourceHeld()).toBe(true);
  });

  it('a hold raised while the producer handles are still stubs is re-asserted on attach', async () => {
    const h = holdHandles(() => [mask('m')]);
    const track = await prepareComposite({
      rawTrack: h.rawTrack,
      getMasks: h.getMasks,
      onFatal: h.onFatal,
      onRestoreFailed: h.onRestoreFailed,
      onSourceResize: h.onSourceResize,
      onSourceHold: h.onSourceHold,
    });
    expect(track).not.toBeNull();
    setVideoSize(1920, 1080);
    runFrame(); // canvas follows the source at its original size — no hold
    expect(isSourceHeld()).toBe(false);

    setVideoSize(1280, 720); // the source changes DURING the claim/produce window
    runFrame();
    expect(isSourceHeld()).toBe(true);
    expect(h.pauseProducer).not.toHaveBeenCalled(); // only the stub was "paused"

    attachCompositeProducerHandles({ replaceTrack: h.replaceTrack, pauseProducer: h.pauseProducer, resumeProducer: h.resumeProducer });
    expect(h.pauseProducer).toHaveBeenCalled(); // the hold now actually gates RTP

    resumeSourceHold();
    expect(h.resumeProducer).toHaveBeenCalled();
    expect(isSourceHeld()).toBe(false);
  });

  it('only the explicit confirm resumes; the hold never expires by itself', async () => {
    await installHeld(() => [mask('m')]);
    setVideoSize(1280, 720);
    runFrame();
    for (let i = 0; i < 50; i++) runFrame(); // ~50 frames later, still held
    expect(isSourceHeld()).toBe(true);

    resumeSourceHold();
    expect(order.at(-1)).toBe('resumed');
    expect(isSourceHeld()).toBe(false);
    resumeSourceHold(); // idempotent
    expect(order.filter((x) => x === 'resumed')).toHaveLength(1);
  });

  it('removing every mask while held resumes the producer with the raw-track restore (nothing left to protect)', async () => {
    const masks: MaskRect[] = [mask('m')];
    const handles = await installHeld(() => masks);
    setVideoSize(1280, 720);
    runFrame();
    expect(isSourceHeld()).toBe(true);

    masks.length = 0;
    await stopComposite();
    expect(handles.replaceTrack).toHaveBeenLastCalledWith(handles.rawTrack);
    expect(order.at(-1)).toBe('resumed');
    expect(isSourceHeld()).toBe(false);
  });

  it('a failed raw-track restore while held still resumes (passthrough shows the right picture)', async () => {
    const masks: MaskRect[] = [mask('m')];
    const handles = await installHeld(() => masks);
    setVideoSize(1280, 720);
    runFrame();
    vi.mocked(handles.replaceTrack).mockRejectedValueOnce(new Error('busy'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    masks.length = 0;
    await stopComposite();
    errSpy.mockRestore();
    expect(order.at(-1)).toBe('resumed');
    expect(handles.onRestoreFailed).toHaveBeenCalled();
  });

  it('a resize with NO masks only fires the misalign hint — no pause, no hold', async () => {
    // Passthrough state: restore fails once, the session stays with 0 masks
    const masks: MaskRect[] = [mask('m')];
    const handles = await installHeld(() => masks);
    vi.mocked(handles.replaceTrack).mockRejectedValueOnce(new Error('busy'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    masks.length = 0;
    await stopComposite();
    errSpy.mockRestore();
    order.length = 0;

    setVideoSize(1280, 720);
    runFrame();
    expect(order).toContain('resizeToast');
    expect(order).not.toContain('paused');
    expect(isSourceHeld()).toBe(false);
  });

  it('teardown mid-hold clears it without resuming (the share is over)', async () => {
    await installHeld(() => [mask('m')]);
    setVideoSize(1280, 720);
    runFrame();
    expect(isSourceHeld()).toBe(true);
    order.length = 0;
    teardownComposite();
    expect(isSourceHeld()).toBe(false);
    expect(order).not.toContain('resumed');
  });
});
