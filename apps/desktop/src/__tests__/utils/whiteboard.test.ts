import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWhiteboardStream, WHITEBOARD_WIDTH, WHITEBOARD_HEIGHT, WHITEBOARD_FPS } from '../../utils/whiteboard';

type Call = { op: string; args: unknown[] };
let calls: Call[];
let ctxAvailable: boolean;
let captureAvailable: boolean;
let captureArgs: unknown[];

function recordingCtx() {
  const ctx: Record<string, unknown> = { fillStyle: '' };
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args: [...args, ctx.fillStyle] });
  };
  for (const op of ['fillRect', 'beginPath', 'arc', 'fill']) ctx[op] = record(op);
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  vi.useFakeTimers(); // the repaint interval must never leak between tests
  calls = [];
  ctxAvailable = true;
  captureAvailable = true;
  captureArgs = [];
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = Document.prototype.createElement.call(document, tag);
    if (tag === 'canvas') {
      Object.assign(el, {
        getContext: () => (ctxAvailable ? recordingCtx() : null),
        ...(captureAvailable && {
          captureStream: (...args: unknown[]) => {
            captureArgs = args;
            const track = { kind: 'video', readyState: 'live' };
            return { getVideoTracks: () => [track] };
          },
        }),
      });
    }
    return el as HTMLElement;
  }) as typeof document.createElement);
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) =>
      name === '--color-vox-bg-secondary' ? ' #101022 ' : name === '--color-vox-border' ? '#333355' : '',
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createWhiteboardStream', () => {
  it('paints the board in the LIVE theme tokens: background fill, then the dot grid', () => {
    const board = createWhiteboardStream();
    expect(board).not.toBeNull();
    expect(board!.canvas.width).toBe(WHITEBOARD_WIDTH);
    expect(board!.canvas.height).toBe(WHITEBOARD_HEIGHT);
    const bg = calls.find((c) => c.op === 'fillRect')!;
    expect(bg.args).toEqual([0, 0, WHITEBOARD_WIDTH, WHITEBOARD_HEIGHT, '#101022']); // trimmed token
    const dots = calls.filter((c) => c.op === 'arc');
    expect(dots.length).toBeGreaterThan(1000); // 47 x 26 grid
    expect(dots[0].args[4]).toBe(Math.PI * 2);
    const dotFill = calls.find((c) => c.op === 'fill')!;
    expect(dotFill.args.at(-1)).toBe('#333355'); // the border token colours the grid
  });

  it('captures at 5 fps — a static board costs the encoder almost nothing', () => {
    createWhiteboardStream();
    expect(captureArgs).toEqual([WHITEBOARD_FPS]);
  });

  it('keeps repainting the identical board so keyframe requests always have a frame, and retires with the track', () => {
    const board = createWhiteboardStream()!;
    const paints = () => calls.filter((c) => c.op === 'fillRect').length;
    const initial = paints();
    expect(initial).toBeGreaterThan(0); // painted AFTER the capture attached
    vi.advanceTimersByTime(2_100);
    expect(paints()).toBe(initial * 3); // two repaints of the identical board

    (board.stream.getVideoTracks()[0] as unknown as { readyState: string }).readyState = 'ended';
    const settled = paints();
    vi.advanceTimersByTime(5_000);
    expect(paints()).toBe(settled); // the interval died with the track
  });

  it('fails closed when the environment cannot produce a canvas track', () => {
    ctxAvailable = false;
    expect(createWhiteboardStream()).toBeNull();
    ctxAvailable = true;
    captureAvailable = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createWhiteboardStream()).toBeNull(); // never a getDisplayMedia fallback
    warn.mockRestore();
  });
});
