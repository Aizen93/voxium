import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// annotationStore pulls in the socket service and voiceStore (module-scope
// lifecycle subscription) — stub both.
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));
// The toolbar reads screenShareAnnotationsVersion through the hook form, so
// the stand-in must be callable with a selector as well as expose getState.
const voiceState = vi.hoisted(() => ({ activeChannelId: 'chan-1', screenSharingUserId: null as string | null, isScreenSharing: false, screenShareAnnotationsVersion: 2 }));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign((selector: (s: typeof voiceState) => unknown) => selector(voiceState), {
    getState: () => voiceState,
    subscribe: () => () => {},
  }),
}));

import { AnnotationToolbar } from '../../components/voice/AnnotationToolbar';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { TOOL_DEFS, MASK_TOOL_DEF, availableToolDefs } from '../../components/voice/annotationPresets';

const initialState = useAnnotationStore.getState();

let container: HTMLDivElement;
let root: Root;

function render(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
}

function click(el: Element | null) {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  useAnnotationStore.setState(initialState, true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AnnotationToolbar', () => {
  it('starts collapsed and expands into the full toolbar via the Annotate toggle', () => {
    render(<AnnotationToolbar />);
    expect(container.querySelector('[data-testid="annotation-toolbar-collapsed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="annotation-toolbar"]')).toBeNull();

    click(container.querySelector('button'));

    expect(useAnnotationStore.getState().isEditing).toBe(true);
    expect(container.querySelector('[data-testid="annotation-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="annotation-toolbar-collapsed"]')).toBeNull();
  });

  it('selects tools and reflects the active one via aria-pressed', () => {
    useAnnotationStore.setState({ isEditing: true });
    render(<AnnotationToolbar />);

    const maskButton = container.querySelector('[aria-label="voice.annotations.mask"]')!;
    click(maskButton);
    expect(useAnnotationStore.getState().activeTool).toBe('mask');
    expect(maskButton.getAttribute('aria-pressed')).toBe('true');

    const penButton = container.querySelector('[aria-label="voice.annotations.pen"]')!;
    expect(penButton.getAttribute('aria-pressed')).toBe('false');
    click(penButton);
    expect(useAnnotationStore.getState().activeTool).toBe('pen');
  });

  it('changing tools clears any selection', () => {
    useAnnotationStore.setState({ isEditing: true, selectedObjectId: 'obj-1' });
    render(<AnnotationToolbar />);
    click(container.querySelector('[aria-label="voice.annotations.rectangle"]'));
    expect(useAnnotationStore.getState().selectedObjectId).toBeNull();
  });

  it('sets color and stroke width from the presets', () => {
    useAnnotationStore.setState({ isEditing: true });
    render(<AnnotationToolbar />);

    click(container.querySelector('[aria-label="voice.annotations.color #ffd60a"]'));
    expect(useAnnotationStore.getState().color).toBe('#ffd60a');

    click(container.querySelector('[aria-label="voice.annotations.width thick"]'));
    expect(useAnnotationStore.getState().strokeWidth).toBe(0.008);
  });

  it('Done collapses the toolbar and drops the selection', () => {
    useAnnotationStore.setState({ isEditing: true, selectedObjectId: 'obj-1' });
    render(<AnnotationToolbar />);
    click(container.querySelector('[aria-label="voice.annotations.done"]'));
    const state = useAnnotationStore.getState();
    expect(state.isEditing).toBe(false);
    expect(state.selectedObjectId).toBeNull();
  });

  it('undo/redo buttons follow canUndo/canRedo and call the store actions', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    useAnnotationStore.setState({ isEditing: true, canUndo: false, canRedo: false, undo, redo });
    render(<AnnotationToolbar />);
    const undoBtn = container.querySelector('[aria-label="voice.annotations.undo"]') as HTMLButtonElement;
    const redoBtn = container.querySelector('[aria-label="voice.annotations.redo"]') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    expect(redoBtn.disabled).toBe(true);

    act(() => { useAnnotationStore.setState({ canUndo: true, canRedo: true }); });
    expect(undoBtn.disabled).toBe(false);
    expect(redoBtn.disabled).toBe(false);
    click(undoBtn);
    click(redoBtn);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it('tooltips carry the shortcut, and hide it for the key push-to-talk owns', () => {
    useAnnotationStore.setState({ isEditing: true });
    useSettingsStore.setState({ voiceMode: 'push_to_talk', pushToTalkKey: 'KeyP' });
    render(<AnnotationToolbar />);
    expect(container.querySelector('[data-tool="rect"]')!.getAttribute('title')).toBe('voice.annotations.rectangle (R)');
    expect(container.querySelector('[data-tool="rect"]')!.getAttribute('aria-keyshortcuts')).toBe('R');
    expect(container.querySelector('[data-tool="pen"]')!.getAttribute('title')).toBe('voice.annotations.pen');
    expect(container.querySelector('[aria-label="voice.annotations.undo"]')!.getAttribute('title')).toBe('voice.annotations.undo (Ctrl+Z)');
    useSettingsStore.setState({ voiceMode: 'voice_activity' });
  });

  it('every tool definition has a unique key and label', () => {
    const defs = [...TOOL_DEFS, MASK_TOOL_DEF];
    expect(new Set(defs.map((d) => d.code)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => d.keyLabel)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => d.labelKey)).size).toBe(defs.length);
    // v2 tools are offered only once the server advertised wire version 2
    expect(availableToolDefs(2).map((d) => d.tool)).toContain('arrow');
    expect(availableToolDefs(2).map((d) => d.tool)).toContain('callout');
    expect(availableToolDefs(1).map((d) => d.tool)).not.toContain('arrow');
    expect(availableToolDefs(1).map((d) => d.tool)).not.toContain('callout');
  });

  it('hides the v2 tools when the server only validates wire version 1', () => {
    useAnnotationStore.setState({ isEditing: true });
    voiceState.screenShareAnnotationsVersion = 1;
    try {
      render(<AnnotationToolbar />);
      expect(container.querySelector('[data-tool="arrow"]')).toBeNull();
      expect(container.querySelector('[data-tool="pen"]')).not.toBeNull();
    } finally {
      voiceState.screenShareAnnotationsVersion = 2;
    }
  });

  it('the vanishing-ink toggle flips the device preference and is hidden below wire version 2', () => {
    useAnnotationStore.setState({ isEditing: true });
    render(<AnnotationToolbar />);
    const toggle = container.querySelector('[data-testid="ink-mode-toggle"]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    expect(useAnnotationStore.getState().inkMode).toBe('vanishing');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    click(toggle);
    expect(useAnnotationStore.getState().inkMode).toBe('persistent');

    voiceState.screenShareAnnotationsVersion = 1;
    try {
      act(() => { root.unmount(); });
      root = createRoot(container);
      render(<AnnotationToolbar />);
      expect(container.querySelector('[data-testid="ink-mode-toggle"]')).toBeNull();
    } finally {
      voiceState.screenShareAnnotationsVersion = 2;
    }
  });

  it('the palette popover offers presets, a native picker (normalized to #rrggbb) and recents', () => {
    useAnnotationStore.setState({ isEditing: true, recentColors: [] });
    render(<AnnotationToolbar />);
    expect(document.querySelector('[data-testid="palette-popover"]')).toBeNull();
    click(container.querySelector('[data-testid="palette-toggle"]'));
    const popover = document.querySelector('[data-testid="palette-popover"]')!;
    expect(popover).not.toBeNull();
    expect(popover.querySelectorAll('button[aria-pressed]').length).toBeGreaterThanOrEqual(16);

    // A preset that is not a quick swatch becomes a recent; the popover closes
    click(popover.querySelector('[title="#bf5af2"]'));
    expect(useAnnotationStore.getState().color).toBe('#bf5af2');
    expect(useAnnotationStore.getState().recentColors).toEqual(['#bf5af2']);
    expect(document.querySelector('[data-testid="palette-popover"]')).toBeNull();

    click(container.querySelector('[data-testid="palette-toggle"]'));
    const custom = document.querySelector('[data-testid="palette-custom"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(custom, '#123456');
      custom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useAnnotationStore.getState().color).toBe('#123456');
    expect(useAnnotationStore.getState().recentColors).toEqual(['#123456', '#bf5af2']);
    expect(document.querySelectorAll('[data-testid="palette-recents"] button')).toHaveLength(2);

    // Escape closes it
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(document.querySelector('[data-testid="palette-popover"]')).toBeNull();
    useAnnotationStore.setState({ recentColors: [] });
    localStorage.removeItem('vox:annotations:prefs');
  });

  it('the text-size segment appears for the text/callout tools or a selected caption, and sets the size', () => {
    useAnnotationStore.setState({ isEditing: true, activeTool: 'pen' });
    render(<AnnotationToolbar />);
    expect(container.querySelector('[data-testid="text-size-picker"]')).toBeNull();
    act(() => { useAnnotationStore.getState().setActiveTool('text'); });
    expect(container.querySelector('[data-testid="text-size-picker"]')).not.toBeNull();
    click(container.querySelector('[aria-label="voice.annotations.textSize L"]'));
    expect(useAnnotationStore.getState().textSize).toBe(0.07);
    act(() => {
      useAnnotationStore.getState().setActiveTool('select');
      useAnnotationStore.setState({ scene: { objects: [{ id: 't', kind: 'text', text: 'x', color: '#ffffff', size: 0.045, x: 0, y: 0 }] }, selectedObjectId: 't' });
    });
    expect(container.querySelector('[data-testid="text-size-picker"]')).not.toBeNull();
    useAnnotationStore.getState().setTextSize(0.045);
    localStorage.removeItem('vox:annotations:prefs');
  });

  it('the mask-style segment shows with the mask tool, labels blur/pixelate as cosmetic, and follows a selected mask', () => {
    useAnnotationStore.setState({ isEditing: true, activeTool: 'pen' });
    render(<AnnotationToolbar />);
    expect(container.querySelector('[data-testid="mask-style-picker"]')).toBeNull();
    act(() => { useAnnotationStore.getState().setActiveTool('mask'); });
    const picker = container.querySelector('[data-testid="mask-style-picker"]')!;
    expect(picker).not.toBeNull();
    expect(picker.querySelector('[data-mask-style="cover"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(picker.querySelector('[data-mask-style="blur"]')!.getAttribute('title')).toContain('voice.annotations.maskStyleCosmetic');
    expect(picker.querySelector('[data-mask-style="cover"]')!.getAttribute('title')).not.toContain('maskStyleCosmetic');
    click(picker.querySelector('[data-mask-style="pixelate"]'));
    expect(useAnnotationStore.getState().maskStyle).toBe('pixelate');

    act(() => {
      useAnnotationStore.getState().setActiveTool('select');
      useAnnotationStore.setState({ masks: [{ id: 'm', x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: 'blur' }], selectedObjectId: 'm' });
    });
    expect(container.querySelector('[data-mask-style="blur"]')!.getAttribute('aria-pressed')).toBe('true');
    useAnnotationStore.setState({ maskStyle: 'cover' });
  });

  it('offers Renumber only while the scene has callouts', () => {
    useAnnotationStore.setState({ isEditing: true });
    render(<AnnotationToolbar />);
    expect(container.querySelector('[aria-label="voice.annotations.renumber"]')).toBeNull();
    act(() => {
      useAnnotationStore.setState({ scene: { objects: [{ id: 'c', kind: 'callout', color: '#ff3b30', size: 0.06, x: 0.1, y: 0.1, n: 1 }] } });
    });
    expect(container.querySelector('[aria-label="voice.annotations.renumber"]')).not.toBeNull();
  });

  it('the mask tool carries the privacy hint in its tooltip', () => {
    useAnnotationStore.setState({ isEditing: true });
    render(<AnnotationToolbar />);
    const maskButton = container.querySelector('[aria-label="voice.annotations.mask"]')!;
    expect(maskButton.getAttribute('title')).toContain('voice.annotations.maskPrivacyHint');
  });
});
