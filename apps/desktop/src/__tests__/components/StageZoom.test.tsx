import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { useStageZoom, ZoomPill, MagnifierLens } from '../../components/voice/StageZoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** Minimal stage: the hook drives a transform on the inner surface, exactly
 *  like ScreenShareViewer wires it. */
function Harness({ enabled }: { enabled: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { zoom, style, handlers, reset } = useStageZoom(stageRef, enabled);
  return (
    <div ref={stageRef} data-testid="stage" {...handlers}>
      <div data-testid="surface" style={style}>
        <video data-testid="video" />
        <canvas data-testid="canvas" />
      </div>
      <ZoomPill zoom={zoom} onReset={reset} />
    </div>
  );
}

function render(enabled: boolean) {
  act(() => {
    root.render(<Harness enabled={enabled} />);
  });
}

const stage = () => container.querySelector('[data-testid="stage"]') as HTMLElement;
const surface = () => container.querySelector('[data-testid="surface"]') as HTMLElement;

function wheel(deltaY: number, clientX = 400, clientY = 225) {
  act(() => {
    stage().dispatchEvent(new WheelEvent('wheel', { deltaY, clientX, clientY, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('useStageZoom', () => {
  it('wheel zooms the surface that holds BOTH the video and the canvas', () => {
    render(true);
    expect(surface().style.transform).toBe('');
    wheel(-500);
    const transform = surface().style.transform;
    expect(transform).toMatch(/scale\(/);
    // The transformed parent is shared: overlay registration survives any zoom
    const video = container.querySelector('[data-testid="video"]')!;
    const canvas = container.querySelector('[data-testid="canvas"]')!;
    expect(video.parentElement).toBe(surface());
    expect(canvas.parentElement).toBe(surface());
    // And the pill appears with a working reset
    expect(container.querySelector('[data-testid="zoom-pill"]')).not.toBeNull();
    act(() => {
      (container.querySelector('[data-testid="zoom-reset"]') as HTMLButtonElement).click();
    });
    expect(surface().style.transform).toBe('');
    expect(container.querySelector('[data-testid="zoom-pill"]')).toBeNull();
  });

  it('zooming out past 1x snaps to identity; double-click resets', () => {
    render(true);
    wheel(-800);
    expect(surface().style.transform).not.toBe('');
    wheel(10_000); // way out
    expect(surface().style.transform).toBe('');

    wheel(-800);
    act(() => {
      stage().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(surface().style.transform).toBe('');
  });

  it('disabled (the sharer starts editing) resets and stops reacting to the wheel', () => {
    render(true);
    wheel(-800);
    expect(surface().style.transform).not.toBe('');
    render(false); // isEditing flipped on
    expect(surface().style.transform).toBe(''); // reset — the editor layer never mounts transformed
    wheel(-800);
    expect(surface().style.transform).toBe('');
  });

  it('drag pans only while zoomed, within bounds', () => {
    render(true);
    wheel(-2000, 0, 0); // zoom in anchored at the top-left corner → tx stays 0
    const before = surface().style.transform;
    expect(before).toMatch(/^translate\(0px, 0px\)/);
    act(() => {
      const el = stage();
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 400, clientY: 225 }));
      el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1, clientX: 360, clientY: 200 }));
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    const after = surface().style.transform;
    expect(after).not.toBe(before); // panned…
    const tx = Number(/translate\((-?[\d.]+)px/.exec(after)![1]);
    expect(tx).toBeLessThan(0); // …leftward
    expect(tx).toBeGreaterThanOrEqual(800 * (1 - 4)); // …and inside the bound
  });
});

describe('useStageZoom robustness', () => {
  it('a cancelled pan gesture (or a buttons-up move) stops panning — hover must not drag', () => {
    render(true);
    wheel(-2000, 0, 0);
    const before = surface().style.transform;
    act(() => {
      const el = stage();
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 400, clientY: 225 }));
      el.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: 100, clientY: 100 }));
    });
    expect(surface().style.transform).toBe(before);
  });

  it('a stage resize re-clamps the pan so the surface cannot sit outside the new bounds', () => {
    let fire: (() => void) | null = null;
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { fire = cb; }
      observe() {}
      disconnect() {}
    });
    render(true);
    wheel(-2000, 800, 450); // zoom anchored bottom-right → large negative pan
    const tx = () => Number(/translate\((-?[\d.]+)px/.exec(surface().style.transform)![1]);
    const panned = tx();
    expect(panned).toBeLessThan(-1000);
    // the stage shrinks (fullscreen exit): 800x450 → 400x225
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 225, width: 400, height: 225,
      toJSON: () => ({}),
    } as DOMRect);
    act(() => { fire?.(); });
    expect(tx()).toBeGreaterThanOrEqual(400 * (1 - 4)); // inside the NEW bound
    vi.unstubAllGlobals();
  });
});

describe('MagnifierLens', () => {
  function LensHarness({ disabled = false }: { disabled?: boolean }) {
    const stageRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    return (
      <div ref={stageRef} data-testid="stage">
        <video ref={videoRef} />
        <MagnifierLens videoRef={videoRef} stageRef={stageRef} disabled={disabled} />
      </div>
    );
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderLens(disabled = false) {
    act(() => {
      root.render(<LensHarness disabled={disabled} />);
    });
  }

  it('appears while Z is held over the stage and vanishes on keyup', () => {
    renderLens();
    act(() => {
      stage().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 100 }));
    });
    expect(container.querySelector('[data-testid="magnifier-lens"]')).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
    });
    expect(container.querySelector('[data-testid="magnifier-lens"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ' }));
    });
    expect(container.querySelector('[data-testid="magnifier-lens"]')).toBeNull();
  });

  it('ignores Z from an editable target and while disabled', () => {
    renderLens(true);
    act(() => {
      stage().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
    });
    expect(container.querySelector('[data-testid="magnifier-lens"]')).toBeNull();

    renderLens(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      stage().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 100 }));
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', bubbles: true }));
    });
    expect(container.querySelector('[data-testid="magnifier-lens"]')).toBeNull();
    input.remove();
  });
});
