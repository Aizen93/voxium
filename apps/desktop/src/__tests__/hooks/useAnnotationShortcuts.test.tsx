import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: {
    getState: () => ({ activeChannelId: 'chan-1', screenSharingUserId: 'me', isScreenSharing: true, screenStream: null }),
    subscribe: () => () => {},
  },
  registerShareMaskHooks: vi.fn(), isShareActivationInFlight: () => false,
}));
vi.mock('../../services/screenComposite', () => ({
  ensureComposite: vi.fn(), stopComposite: vi.fn(), teardownComposite: vi.fn(), isCompositing: () => false,
}));

import { useAnnotationShortcuts, isEditableTarget, pttReservedCode, shortcutFor } from '../../hooks/useAnnotationShortcuts';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ANNOTATION_COLORS, ANNOTATION_WIDTHS, TOOL_DEFS, availableToolDefs } from '../../components/voice/annotationPresets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useAnnotationStore.getState();
const V1_TOOLS = availableToolDefs(1);

function Harness({ version = 2 }: { version?: number }) {
  useAnnotationShortcuts(availableToolDefs(version));
  return null;
}

let container: HTMLDivElement;
let root: Root;

function mount(version = 2) {
  act(() => { root.render(<Harness version={version} />); });
}

function press(code: string, opts: Partial<KeyboardEventInit> & { target?: Element } = {}): boolean {
  const { target, ...init } = opts;
  const key = init.key ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code);
  const ev = new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...init });
  let notCancelled = true;
  act(() => { notCancelled = (target ?? window).dispatchEvent(ev); });
  return !notCancelled;
}

beforeEach(() => {
  useAnnotationStore.getState().clearViewerScene();
  useAnnotationStore.setState({ ...initialState, isEditing: true, activeTool: 'pen', scene: { objects: [] } }, true);
  useSettingsStore.setState({ voiceMode: 'voice_activity', pushToTalkKey: 'Backquote' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useAnnotationShortcuts — tools', () => {
  it('every offered tool has a key that selects it (and the event is consumed)', () => {
    mount();
    for (const def of availableToolDefs(2)) {
      expect(press(def.code)).toBe(true);
      expect(useAnnotationStore.getState().activeTool).toBe(def.tool);
    }
    expect(press('KeyM')).toBe(true);
    expect(useAnnotationStore.getState().activeTool).toBe('mask');
  });

  it('keys of tools the toolbar does not offer (v2 below version 2, unimplemented) do nothing', () => {
    mount(1);
    const v2Only = TOOL_DEFS.filter((d) => d.v2);
    expect(v2Only.length).toBeGreaterThan(0);
    for (const def of v2Only) {
      expect(press(def.code)).toBe(false);
      expect(useAnnotationStore.getState().activeTool).toBe('pen');
    }
    // Offered v1 tools still work
    expect(V1_TOOLS.some((d) => d.tool === 'rect')).toBe(true);
    press('KeyR');
    expect(useAnnotationStore.getState().activeTool).toBe('rect');
  });

  it('does nothing while not editing', () => {
    useAnnotationStore.setState({ isEditing: false });
    mount();
    expect(press('KeyR')).toBe(false);
    expect(useAnnotationStore.getState().activeTool).toBe('pen');
  });

  it('never fires while typing in an input, textarea or contentEditable', () => {
    mount();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    for (const el of [input, textarea, editable]) {
      document.body.appendChild(el);
      expect(press('KeyR', { target: el })).toBe(false);
      expect(press('KeyZ', { ctrlKey: true, target: el })).toBe(false);
      el.remove();
    }
    expect(useAnnotationStore.getState().activeTool).toBe('pen');
    expect(isEditableTarget(null)).toBe(false);
  });

  it('ignores modified and repeated presses for tool keys', () => {
    mount();
    expect(press('KeyR', { ctrlKey: true })).toBe(false); // Ctrl+R is the browser's
    expect(press('KeyR', { altKey: true })).toBe(false);
    expect(press('KeyR', { repeat: true })).toBe(false);
    expect(useAnnotationStore.getState().activeTool).toBe('pen');
  });
});

describe('useAnnotationShortcuts — push-to-talk wins', () => {
  it('the PTT key is dead for shortcuts while PTT is the voice mode, and its tooltip hides the key', () => {
    useSettingsStore.setState({ voiceMode: 'push_to_talk', pushToTalkKey: 'KeyP' });
    mount();
    expect(press('KeyP')).toBe(false);
    useAnnotationStore.setState({ activeTool: 'rect' });
    press('KeyP');
    expect(useAnnotationStore.getState().activeTool).toBe('rect');
    const pen = TOOL_DEFS.find((d) => d.tool === 'pen')!;
    expect(shortcutFor(pen, pttReservedCode(useSettingsStore.getState()))).toBeNull();
    expect(shortcutFor(TOOL_DEFS.find((d) => d.tool === 'rect')!, 'KeyP')).toBe('R');
  });

  it('the same key works again under voice activity', () => {
    useSettingsStore.setState({ voiceMode: 'voice_activity', pushToTalkKey: 'KeyP' });
    mount();
    useAnnotationStore.setState({ activeTool: 'rect' });
    press('KeyP');
    expect(useAnnotationStore.getState().activeTool).toBe('pen');
    expect(pttReservedCode({ voiceMode: 'voice_activity', pushToTalkKey: 'KeyP' })).toBeNull();
  });
});

describe('useAnnotationShortcuts — history, selection, presets', () => {
  const shape = (id: string) => ({ t: 'add' as const, obj: { id, kind: 'shape' as const, shape: 'rect' as const, color: '#00ff00', width: 0.004, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });

  it('Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo, ⌘ works like Ctrl', () => {
    mount();
    const store = useAnnotationStore.getState();
    store.localApply([shape('a')]);
    expect(press('KeyZ', { ctrlKey: true })).toBe(true);
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    press('KeyZ', { ctrlKey: true, shiftKey: true });
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
    press('KeyZ', { metaKey: true });
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    press('KeyY', { ctrlKey: true });
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
  });

  it('Delete / Backspace remove the selected object or mask; Escape deselects', () => {
    mount();
    const store = useAnnotationStore.getState();
    store.localApply([shape('a')]);
    store.setSelectedObjectId('a');
    expect(press('Delete', { key: 'Delete' })).toBe(true);
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    expect(useAnnotationStore.getState().selectedObjectId).toBeNull();

    store.addMask({ id: 'm', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    store.setSelectedObjectId('m');
    press('Backspace', { key: 'Backspace' });
    expect(useAnnotationStore.getState().masks).toEqual([]);

    store.localApply([shape('b')]);
    store.setSelectedObjectId('b');
    press('Escape', { key: 'Escape' });
    expect(useAnnotationStore.getState().selectedObjectId).toBeNull();
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);
  });

  it('Backspace with nothing selected is left to the page', () => {
    mount();
    expect(press('Backspace', { key: 'Backspace' })).toBe(false);
  });

  it('[ and ] step the width through the presets and stop at the ends', () => {
    mount();
    useAnnotationStore.setState({ strokeWidth: ANNOTATION_WIDTHS[1].value });
    press('BracketRight', { key: ']' });
    expect(useAnnotationStore.getState().strokeWidth).toBe(ANNOTATION_WIDTHS[2].value);
    press('BracketRight', { key: ']' });
    expect(useAnnotationStore.getState().strokeWidth).toBe(ANNOTATION_WIDTHS[2].value);
    press('BracketLeft', { key: '[' });
    press('BracketLeft', { key: '[' });
    press('BracketLeft', { key: '[' });
    expect(useAnnotationStore.getState().strokeWidth).toBe(ANNOTATION_WIDTHS[0].value);
    // A non-preset width snaps to medium
    useAnnotationStore.setState({ strokeWidth: 0.0031 });
    press('BracketRight', { key: ']' });
    expect(useAnnotationStore.getState().strokeWidth).toBe(ANNOTATION_WIDTHS[1].value);
  });

  it('1–6 pick the quick colours', () => {
    mount();
    press('Digit3');
    expect(useAnnotationStore.getState().color).toBe(ANNOTATION_COLORS[2]);
    press('Digit6');
    expect(useAnnotationStore.getState().color).toBe(ANNOTATION_COLORS[5]);
    expect(press('Digit7')).toBe(false);
  });
});
