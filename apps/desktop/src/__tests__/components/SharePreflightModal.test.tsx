import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// A REAL zustand store stands in for voiceStore — the modal must re-render
// when pendingShare changes, which a plain callable mock cannot do.
vi.mock('../../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  const useVoiceStore = create(() => ({
    pendingShare: null as { stream: MediaStream; sourceKey: string | null; displaySurface: string } | null,
    activeChannelId: 'chan-1' as string | null,
    isScreenSharing: false,
    localUserId: 'me' as string | null,
    screenShareSourceKey: null as string | null,
    screenSharingUserId: null as string | null,
    screenStream: null,
    confirmPendingShare: vi.fn().mockResolvedValue(undefined),
    cancelPendingShare: vi.fn(),
  }));
  return { useVoiceStore, registerShareMaskHooks: vi.fn(), isShareActivationInFlight: () => false };
});

vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));
vi.mock('../../services/screenComposite', () => ({
  ensureComposite: vi.fn(), stopComposite: vi.fn(), teardownComposite: vi.fn(), isCompositing: () => false,
  resumeSourceHold: vi.fn(), prepareComposite: vi.fn(), attachCompositeProducerHandles: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { SharePreflightModal } from '../../components/voice/SharePreflightModal';
import { useVoiceStore } from '../../stores/voiceStore';
const voiceMock = { useVoiceStore: useVoiceStore as unknown as typeof useVoiceStore & { setState: (p: object) => void } };
import { useAnnotationStore } from '../../stores/annotationStore';
import { useMaskLayoutStore } from '../../stores/maskLayoutStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialAnnotation = useAnnotationStore.getState();

function fakeStream(): MediaStream {
  return { getTracks: () => [], getVideoTracks: () => [], active: true } as unknown as MediaStream;
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => { root.render(<SharePreflightModal />); });
}

function openPreflight(displaySurface = 'window') {
  act(() => {
    voiceMock.useVoiceStore.setState({ pendingShare: { stream: fakeStream(), sourceKey: 'window:1280x720', displaySurface } });
  });
}

const modal = () => document.querySelector('[data-testid="share-preflight"]');

beforeEach(() => {
  useAnnotationStore.setState({ ...initialAnnotation, activeTool: 'pen', masks: [] }, true);
  useMaskLayoutStore.setState({ appliedLayout: null });
  voiceMock.useVoiceStore.setState({ pendingShare: null, activeChannelId: 'chan-1' });
  vi.mocked(voiceMock.useVoiceStore.getState().cancelPendingShare).mockClear();
  vi.mocked(voiceMock.useVoiceStore.getState().confirmPendingShare).mockClear();
  localStorage.removeItem('vox:annotations:prefs');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('vox:annotations:prefs');
});

describe('SharePreflightModal', () => {
  it('renders nothing without a pending share, and the full modal with one — mask tool preselected', () => {
    render();
    expect(modal()).toBeNull();
    openPreflight();
    expect(modal()).not.toBeNull();
    expect(useAnnotationStore.getState().activeTool).toBe('mask');
    expect(modal()!.querySelector('[data-testid="preflight-go-live"]')).not.toBeNull();
    expect(modal()!.querySelector('[data-testid="preflight-monitor-nudge"]')).toBeNull(); // a window capture
  });

  it('a whole-monitor capture always carries the nudge', () => {
    render();
    openPreflight('monitor');
    expect(modal()!.querySelector('[data-testid="preflight-monitor-nudge"]')).not.toBeNull();
  });

  it('Go live confirms; Cancel and Escape cancel', () => {
    render();
    openPreflight();
    act(() => { (modal()!.querySelector('[data-testid="preflight-go-live"]') as HTMLButtonElement).click(); });
    expect(voiceMock.useVoiceStore.getState().confirmPendingShare).toHaveBeenCalledTimes(1);

    act(() => { (modal()!.querySelector('[data-testid="preflight-cancel"]') as HTMLButtonElement).click(); });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).toHaveBeenCalledTimes(1);

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).toHaveBeenCalledTimes(2);
  });

  it('leaving voice mid-pre-flight abandons it', () => {
    render();
    openPreflight();
    act(() => { voiceMock.useVoiceStore.setState({ activeChannelId: null }); });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).toHaveBeenCalled();
  });

  it('the skip checkbox persists — and the whole-screen warning is documented as staying', () => {
    render();
    openPreflight();
    const box = modal()!.querySelector('[data-testid="preflight-skip"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    act(() => { box.click(); });
    expect(JSON.parse(localStorage.getItem('vox:annotations:prefs')!)).toMatchObject({ skipPreflight: true });
    act(() => { box.click(); });
    expect(JSON.parse(localStorage.getItem('vox:annotations:prefs')!)).toMatchObject({ skipPreflight: false });
  });

  it('shows the applied-layout banner with Start fresh wired to the layout store', () => {
    useAnnotationStore.setState({ masks: [{ id: 'applied-1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] });
    useMaskLayoutStore.setState({ appliedLayout: { key: 'window:1280x720', count: 1, ids: ['applied-1'] } });
    render();
    openPreflight();
    expect(modal()!.querySelector('[data-testid="preflight-layout-banner"]')).not.toBeNull();
    act(() => { (modal()!.querySelector('[data-testid="preflight-layout-banner"] button') as HTMLButtonElement).click(); });
    expect(useAnnotationStore.getState().masks).toEqual([]);
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();
  });

  it('drafting tools show while NOBODY shares; Delete/Backspace removes the selected draft or mask', () => {
    render();
    openPreflight();
    expect(modal()!.querySelector('[data-preflight-tool="text"]')).not.toBeNull();
    expect(modal()!.querySelector('[data-preflight-tool="image"]')).not.toBeNull();
    expect(modal()!.querySelector('[data-preflight-tool="eraser"]')).not.toBeNull();

    act(() => {
      useAnnotationStore.getState().localApply([
        { t: 'add', obj: { id: 'note', kind: 'text', text: 'hi', color: '#ff0000', size: 0.05, x: 0.1, y: 0.1 } },
      ]);
      useAnnotationStore.setState({ selectedObjectId: 'note' });
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    });
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);

    act(() => {
      useAnnotationStore.getState().addMask({ id: 'm9', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
      useAnnotationStore.setState({ selectedObjectId: 'm9' });
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    });
    expect(useAnnotationStore.getState().masks).toEqual([]);
  });

  it('Escape while typing a caption cancels ONLY the draft; Escape with a selection deselects; Ctrl+Z restores a mis-delete', () => {
    render();
    openPreflight();

    // Escape from inside an editable target must never reach cancelPendingShare
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).not.toHaveBeenCalled();
    input.remove();

    // With a selection, Escape deselects instead of abandoning the pre-flight
    act(() => {
      useAnnotationStore.getState().localApply([
        { t: 'add', obj: { id: 'note', kind: 'text', text: 'hi', color: '#ff0000', size: 0.05, x: 0.1, y: 0.1 } },
      ]);
      useAnnotationStore.setState({ selectedObjectId: 'note' });
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useAnnotationStore.getState().selectedObjectId).toBeNull();
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).not.toHaveBeenCalled();

    // A mis-deleted draft comes back with Ctrl+Z (the shortcut hook is
    // isEditing-gated and inert here)
    act(() => {
      useAnnotationStore.setState({ selectedObjectId: 'note' });
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    });
    expect(useAnnotationStore.getState().scene.objects).toEqual([]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    });
    expect(useAnnotationStore.getState().scene.objects).toHaveLength(1);

    // …and a BARE Escape still abandons the pre-flight
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).toHaveBeenCalledTimes(1);
  });

  it('a STRANDED own claim (sharerId === me, not sharing) does not hide the drafting tools', () => {
    voiceMock.useVoiceStore.setState({ screenSharingUserId: 'me' }); // our id, isScreenSharing false
    render();
    openPreflight();
    expect(modal()!.querySelector('[data-preflight-tool="text"]')).not.toBeNull();
    voiceMock.useVoiceStore.setState({ screenSharingUserId: null });
  });

  it('degrades to masks-only while ANOTHER user is live-sharing (their scene is not ours to draft in)', () => {
    voiceMock.useVoiceStore.setState({ screenSharingUserId: 'other-user' });
    render();
    openPreflight();
    expect(modal()!.querySelector('[data-preflight-tool="mask"]')).not.toBeNull();
    expect(modal()!.querySelector('[data-preflight-tool="text"]')).toBeNull();
    expect(modal()!.querySelector('[data-preflight-tool="image"]')).toBeNull();
    expect(modal()!.querySelector('[data-preflight-tool="eraser"]')).toBeNull();
    voiceMock.useVoiceStore.setState({ screenSharingUserId: null });
  });

  it('mask style picks set the default for the masks about to be drawn', () => {
    render();
    openPreflight();
    act(() => { (modal()!.querySelector('[data-preflight-style="pixelate"]') as HTMLButtonElement).click(); });
    expect(useAnnotationStore.getState().maskStyle).toBe('pixelate');
    useAnnotationStore.setState({ maskStyle: 'cover' });
  });
});
