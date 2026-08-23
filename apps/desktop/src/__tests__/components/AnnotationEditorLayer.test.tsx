import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ANNOTATION_TEXT_MAX, ANNOTATION_CALLOUT_MAX } from '@voxium/shared';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// annotationStore pulls in the socket service and voiceStore (module-scope
// lifecycle subscription) — stub both. localApply needs an active channel.
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));
const voiceState = vi.hoisted(() => ({ activeChannelId: 'chan-1', screenSharingUserId: 'me', isScreenSharing: true, screenStream: null, screenShareAnnotationsVersion: 2 }));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: {
    getState: () => voiceState,
    subscribe: () => () => {},
  },
  registerShareMaskHooks: vi.fn(),
}));
vi.mock('../../services/screenComposite', () => ({
  ensureComposite: vi.fn(),
  stopComposite: vi.fn(),
  teardownComposite: vi.fn(),
  isCompositing: () => false,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../stores/toastStore', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// jsdom has no layout: pin the video content rect the layer positions itself on.
const RECT = { x: 0, y: 0, w: 800, h: 450 };
vi.mock('../../hooks/useVideoContentRect', () => ({
  useVideoContentRect: () => RECT,
}));

import { AnnotationEditorLayer, sanitizeAnnotationText, type ToolCapabilities } from '../../components/voice/AnnotationEditorLayer';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useAnnotationStore.getState();

let container: HTMLDivElement;
let root: Root;
const videoRef = { current: null as HTMLVideoElement | null };

function render(strict = false, capabilities?: ToolCapabilities) {
  act(() => {
    const el = <AnnotationEditorLayer videoRef={videoRef} capabilities={capabilities} />;
    root.render(strict ? <StrictMode>{el}</StrictMode> : el);
  });
}

function layer(): HTMLElement {
  return container.querySelector('[data-testid="annotation-editor-layer"]') as HTMLElement;
}

function draftInput(): HTMLInputElement | null {
  return container.querySelector('[data-testid="annotation-text-draft"]');
}

/** Dispatch a pointerdown the way the browser would, returning whether the
 *  handler cancelled it (which is what suppresses the compatibility mousedown). */
function pointerDown(el: Element, x: number, y: number): boolean {
  let cancelled = false;
  act(() => {
    const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    cancelled = !el.dispatchEvent(ev);
  });
  return cancelled;
}

function pointerMove(el: Element, x: number, y: number) {
  act(() => { el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })); });
}

function pointerUp(el: Element) {
  act(() => {
    const ev = new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    el.dispatchEvent(ev);
  });
}

/** A full primary-button press as the browser sequences it: pointerdown, then
 *  — ONLY if pointerdown was not cancelled — the compatibility mousedown,
 *  whose default action on a non-focusable target moves focus to <body>
 *  (blurring whatever React just mounted and focused), then pointerup. */
function browserPress(el: Element, x: number, y: number): { cancelled: boolean } {
  const cancelled = pointerDown(el, x, y);
  if (!cancelled) {
    act(() => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    });
  }
  pointerUp(el);
  return { cancelled };
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    // React tracks the value setter; go through the prototype so onChange fires
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(input: HTMLElement, k: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

function textObjects() {
  return useAnnotationStore.getState().scene.objects.filter((o) => o.kind === 'text');
}

beforeEach(() => {
  // The undo/redo stacks are module-level: reset them with the scene, or a
  // previous test's caption commits would still be undoable here
  useAnnotationStore.getState().clearViewerScene();
  useAnnotationStore.setState({ ...initialState, isEditing: true, activeTool: 'text', scene: { objects: [] } }, true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom implements neither pointer capture nor layout
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { left: 0, top: 0, width: RECT.w, height: RECT.h, right: RECT.w, bottom: RECT.h, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('AnnotationEditorLayer — text tool', () => {
  it('opens a focused caption input where the sharer clicked', () => {
    render();
    pointerDown(layer(), 400, 225);
    pointerUp(layer());

    const input = draftInput();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input!.style.left).toBe('400px');
    expect(input!.style.top).toBe('225px');
  });

  it('the input survives the full press: pointerdown is cancelled, so no compatibility mousedown blurs it', () => {
    render();
    const { cancelled } = browserPress(layer(), 100, 100);
    expect(cancelled).toBe(true);
    expect(draftInput()).not.toBeNull();
    expect(document.activeElement).toBe(draftInput());
    expect(textObjects()).toHaveLength(0);
  });

  it('control: an uncancelled press would blur the fresh input and discard the draft (the original bug)', () => {
    render();
    pointerDown(layer(), 100, 100);
    expect(document.activeElement).toBe(draftInput());
    // What the browser did before the fix, for every text-tool click
    act(() => { (document.activeElement as HTMLElement).blur(); });
    expect(draftInput()).toBeNull();
  });

  it('the drawing tools do NOT cancel pointerdown (focus must still leave the chat composer etc.)', () => {
    useAnnotationStore.setState({ activeTool: 'pen' });
    render();
    expect(browserPress(layer(), 100, 100).cancelled).toBe(false);
  });

  it('Enter commits exactly one text object at the click position with the current colour', () => {
    useAnnotationStore.setState({ color: '#ffd60a' });
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());

    type(draftInput()!, 'look here');
    key(draftInput()!, 'Enter');

    expect(draftInput()).toBeNull();
    const texts = textObjects();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ kind: 'text', text: 'look here', color: '#ffd60a', x: 0.25, y: 0.2 });
  });

  it('commits once under StrictMode (no side effects inside a state updater)', () => {
    render(true);
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    type(draftInput()!, 'once');
    key(draftInput()!, 'Enter');
    expect(textObjects()).toHaveLength(1);
  });

  it('Enter followed by the blur of the unmounting input does not commit twice', () => {
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    const input = draftInput()!;
    type(input, 'twice?');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new FocusEvent('blur'));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(textObjects()).toHaveLength(1);
  });

  it('blur commits a non-empty draft and discards an empty one', () => {
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    act(() => { draftInput()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(draftInput()).toBeNull();
    expect(textObjects()).toHaveLength(0);

    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    type(draftInput()!, '  spaced  ');
    act(() => { draftInput()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(textObjects()).toHaveLength(1);
    expect(textObjects()[0]).toMatchObject({ text: 'spaced' });
  });

  it('Escape in the input discards the draft without committing', () => {
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    type(draftInput()!, 'nope');
    key(draftInput()!, 'Escape');
    expect(draftInput()).toBeNull();
    expect(textObjects()).toHaveLength(0);
  });

  it('a second click with the text tool finishes the open caption instead of opening another', () => {
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    type(draftInput()!, 'first');

    pointerDown(layer(), 600, 300);
    pointerUp(layer());
    expect(draftInput()).toBeNull();
    expect(textObjects()).toHaveLength(1);

    // The next click opens a fresh draft
    pointerDown(layer(), 600, 300);
    pointerUp(layer());
    expect(draftInput()).not.toBeNull();
    expect(draftInput()!.value).toBe('');
  });

  it('switching to a drawing tool and pressing commits the caption, then draws', () => {
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    type(draftInput()!, 'then draw');

    act(() => { useAnnotationStore.getState().setActiveTool('pen'); });
    pointerDown(layer(), 50, 50);
    pointerUp(layer());

    expect(draftInput()).toBeNull();
    const objects = useAnnotationStore.getState().scene.objects;
    expect(objects.map((o) => o.kind)).toEqual(['text', 'stroke']);
  });

  it('strips the characters the server rejects the whole batch for, and caps the length', () => {
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    type(draftInput()!, 'a\tb\u200Bc\u202Ed');
    key(draftInput()!, 'Enter');
    expect(textObjects()[0]).toMatchObject({ text: 'abcd' });
  });

  it('sanitizeAnnotationText drops every forbidden class and trims to the wire cap', () => {
    expect(sanitizeAnnotationText('  hi\u0000there\u007F \u200F\u2060\uFEFF ')).toBe('hithere');
    expect(sanitizeAnnotationText('x'.repeat(ANNOTATION_TEXT_MAX + 50))).toHaveLength(ANNOTATION_TEXT_MAX);
    expect(sanitizeAnnotationText('\u202E\u202E')).toBe('');
  });
});

describe('AnnotationEditorLayer — capabilities and gestures', () => {
  const MASKS_ONLY: ToolCapabilities = { tools: new Set(['select', 'mask']), masks: true, images: false };

  it('ignores a press with a tool outside the capability set (a stale activeTool cannot leak)', () => {
    useAnnotationStore.setState({ activeTool: 'pen' });
    render(false, MASKS_ONLY);
    pointerDown(layer(), 100, 100);
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });

  it('a masks-only layer still draws masks and renders their outlines', () => {
    useAnnotationStore.setState({ activeTool: 'mask' });
    render(false, MASKS_ONLY);
    pointerDown(layer(), 100, 100);
    act(() => {
      const ev = new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 250 });
      layer().dispatchEvent(ev);
    });
    pointerUp(layer());
    expect(useAnnotationStore.getState().masks).toHaveLength(1);
    expect(useAnnotationStore.getState().masks[0]).toMatchObject({ x: 0.125, y: 0.2222222222222222 });
    expect(container.querySelectorAll('.border-dashed')).toHaveLength(1);
    // Masks never touch the history
    expect(useAnnotationStore.getState().canUndo).toBe(false);
  });

  it('the mask tool is inert when the capabilities forbid masks, even if listed', () => {
    useAnnotationStore.setState({ activeTool: 'mask' });
    render(false, { tools: new Set(['mask']), masks: false, images: false });
    pointerDown(layer(), 100, 100);
    pointerUp(layer());
    expect(useAnnotationStore.getState().masks).toEqual([]);
  });

  it('a pen drag is ONE history entry (gesture bracketed on pointerdown/up)', () => {
    useAnnotationStore.setState({ activeTool: 'pen' });
    render();
    pointerDown(layer(), 100, 100);
    for (let i = 1; i <= 5; i++) {
      act(() => { layer().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100 + i * 10, clientY: 100 })); });
    }
    pointerUp(layer());
    const stroke = useAnnotationStore.getState().scene.objects[0] as { points: number[] };
    expect(stroke.points).toHaveLength(12);
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });

  it('unmounting mid-drag closes the open gesture (later actions are not swallowed into it)', () => {
    useAnnotationStore.setState({ activeTool: 'pen' });
    render();
    pointerDown(layer(), 100, 100);
    act(() => { layer().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 100 })); });
    // The layer goes away before pointerup (panel collapse, view-mode toggle)
    act(() => root.unmount());
    root = createRoot(container);
    expect(useAnnotationStore.getState().canUndo).toBe(true); // the stroke is a closed entry
    // A later, separate action is its own entry — one undo leaves the stroke
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 'later', kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }]);
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.kind)).toEqual(['stroke']);
    act(() => { root.render(<AnnotationEditorLayer videoRef={videoRef} />); });
  });

  it('a click-without-drag shape is discarded and leaves nothing to undo', () => {
    useAnnotationStore.setState({ activeTool: 'rect' });
    render();
    pointerDown(layer(), 100, 100);
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    expect(useAnnotationStore.getState().canUndo).toBe(false);
  });

  it('selecting and moving a shape is one undo step', () => {
    useAnnotationStore.setState({ activeTool: 'select' });
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 'r', kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }]);
    render();
    pointerDown(layer(), 160, 90); // inside the rect (0.2, 0.2)
    for (let i = 1; i <= 4; i++) {
      act(() => { layer().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160 + i * 40, clientY: 90 })); });
    }
    pointerUp(layer());
    expect((useAnnotationStore.getState().scene.objects[0] as { x: number }).x).toBeCloseTo(0.3);
    act(() => { useAnnotationStore.getState().undo(); });
    expect((useAnnotationStore.getState().scene.objects[0] as { x: number }).x).toBeCloseTo(0.1);
  });
});

describe('AnnotationEditorLayer — arrows', () => {
  beforeEach(() => { useAnnotationStore.setState({ activeTool: 'arrow', color: '#0a84ff', strokeWidth: 0.004 }); });

  it('a drag creates an arrow from the press to the release point, as one undo step', () => {
    render();
    pointerDown(layer(), 80, 45);
    pointerMove(layer(), 400, 45);
    pointerMove(layer(), 720, 225);
    pointerUp(layer());
    const [arrow] = useAnnotationStore.getState().scene.objects;
    expect(arrow).toMatchObject({ kind: 'arrow', color: '#0a84ff', width: 0.004, x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.5 });
    expect((arrow as { heads?: string }).heads).toBeUndefined();
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });

  it('Shift at the start of the drag gives heads at both ends', () => {
    render();
    act(() => {
      const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 80, clientY: 45, shiftKey: true });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      layer().dispatchEvent(ev);
    });
    pointerMove(layer(), 400, 225);
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ kind: 'arrow', heads: 'both' });
  });

  it('a click without a drag leaves no arrow and nothing to undo', () => {
    render();
    pointerDown(layer(), 80, 45);
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    expect(useAnnotationStore.getState().canUndo).toBe(false);
  });

  it('selecting an arrow shows an endpoint handle per end; dragging one reshapes that end only', () => {
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 'ar', kind: 'arrow', color: '#0a84ff', width: 0.004, x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 } }]);
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    pointerDown(layer(), 240, 135); // on the shaft (0.3, 0.3)
    pointerUp(layer());
    expect(useAnnotationStore.getState().selectedObjectId).toBe('ar');
    const handle2 = container.querySelector('[data-testid="arrow-handle-2"]')!;
    expect(handle2).not.toBeNull();
    expect((handle2 as HTMLElement).style.left).toBe('400px');
    pointerDown(handle2, 400, 225);
    pointerMove(layer(), 720, 405);
    pointerUp(layer());
    const arrow = useAnnotationStore.getState().scene.objects[0] as { x1: number; y1: number; x2: number; y2: number };
    expect(arrow.x1).toBeCloseTo(0.1);
    expect(arrow.y1).toBeCloseTo(0.1);
    expect(arrow.x2).toBeCloseTo(0.9);
    expect(arrow.y2).toBeCloseTo(0.9);
  });

  it('moving an arrow ships translate ops (not x/y patches), clamped at the wire edge, as one undo step', () => {
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 'ar', kind: 'arrow', color: '#0a84ff', width: 0.004, x1: 0.7, y1: 0.5, x2: 0.9, y2: 0.5 } }]);
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    pointerDown(layer(), 640, 225); // on the shaft (0.8, 0.5)
    pointerMove(layer(), 720, 225); // +0.1 → x2 would be 1.0
    pointerMove(layer(), 800, 225); // +0.1 more → x2 would be 1.1, the edge
    pointerMove(layer(), 1200, 225); // way past → clamped, nothing more moves
    pointerUp(layer());
    const arrow = useAnnotationStore.getState().scene.objects[0] as { x1: number; x2: number };
    expect(arrow.x2).toBeCloseTo(1.1);
    expect(arrow.x1).toBeCloseTo(0.9);
    act(() => { useAnnotationStore.getState().undo(); });
    const back = useAnnotationStore.getState().scene.objects[0] as { x1: number; x2: number };
    expect(back.x1).toBeCloseTo(0.7);
    expect(back.x2).toBeCloseTo(0.9);
  });
});

describe('AnnotationEditorLayer — numbered callouts', () => {
  beforeEach(() => { useAnnotationStore.setState({ activeTool: 'callout', color: '#ff3b30' }); });

  it('each click places the next number and selects it', () => {
    render();
    pointerDown(layer(), 80, 45); pointerUp(layer());
    pointerDown(layer(), 400, 225); pointerUp(layer());
    const objects = useAnnotationStore.getState().scene.objects;
    expect(objects.map((o) => (o as { n: number }).n)).toEqual([1, 2]);
    expect(objects[1]).toMatchObject({ kind: 'callout', x: 0.5, y: 0.5, color: '#ff3b30' });
    expect(useAnnotationStore.getState().selectedObjectId).toBe(objects[1].id);
    // Each badge is its own undo step
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
  });

  it('numbers are stable: deleting 2 of 3 makes the next badge 4, and Renumber re-sequences', () => {
    render();
    for (const x of [80, 240, 400]) { pointerDown(layer(), x, 45); pointerUp(layer()); }
    const second = useAnnotationStore.getState().scene.objects[1];
    act(() => { useAnnotationStore.getState().localApply([{ t: 'remove', id: second.id }]); });
    pointerDown(layer(), 560, 45); pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects.map((o) => (o as { n: number }).n)).toEqual([1, 3, 4]);
    act(() => { useAnnotationStore.getState().renumberCallouts(); });
    expect(useAnnotationStore.getState().scene.objects.map((o) => (o as { n: number }).n)).toEqual([1, 2, 3]);
    act(() => { useAnnotationStore.getState().undo(); }); // one step
    expect(useAnnotationStore.getState().scene.objects.map((o) => (o as { n: number }).n)).toEqual([1, 3, 4]);
  });

  it('refuses the 100th badge with a toast', () => {
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 'max', kind: 'callout', color: '#ff3b30', size: 0.06, x: 0.1, y: 0.1, n: ANNOTATION_CALLOUT_MAX } }]);
    render();
    pointerDown(layer(), 400, 225); pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    expect(toastError).toHaveBeenCalledWith('voice.annotations.calloutLimit');
  });

  it('double-clicking a badge with the select tool opens a draft to retype its number', () => {
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 'c1', kind: 'callout', color: '#ff3b30', size: 0.06, x: 0.5, y: 0.5, n: 1 } }]);
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    act(() => { layer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 225 })); });
    const input = draftInput()!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('1');
    type(input, '12');
    key(input, 'Enter');
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ n: 12 });
    // Garbage or out-of-range leaves it alone
    act(() => { layer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 225 })); });
    type(draftInput()!, '500');
    key(draftInput()!, 'Enter');
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ n: 12 });
  });
});

describe('AnnotationEditorLayer — spotlight', () => {
  beforeEach(() => { useAnnotationStore.setState({ activeTool: 'spotlight' }); });

  it('a drag creates a rectangular spotlight; Shift at the start makes it elliptical', () => {
    render();
    pointerDown(layer(), 160, 90);
    pointerMove(layer(), 640, 360);
    pointerUp(layer());
    const [spot] = useAnnotationStore.getState().scene.objects;
    expect(spot).toMatchObject({ kind: 'spotlight', x: 0.2, y: 0.2 });
    expect((spot as { w: number }).w).toBeCloseTo(0.6);
    expect((spot as { h: number }).h).toBeCloseTo(0.6);
    expect((spot as { shape?: string }).shape).toBeUndefined();

    act(() => {
      const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 80, clientY: 45, shiftKey: true });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      layer().dispatchEvent(ev);
    });
    pointerMove(layer(), 400, 225);
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ kind: 'spotlight', shape: 'ellipse' });
  });

  it('there is ONE spotlight per scene: a new one replaces the old, and undo brings the old back in one step', () => {
    render();
    pointerDown(layer(), 80, 45); pointerMove(layer(), 240, 135); pointerUp(layer());
    const first = useAnnotationStore.getState().scene.objects[0];
    pointerDown(layer(), 400, 225); pointerMove(layer(), 720, 405); pointerUp(layer());
    const objects = useAnnotationStore.getState().scene.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].id).not.toBe(first.id);
    expect(objects[0]).toMatchObject({ x: 0.5, y: 0.5 });
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual([first.id]);
  });

  it('a click without a drag adds nothing and does not discard an existing spotlight', () => {
    render();
    pointerDown(layer(), 80, 45); pointerMove(layer(), 240, 135); pointerUp(layer());
    pointerDown(layer(), 400, 225); pointerUp(layer());
    // The replace-gesture removed the old one and then discarded the degenerate new one:
    // that nets to "the old spotlight is gone" — so the gesture MUST restore it
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ x: 0.1, y: 0.1 });
    // …and a gesture that changed nothing leaves no history entry
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects).toEqual([]); // that undo removed the ORIGINAL spotlight
  });

  it('is selectable, movable and resizable like a shape', () => {
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 'sp', kind: 'spotlight', x: 0.2, y: 0.2, w: 0.2, h: 0.2 } }]);
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    pointerDown(layer(), 240, 135); // inside (0.3, 0.3)
    pointerMove(layer(), 320, 135);
    pointerUp(layer());
    expect(useAnnotationStore.getState().selectedObjectId).toBe('sp');
    expect((useAnnotationStore.getState().scene.objects[0] as { x: number }).x).toBeCloseTo(0.3);
    expect(container.querySelector('.cursor-nwse-resize')).not.toBeNull();
  });
});

describe('AnnotationEditorLayer — laser pointer', () => {
  beforeEach(() => {
    useAnnotationLiveStore.getState().clear();
    useAnnotationStore.setState({ activeTool: 'laser' });
  });

  it('hovering (no button) points the laser at the cursor, clamped to the frame, and hides the OS cursor', () => {
    render();
    expect(layer().style.cursor).toBe('none');
    pointerMove(layer(), 400, 225);
    expect(useAnnotationLiveStore.getState().pointer).toMatchObject({ x: 0.5, y: 0.5 });
    pointerMove(layer(), -50, 900);
    expect(useAnnotationLiveStore.getState().pointer).toMatchObject({ x: 0, y: 1 });
    // Nothing enters the scene or the history
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    expect(useAnnotationStore.getState().canUndo).toBe(false);
  });

  it('leaving the stage turns the laser off', () => {
    render();
    pointerMove(layer(), 400, 225);
    // React derives onPointerLeave from pointerout/pointerover pairs
    act(() => { layer().dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); });
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
  });

  it('switching tools turns the laser off, and other tools never move it', () => {
    render();
    pointerMove(layer(), 400, 225);
    act(() => { useAnnotationStore.getState().setActiveTool('pen'); });
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
    pointerMove(layer(), 100, 100);
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
    expect(layer().style.cursor).toBe('crosshair');
  });

  it('unmounting with the laser on turns it off', () => {
    render();
    pointerMove(layer(), 400, 225);
    act(() => root.unmount());
    expect(useAnnotationLiveStore.getState().pointer).toBeNull();
    root = createRoot(container);
  });

  it('a press with the laser tool draws nothing', () => {
    render();
    pointerDown(layer(), 400, 225);
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });
});

describe('AnnotationEditorLayer — vanishing ink', () => {
  afterEach(() => { useAnnotationStore.getState().setInkMode('persistent'); voiceState.screenShareAnnotationsVersion = 2; });

  it('pen strokes carry fade: true while the ink mode is vanishing', () => {
    useAnnotationStore.setState({ activeTool: 'pen' });
    useAnnotationStore.getState().setInkMode('vanishing');
    render();
    pointerDown(layer(), 100, 100);
    pointerMove(layer(), 200, 100);
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ kind: 'stroke', fade: true });
  });

  it('…but never on a server that only validates wire version 1 (it would reject the whole batch)', () => {
    useAnnotationStore.setState({ activeTool: 'highlighter' });
    useAnnotationStore.getState().setInkMode('vanishing');
    voiceState.screenShareAnnotationsVersion = 1;
    render();
    pointerDown(layer(), 100, 100);
    pointerMove(layer(), 200, 100);
    pointerUp(layer());
    expect((useAnnotationStore.getState().scene.objects[0] as { fade?: true }).fade).toBeUndefined();
  });
});

describe('AnnotationEditorLayer — text size', () => {
  afterEach(() => { useAnnotationStore.getState().setTextSize(0.045); localStorage.removeItem('vox:annotations:prefs'); });

  it('new captions and badges follow the text-size setting; the draft input is painted at that size', () => {
    useAnnotationStore.getState().setTextSize(0.1);
    useAnnotationStore.setState({ activeTool: 'text' });
    render();
    pointerDown(layer(), 200, 90);
    pointerUp(layer());
    expect(draftInput()!.style.fontSize).toBe('45px'); // 0.1 × 450
    type(draftInput()!, 'big');
    key(draftInput()!, 'Enter');
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ kind: 'text', size: 0.1 });

    act(() => { useAnnotationStore.setState({ activeTool: 'callout' }); }); // re-render before the press
    pointerDown(layer(), 400, 225); pointerUp(layer());
    expect((useAnnotationStore.getState().scene.objects[1] as { size: number }).size).toBeCloseTo(0.1 * 4 / 3);
  });

  it('a selected caption has a resize handle that scales its size by the dragged height', () => {
    useAnnotationStore.getState().localApply([{ t: 'add', obj: { id: 't', kind: 'text', text: 'hello', color: '#ffffff', size: 0.045, x: 0.2, y: 0.2 } }]);
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    pointerDown(layer(), 170, 95); pointerUp(layer()); // inside the caption's box
    expect(useAnnotationStore.getState().selectedObjectId).toBe('t');
    const handle = container.querySelector('.cursor-nwse-resize')!;
    expect(handle).not.toBeNull();
    pointerDown(handle, 200, 110);
    pointerMove(layer(), 300, 135); // bottom at y=0.3 → height 0.1
    pointerUp(layer());
    expect((useAnnotationStore.getState().scene.objects[0] as { size: number }).size).toBeCloseTo(0.1);
    act(() => { useAnnotationStore.getState().undo(); });
    expect((useAnnotationStore.getState().scene.objects[0] as { size: number }).size).toBe(0.045);
  });
});

describe('AnnotationEditorLayer — eraser and stroke editing', () => {
  const strokeAt = (id: string, y: number) => ({ t: 'add' as const, obj: { id, kind: 'stroke' as const, tool: 'pen' as const, color: '#ff0000', width: 0.01, points: [0.1, y, 0.9, y] } });

  it('the eraser removes every object it sweeps over, as one undo step, and leaves the rest', () => {
    const store = useAnnotationStore.getState();
    store.localApply([strokeAt('top', 0.2), strokeAt('mid', 0.5), strokeAt('bottom', 0.8)]);
    store.localApply([{ t: 'add', obj: { id: 'badge', kind: 'callout', color: '#ff3b30', size: 0.06, x: 0.5, y: 0.5, n: 1 } }]);
    useAnnotationStore.setState({ activeTool: 'eraser' });
    render();
    expect(layer().style.cursor).toBe('cell');
    pointerDown(layer(), 400, 85);   // on 'top' (y = 0.19)
    pointerMove(layer(), 400, 150);  // empty
    pointerMove(layer(), 400, 225);  // the badge sits over 'mid' — topmost goes first
    pointerMove(layer(), 400, 226);  // now 'mid' is the topmost here
    pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['bottom']);
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['top', 'mid', 'bottom', 'badge']);
  });

  it('erasing a selected object drops the selection; a sweep over nothing is not an entry', () => {
    const store = useAnnotationStore.getState();
    store.localApply([strokeAt('s', 0.5)]);
    store.setSelectedObjectId('s');
    useAnnotationStore.setState({ activeTool: 'eraser' });
    render();
    pointerDown(layer(), 400, 45); pointerUp(layer()); // empty space
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects).toEqual([]); // undid the ADD, not a no-op sweep
    act(() => { useAnnotationStore.getState().redo(); });
    pointerDown(layer(), 400, 225); pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    expect(useAnnotationStore.getState().selectedObjectId).toBeNull();
  });

  it('a stroke is selected along its path (not its box) and moves with translate, one undo step', () => {
    const store = useAnnotationStore.getState();
    // A square loop: the middle of its box is empty
    store.localApply([{ t: 'add', obj: { id: 'loop', kind: 'stroke', tool: 'pen', color: '#ff0000', width: 0.01, points: [0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8, 0.2, 0.2] } }]);
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    pointerDown(layer(), 400, 225); pointerUp(layer()); // the hollow middle
    expect(useAnnotationStore.getState().selectedObjectId).toBeNull();
    pointerDown(layer(), 400, 90);                        // on the top edge
    pointerMove(layer(), 400, 135);                       // +0.1 down
    pointerUp(layer());
    expect(useAnnotationStore.getState().selectedObjectId).toBe('loop');
    const moved = useAnnotationStore.getState().scene.objects[0] as { points: number[] };
    expect(moved.points[1]).toBeCloseTo(0.3);
    expect(moved.points[0]).toBeCloseTo(0.2);
    expect(container.querySelector('.cursor-nwse-resize')).toBeNull(); // strokes have no corner handle
    act(() => { useAnnotationStore.getState().undo(); });
    expect((useAnnotationStore.getState().scene.objects[0] as { points: number[] }).points[1]).toBeCloseTo(0.2);
  });

  it('strokes are NOT selectable against a v1 server (a move would ship a v2 translate op)', () => {
    useAnnotationStore.getState().localApply([strokeAt('s', 0.5)]);
    useAnnotationStore.setState({ activeTool: 'select' });
    voiceState.screenShareAnnotationsVersion = 1;
    try {
      render();
      pointerDown(layer(), 400, 225); // on the stroke
      pointerMove(layer(), 400, 300);
      pointerUp(layer());
      expect(useAnnotationStore.getState().selectedObjectId).toBeNull();
      expect((useAnnotationStore.getState().scene.objects[0] as { points: number[] }).points[1]).toBe(0.5);
    } finally {
      voiceState.screenShareAnnotationsVersion = 2;
    }
  });

  it('double-clicking a caption edits its text; emptying it deletes it', () => {
    const store = useAnnotationStore.getState();
    store.localApply([{ t: 'add', obj: { id: 't', kind: 'text', text: 'hello', color: '#ffffff', size: 0.045, x: 0.2, y: 0.2 } }]);
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    act(() => { layer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 170, clientY: 95 })); });
    expect(draftInput()!.value).toBe('hello');
    type(draftInput()!, 'hello world');
    key(draftInput()!, 'Enter');
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ text: 'hello world' });
    act(() => { useAnnotationStore.getState().undo(); });
    expect(useAnnotationStore.getState().scene.objects[0]).toMatchObject({ text: 'hello' });

    act(() => { layer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 170, clientY: 95 })); });
    type(draftInput()!, '   ');
    key(draftInput()!, 'Enter');
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
  });
});

describe('AnnotationEditorLayer — mask styles', () => {
  afterEach(() => { useAnnotationStore.setState({ maskStyle: 'cover' }); });

  it('a new mask takes the current style; Cover leaves the field absent', () => {
    useAnnotationStore.setState({ activeTool: 'mask', maskStyle: 'pixelate' });
    render();
    pointerDown(layer(), 100, 100); pointerMove(layer(), 300, 250); pointerUp(layer());
    expect(useAnnotationStore.getState().masks[0].style).toBe('pixelate');
    act(() => { useAnnotationStore.setState({ maskStyle: 'cover' }); });
    pointerDown(layer(), 400, 100); pointerMove(layer(), 600, 250); pointerUp(layer());
    expect(useAnnotationStore.getState().masks[1].style).toBeUndefined();
  });
});

describe('AnnotationEditorLayer — review fixes', () => {
  it('a spotlight added over an annotation does not steal its clicks: hit order mirrors paint order', () => {
    const store = useAnnotationStore.getState();
    store.localApply([{ t: 'add', obj: { id: 'sh', kind: 'shape', shape: 'rect', color: '#00ff00', width: 0.004, x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }]);
    store.localApply([{ t: 'add', obj: { id: 'sp', kind: 'spotlight', x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }]); // later = last in the array
    useAnnotationStore.setState({ activeTool: 'select' });
    render();
    pointerDown(layer(), 400, 225); pointerUp(layer()); // inside BOTH; the shape is the visible one
    expect(useAnnotationStore.getState().selectedObjectId).toBe('sh');
    pointerDown(layer(), 240, 135); pointerUp(layer()); // inside the spotlight only
    expect(useAnnotationStore.getState().selectedObjectId).toBe('sp');

    // The eraser sweeps the same way: the shape goes before the spotlight
    act(() => { useAnnotationStore.getState().setActiveTool('eraser'); });
    pointerDown(layer(), 400, 225); pointerUp(layer());
    expect(useAnnotationStore.getState().scene.objects.map((o) => o.id)).toEqual(['sp']);
  });

  it('the 2000-point roll-over carries `fade` into the continuation stroke', () => {
    useAnnotationStore.getState().setInkMode('vanishing');
    useAnnotationStore.setState({ activeTool: 'pen' });
    render();
    pointerDown(layer(), 0, 45);
    // Enough >2px steps to cross ANNOTATION_STROKE_MAX_POINTS and roll over
    for (let i = 0; i < 2010; i++) {
      const x = 10 + (i % 2 ? 3 : 0) + Math.floor(i / 2) * 0; // wiggle in place is filtered — walk instead
      void x;
      pointerMoveRaw(layer(), 10 + (i * 3) % 780, 45 + Math.floor((i * 3) / 780) * 3);
    }
    pointerUp(layer());
    const strokes = useAnnotationStore.getState().scene.objects.filter((o) => o.kind === 'stroke');
    expect(strokes.length).toBeGreaterThanOrEqual(2); // rolled over at the cap
    for (const st of strokes) expect((st as { fade?: true }).fade).toBe(true);
    useAnnotationStore.getState().setInkMode('persistent');
  });
});

/** pointermove without act() batching per event — 2000 acts would take minutes. */
function pointerMoveRaw(el: Element, x: number, y: number) {
  act(() => { el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })); });
}
