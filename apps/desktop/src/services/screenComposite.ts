import type { MaskRect } from '../stores/annotationStore';

/**
 * Privacy-mask compositor for screen sharing.
 *
 * While at least one mask exists, the outgoing screen-video track is swapped
 * (producer.replaceTrack — no renegotiation) for a canvas capture that draws
 * the raw frame and then paints every mask over it, so COVERED PIXELS NEVER
 * LEAVE THIS MACHINE. When the last mask is removed the raw track is swapped
 * back and the pipeline is torn down — CPU is spent only while masks exist.
 *
 * Deliberately dependency-injected and store-free at runtime (`MaskRect` is a
 * type-only import): annotationStore drives it on mask transitions and
 * voiceStore tears it down on share stop, and neither import direction forms
 * a cycle.
 */

export interface CompositeHandles {
  /** The raw getDisplayMedia video track (keeps running — it feeds the compositor). */
  rawTrack: MediaStreamTrack;
  /** Read the CURRENT masks — sampled every frame, so geometry edits are live. */
  getMasks: () => MaskRect[];
  /** Swap the outgoing producer track (mediasoup producer.replaceTrack). */
  replaceTrack: (track: MediaStreamTrack) => Promise<void>;
  /** Pause/resume outgoing RTP on the screen-video producer (fail-closed gate:
   *  no raw frame may ship between "mask exists" and "composited track live"). */
  pauseProducer: () => void;
  resumeProducer: () => void;
  /** Compositor could not start — the producer stays PAUSED; tell the sharer. */
  onFatal?: () => void;
  /** Source resolution changed mid-share (window switch) — masks may misalign. */
  onSourceResize?: () => void;
}

const CAPTURE_FPS = 30;
/** Bleed the mask outward so lossy encoding can't ring the covered edge. */
const MASK_PAD_PX = 1;

interface ActiveSession {
  handles: CompositeHandles;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  compositeTrack: MediaStreamTrack;
  /** CLONE of the raw track feeding the hidden <video> — never the producer's
   *  own track object (producer pause/replaceTrack must not affect the source). */
  sourceTrack: MediaStreamTrack;
  maskImages: Map<string, { src: string; img: HTMLImageElement; loaded: boolean }>;
  stopped: boolean;
  cancelFrameLoop: () => void;
}

let session: ActiveSession | null = null;
/** Serializes ensure/stop so rapid mask add→remove can't interleave setups. */
let transition: Promise<void> = Promise.resolve();
/** Non-null ⇒ the producer is paused fail-closed with NO live session (setup
 *  pending or failed). stopComposite resumes it when the masks go away. */
let blockedHandles: CompositeHandles | null = null;
/** Bumped by teardownComposite so an in-flight ensureComposite that already
 *  passed its awaits cannot install a session after the share ended. */
let generation = 0;

export function isCompositing(): boolean {
  return session !== null;
}

/**
 * Pure per-frame render: raw frame first, then every mask. A mask whose cover
 * image has not decoded yet is painted BLACK — fail closed, never bare.
 * Returns true when the canvas was resized to follow the source (caller
 * surfaces the "masks may misalign" hint).
 */
export function renderCompositeFrame(
  ctx: Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect'> & { fillStyle: string | CanvasGradient | CanvasPattern },
  video: { videoWidth: number; videoHeight: number },
  canvas: { width: number; height: number },
  masks: MaskRect[],
  getMaskImage: (mask: MaskRect) => CanvasImageSource | null,
): boolean {
  let resized = false;
  if (video.videoWidth > 0 && video.videoHeight > 0
    && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    resized = true;
  }
  ctx.drawImage(video as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  for (const mask of masks) {
    const x = mask.x * canvas.width - MASK_PAD_PX;
    const y = mask.y * canvas.height - MASK_PAD_PX;
    const w = mask.w * canvas.width + MASK_PAD_PX * 2;
    const h = mask.h * canvas.height + MASK_PAD_PX * 2;
    const img = mask.src ? getMaskImage(mask) : null;
    if (img) {
      ctx.drawImage(img, x, y, w, h);
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(x, y, w, h);
    }
  }
  return resized;
}

function maskImageFor(s: ActiveSession, mask: MaskRect): CanvasImageSource | null {
  if (!mask.src) return null;
  let entry = s.maskImages.get(mask.id);
  if (!entry || entry.src !== mask.src) {
    const img = new Image();
    entry = { src: mask.src, img, loaded: false };
    s.maskImages.set(mask.id, entry);
    img.onload = () => {
      // Oversized decode = keep painting BLACK (fail closed), never the image
      if (img.naturalWidth > 4096 || img.naturalHeight > 4096) {
        console.warn('[ScreenComposite] Mask cover image exceeds decoded-size cap — staying black');
        return;
      }
      const current = s.maskImages.get(mask.id);
      if (current) current.loaded = true;
    };
    img.onerror = () => {
      console.warn('[ScreenComposite] Mask cover image failed to decode — staying black');
    };
    img.src = mask.src;
  }
  return entry.loaded ? entry.img : null;
}

function startFrameLoop(s: ActiveSession): void {
  const drawOnce = () => {
    if (s.stopped) return;
    const resized = renderCompositeFrame(s.ctx, s.video, s.canvas, s.handles.getMasks(), (m) => maskImageFor(s, m));
    if (resized) {
      try {
        s.handles.onSourceResize?.();
      } catch (err) {
        console.warn('[ScreenComposite] onSourceResize handler failed:', err);
      }
    }
  };

  // Prefer requestVideoFrameCallback (draws exactly on new frames, tracks the
  // source fps); rAF fallback for engines without it.
  const rvfcVideo = s.video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  if (typeof rvfcVideo.requestVideoFrameCallback === 'function') {
    let handle = 0;
    const tick = () => {
      drawOnce();
      if (!s.stopped) handle = rvfcVideo.requestVideoFrameCallback!(tick);
    };
    handle = rvfcVideo.requestVideoFrameCallback(tick);
    s.cancelFrameLoop = () => rvfcVideo.cancelVideoFrameCallback?.(handle);
  } else {
    let handle = 0;
    const tick = () => {
      drawOnce();
      if (!s.stopped) handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    s.cancelFrameLoop = () => cancelAnimationFrame(handle);
  }
}

function destroySession(s: ActiveSession): void {
  s.stopped = true;
  s.cancelFrameLoop();
  s.compositeTrack.stop();
  s.sourceTrack.stop(); // our clone only — the original capture track lives on
  s.video.srcObject = null;
  s.maskImages.clear();
}

/**
 * Start compositing if not already running. FAIL-CLOSED: the producer is
 * paused synchronously before any async setup, so no raw frame ships between
 * "a mask exists" and "the composited track is live". On any setup failure the
 * producer STAYS paused (viewers see a frozen frame, never the raw content
 * under the mask) and `onFatal` tells the sharer; removing the masks resumes.
 */
export async function ensureComposite(handles: CompositeHandles): Promise<void> {
  transition = transition.then(async () => {
    if (session || handles.rawTrack.readyState === 'ended') return;
    const gen = generation;

    // Gate BEFORE the first await — this is the privacy boundary.
    handles.pauseProducer();
    blockedHandles = handles;

    let video: HTMLVideoElement | null = null;
    let sourceTrack: MediaStreamTrack | null = null;
    let s: ActiveSession | null = null;
    try {
      // Feed the compositor a CLONE: the producer's pause/replaceTrack must
      // never be able to disable or stop the frames the compositor reads
      // (mediasoup's defaults do both to the track object it holds).
      sourceTrack = handles.rawTrack.clone();
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([sourceTrack]);
      await video.play();
      if (gen !== generation) {
        // Share ended while we were setting up
        video.srcObject = null;
        return;
      }

      const settings = handles.rawTrack.getSettings();
      const width = settings.width || video.videoWidth || 1280;
      const height = settings.height || video.videoHeight || 720;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');

      const stream = canvas.captureStream(CAPTURE_FPS);
      const compositeTrack = stream.getVideoTracks()[0];
      if (!compositeTrack) throw new Error('captureStream produced no track');
      if ('contentHint' in compositeTrack) compositeTrack.contentHint = 'detail';

      const created: ActiveSession = {
        handles,
        video,
        canvas,
        ctx,
        compositeTrack,
        sourceTrack,
        maskImages: new Map(),
        stopped: false,
        cancelFrameLoop: () => {},
      };
      s = created;

      // First masked frame BEFORE the swap
      renderCompositeFrame(ctx, video, canvas, handles.getMasks(), (m) => maskImageFor(created, m));

      await handles.replaceTrack(compositeTrack);
      if (gen !== generation) {
        // teardownComposite ran mid-replaceTrack — the share is over; don't
        // install a session nothing will ever tear down.
        destroySession(created);
        return;
      }

      session = created;
      blockedHandles = null;
      startFrameLoop(created);
      handles.resumeProducer();
    } catch (err) {
      if (s) destroySession(s);
      else {
        if (video) video.srcObject = null;
        sourceTrack?.stop();
      }
      if (gen !== generation) {
        // The share ended mid-setup (teardownComposite bumped the generation)
        // — producers are closing and the "failure" is just the race; a fatal
        // toast here would be noise.
        return;
      }
      // FAIL CLOSED on ANY setup failure: the producer stays paused (viewers
      // see a frozen frame, never the content under the mask); removing the
      // masks resumes via stopComposite's blockedHandles path.
      console.error('[ScreenComposite] Setup failed — producer stays paused:', err);
      handles.onFatal?.();
    }
  }).catch((err) => {
    console.error('[ScreenComposite] ensureComposite failed:', err);
  });
  return transition;
}

/** Last mask removed: restore the raw track on the producer and tear down. */
export async function stopComposite(): Promise<void> {
  transition = transition.then(async () => {
    const s = session;
    if (!s) {
      if (blockedHandles) {
        // Setup failed/pending with the producer paused fail-closed. Re-check
        // the LIVE mask list before resuming: a mask re-added while this stop
        // sat in the queue means raw output must stay gated (the queued
        // ensureComposite retry follows right behind us).
        if (blockedHandles.getMasks().length > 0) return;
        blockedHandles.resumeProducer();
        blockedHandles = null;
      }
      return;
    }
    // Same queue race for a LIVE session: masks went 1→0→1 while we waited
    // for our turn — restoring the raw track now would ship unmasked frames
    // for a full replaceTrack round-trip. Keep the session; the queued
    // ensureComposite will see it and no-op.
    if (s.handles.getMasks().length > 0) return;
    session = null;
    blockedHandles = null;
    if (s.handles.rawTrack.readyState === 'live') {
      try {
        await s.handles.replaceTrack(s.handles.rawTrack);
      } catch (err) {
        console.error('[ScreenComposite] Restoring the raw track failed:', err);
      }
    }
    destroySession(s);
  }).catch((err) => {
    console.error('[ScreenComposite] stopComposite failed:', err);
  });
  return transition;
}

/**
 * Hard teardown, no track restore and no resume — the share is ending and the
 * producers are closing anyway. Canvas tracks never end on their own; without
 * this the draw loop would keep burning CPU after the share died. The
 * generation bump aborts any ensureComposite still in flight.
 */
export function teardownComposite(): void {
  generation += 1;
  blockedHandles = null;
  const s = session;
  session = null;
  if (s) destroySession(s);
}
