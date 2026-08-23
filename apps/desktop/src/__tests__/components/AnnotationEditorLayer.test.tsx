import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ANNOTATION_TEXT_MAX } from '@voxium/shared';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// annotationStore pulls in the socket service and voiceStore (module-scope
// lifecycle subscription) — stub both. localApply needs an active channel.
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: {
    getState: () => ({ activeChannelId: 'chan-1', screenSharingUserId: 'me', isScreenSharing: true, screenStream: null }),
    subscribe: () => () => {},
  },
}));
vi.mock('../../services/screenComposite', () => ({
  ensureComposite: vi.fn(),
  stopComposite: vi.fn(),
  teardownComposite: vi.fn(),
  isCompositing: () => false,
}));

// jsdom has no layout: pin the video content rect the layer positions itself on.
const RECT = { x: 0, y: 0, w: 800, h: 450 };
vi.mock('../../hooks/useVideoContentRect', () => ({
  useVideoContentRect: () => RECT,
}));

import { AnnotationEditorLayer, sanitizeAnnotationText, type ToolCapabilities } from '../../components/voice/AnnotationEditorLayer';
import { useAnnotationStore } from '../../stores/annotationStore';

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
