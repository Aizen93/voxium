/**
 * Whiteboard mode v1 (item 11): a canvas IS a screen. The board is a static
 * 1920x1080 canvas whose captureStream(5) track goes through the exact same
 * share start path as a display capture — zero server change, late joiners
 * hydrate the scene as usual, and the encoder sends almost nothing after the
 * keyframes because the background never repaints (mediasoup answers
 * consumers' keyframe requests).
 *
 * The producer-less board (no video at all) is deliberately NOT this — that
 * is a new share kind through the mirror/relay/multi-node stack, judged from
 * v1 usage (accepted decision 4).
 */

export const WHITEBOARD_WIDTH = 1920;
export const WHITEBOARD_HEIGHT = 1080;
export const WHITEBOARD_FPS = 5;
/** How often the (identical) board is repainted to keep the capture fed. */
export const WHITEBOARD_REPAINT_MS = 1_000;

const DOT_SPACING = 40;
const DOT_RADIUS = 1.5;
/** Fallbacks are the brand-dark board — used when a token is missing. */
const FALLBACK_BG = '#161627';
const FALLBACK_DOT = '#2e2e48';

/**
 * Paint the board (theme-aware: tokens read from the live theme) and capture
 * it. Returns null when the environment cannot produce a canvas track — the
 * caller must NOT fall back to getDisplayMedia (the user asked for a board,
 * not their screen).
 */
export function createWhiteboardStream(): { stream: MediaStream; canvas: HTMLCanvasElement } | null {
  const canvas = document.createElement('canvas');
  canvas.width = WHITEBOARD_WIDTH;
  canvas.height = WHITEBOARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--color-vox-bg-secondary').trim() || FALLBACK_BG;
  const dot = styles.getPropertyValue('--color-vox-border').trim() || FALLBACK_DOT;

  const paint = () => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dot;
    for (let y = DOT_SPACING; y < canvas.height; y += DOT_SPACING) {
      for (let x = DOT_SPACING; x < canvas.width; x += DOT_SPACING) {
        ctx.beginPath();
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const capture = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
  if (typeof capture !== 'function') {
    console.warn('[Whiteboard] canvas.captureStream unavailable');
    return null;
  }
  // CAPTURE BEFORE PAINT: a canvas capture track only emits frames when the
  // canvas is dirtied AFTER the capture starts — paint-then-capture can leave
  // the track with zero frames, and a keyframe request (a late joiner's PLI)
  // has no source frame to encode: the viewer stares at black forever.
  const stream = capture.call(canvas, WHITEBOARD_FPS);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    console.warn('[Whiteboard] captureStream produced no video track');
    return null;
  }
  paint();
  // …and keep the capture FED: repaint the identical board once a second
  // (dirty flag only — the encoder sees a zero-delta frame and sends next to
  // nothing) so keyframe requests always have a frame to work from. The
  // interval retires itself with the track (canvas tracks never fire
  // 'ended' for a local stop, so poll readyState).
  const repaint = setInterval(() => {
    if (track.readyState !== 'live') {
      clearInterval(repaint);
      return;
    }
    paint();
  }, WHITEBOARD_REPAINT_MS);
  return { stream, canvas };
}
